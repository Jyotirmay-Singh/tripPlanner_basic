from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from database import db
from models.settlement import SettleIn, SettlementCreate, SettlementPatch
from utils.common import gen_id, now_utc
from utils.deps import (
    get_current_user,
    is_trip_admin,
    _trip_or_404,
    _settlement_mark_paid_or_403,
)
from utils.permissions import can_record_payment
from utils.balances import _compute_balances
from utils.settlement_gate import validate_new_amount
from services.push_notifications import enqueue_notification_event
from services.admin_audit import record_admin_action
from services.ledger_transactions import run_optional_transaction

router = APIRouter()


def _write_changed(result) -> bool:
    count = getattr(result, "modified_count", None)
    return count != 0 if isinstance(count, int) else True


def _balances_changed() -> HTTPException:
    return HTTPException(409, "Balances changed, please refresh and retry")


# ---------- Balances / Settle Up ----------
@router.get("/trips/{trip_id}/balances")
async def balances(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user)
    return await _compute_balances(trip_id, diagnostic=is_trip_admin(trip, user))


@router.post("/trips/{trip_id}/settle")
async def settle(trip_id: str, body: SettleIn, background_tasks: BackgroundTasks,
                 user=Depends(get_current_user)):
    # Legacy one-shot "record a completed payment". Kept for backward compatibility; the doc is
    # now stamped status:"paid"/paid_at so it offsets balances (unchanged behavior) and renders
    # in the Phase 10 settlement history. New clients use POST/PATCH /settlements instead.
    trip = await _trip_or_404(trip_id, user)
    amount, audit_fields = validate_new_amount(trip, body.amount)
    # Phase-20 parity: a completed payment offsets balances, so recording one is receiver-or-admin
    # only — a debtor must never be able to self-settle their own debt. Validate the roster too so
    # ghost ids can't poison the ledger (amount>0 is enforced by the SettleIn schema).
    if not can_record_payment(trip, body.to_member_id, user):
        raise HTTPException(403, "Only the receiver or a trip admin can record this settlement")
    if body.from_member_id == body.to_member_id:
        raise HTTPException(400, "A settlement cannot be from and to the same member")
    member_ids = {m["id"] for m in trip.get("members", [])}
    if body.from_member_id not in member_ids or body.to_member_id not in member_ids:
        raise HTTPException(400, "Both members must belong to this trip")
    ts = now_utc().isoformat()
    doc = {"id": gen_id(), "trip_id": trip_id,
           "from_member_id": body.from_member_id,
           "to_member_id": body.to_member_id,
           "amount": int(amount) if audit_fields else float(amount),
           "currency": trip.get("currency", "INR"),
           "status": "paid",
           "created_at": ts,
           "paid_at": ts,
           "recorded_by": user["id"],
           **audit_fields}
    async def transactional_write(session):
        guard = await db.trips.update_one(
            {"id": trip_id, "version": trip.get("version", 0)},
            {"$inc": {"version": 1}},
            session=session,
        )
        if not _write_changed(guard):
            raise _balances_changed()
        await db.settlements.insert_one(doc, session=session)

    async def standalone_write():
        # Preserve the historical standalone behavior; confirmation itself is disabled there.
        await db.settlements.insert_one(doc)

    await run_optional_transaction(transactional_write, standalone_write)
    doc.pop("_id", None)
    await record_admin_action(
        user, "settlement.recorded_paid", trip=trip, resource_type="settlement",
        resource_id=doc["id"],
        changed_fields=("from_member_id", "to_member_id", "amount", "status"),
    )
    await enqueue_notification_event(
        event_type="settlement.paid",
        source_id=doc["id"],
        trip_id=trip_id,
        actor_user_id=user["id"],
        background_tasks=background_tasks,
    )
    return doc


# ---------- Settlement history (Phase 10) ----------
@router.get("/trips/{trip_id}/settlements")
async def list_settlements(trip_id: str, user=Depends(get_current_user)):
    # Any trip member may view the history (pending + paid), newest first.
    await _trip_or_404(trip_id, user)
    return await db.settlements.find({"trip_id": trip_id}, {"_id": 0}) \
        .sort("created_at", -1).to_list(None)


@router.post("/trips/{trip_id}/settlements")
async def create_settlement(trip_id: str, body: SettlementCreate, user=Depends(get_current_user)):
    # Record a suggested transfer as a durable PENDING settlement (does not offset balances until
    # marked paid). Any trip member may record — it moves no money. Status is server-controlled.
    trip = await _trip_or_404(trip_id, user)
    amount, audit_fields = validate_new_amount(trip, body.amount)
    if body.from_member_id == body.to_member_id:
        raise HTTPException(400, "A settlement cannot be from and to the same member")
    member_ids = {m["id"] for m in trip.get("members", [])}
    if body.from_member_id not in member_ids or body.to_member_id not in member_ids:
        raise HTTPException(400, "Both members must belong to this trip")
    doc = {"id": gen_id(), "trip_id": trip_id,
           "from_member_id": body.from_member_id,
           "to_member_id": body.to_member_id,
           "amount": int(amount) if audit_fields else float(amount),
           "currency": trip.get("currency", "INR"),
           "status": "pending",
           "created_at": now_utc().isoformat(),
           "paid_at": None,
           "recorded_by": user["id"],
           "note": body.note,
           **audit_fields}
    await db.settlements.insert_one(doc)
    doc.pop("_id", None)
    await record_admin_action(
        user, "settlement.created", trip=trip, resource_type="settlement",
        resource_id=doc["id"],
        changed_fields=("from_member_id", "to_member_id", "amount", "status", "note"),
    )
    return doc


@router.patch("/trips/{trip_id}/settlements/{settlement_id}")
async def mark_settlement_paid(trip_id: str, settlement_id: str, body: SettlementPatch,
                               background_tasks: BackgroundTasks,
                               user=Depends(get_current_user)):
    # Flip pending -> paid (offsets balances). Gated to the lender (creditor's app user) or a trip
    # admin. Idempotent: a settlement already paid is returned unchanged.
    trip, settlement = await _settlement_mark_paid_or_403(trip_id, settlement_id, user)
    if settlement.get("status") == "paid":
        return settlement
    paid_at = now_utc().isoformat()
    updates = {"status": "paid", "paid_at": paid_at, "marked_paid_by": user["id"]}

    async def transactional_write(session):
        guard = await db.trips.update_one(
            {"id": trip_id, "version": trip.get("version", 0)},
            {"$inc": {"version": 1}},
            session=session,
        )
        if not _write_changed(guard):
            raise _balances_changed()
        await db.settlements.update_one(
            {"id": settlement_id, "trip_id": trip_id, "status": {"$ne": "paid"}},
            {"$set": updates},
            session=session,
        )

    async def standalone_write():
        await db.settlements.update_one(
            {"id": settlement_id, "trip_id": trip_id}, {"$set": updates}
        )

    await run_optional_transaction(transactional_write, standalone_write)
    settlement.update({"status": "paid", "paid_at": paid_at, "marked_paid_by": user["id"]})
    await record_admin_action(
        user, "settlement.marked_paid", trip=trip, resource_type="settlement",
        resource_id=settlement_id, changed_fields=("status", "paid_at", "marked_paid_by"),
    )
    await enqueue_notification_event(
        event_type="settlement.paid",
        source_id=settlement_id,
        trip_id=trip_id,
        actor_user_id=user["id"],
        background_tasks=background_tasks,
    )
    return settlement
