from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from database import db
from models.payment import PaymentCreate, PaymentPatch
from utils.common import gen_id, now_utc
from utils.deps import get_current_user, _trip_or_404, _payment_or_403, is_trip_admin
from utils.permissions import can_record_payment
from utils.balances import _compute_balances
from utils.settlement_gate import (
    decimal_amount,
    payable_tolerance,
    validate_new_amount,
)
from services.push_notifications import enqueue_notification_event

router = APIRouter()

def _suggested_amount(transfers: list, from_id: str, to_id: str):
    """Current backend-recommended payable for one direction (zero when it was rerouted)."""
    for t in transfers:
        if t["from_member_id"] == from_id and t["to_member_id"] == to_id:
            return decimal_amount(t["amount"])
    return decimal_amount(0)


# ---------- Partial Payments (Phase 20) ----------
@router.get("/trips/{trip_id}/payments")
async def list_payments(trip_id: str, user=Depends(get_current_user)):
    # Any trip member may view the payment log (everyone sees badges + logs), newest first.
    await _trip_or_404(trip_id, user["id"])
    return await db.payments.find({"trip_id": trip_id}, {"_id": 0}) \
        .sort("created_at", -1).to_list(None)


@router.post("/trips/{trip_id}/payments")
async def record_payment(trip_id: str, body: PaymentCreate, background_tasks: BackgroundTasks,
                         user=Depends(get_current_user)):
    # Record a (possibly partial) payment along a CURRENTLY SUGGESTED debtor->creditor pair. The
    # receiver (creditor's app user) or a trip admin may record; the payer never self-records.
    trip = await _trip_or_404(trip_id, user["id"])
    current_version = trip.get("version", 0)
    if not can_record_payment(trip, body.to_member_id, user["id"]):
        raise HTTPException(403, "Only the receiver or a trip admin can record this payment")
    amount, audit_fields = validate_new_amount(trip, body.amount)
    if body.from_member_id == body.to_member_id:
        raise HTTPException(400, "A payment cannot be from and to the same member")
    member_ids = {m["id"] for m in trip.get("members", [])}
    if body.from_member_id not in member_ids or body.to_member_id not in member_ids:
        raise HTTPException(400, "Both members must belong to this trip")

    # Recommendations already include prior payments and may be rerouted after any ledger change.
    bal = await _compute_balances(trip_id, diagnostic=is_trip_admin(trip, user["id"]))
    payable = _suggested_amount(bal["transfers"], body.from_member_id, body.to_member_id)
    tolerance = payable_tolerance(trip)
    if payable <= 0:
        raise HTTPException(400, "You can only record a payment along a currently suggested transfer")
    if amount > payable + tolerance:
        raise HTTPException(400, f"Amount exceeds the {round(payable, 2)} payable for this pair")

    doc = {"id": gen_id(), "trip_id": trip_id,
           "from_member_id": body.from_member_id,
           "to_member_id": body.to_member_id,
           "amount": int(amount) if audit_fields else float(amount),
           "currency": trip.get("currency", "INR"),
           "created_at": now_utc().isoformat(),
           "recorded_by": user["id"],
           "note": body.note,
           **audit_fields}
    # Optimistic-concurrency guard (BUG-2): serialize payment writes for this trip so two concurrent
    # recorders can't both read the same payable and over-settle. Bump the trip version under the
    # value we validated against; if it moved, the balance changed under us -> 409 (client refreshes).
    guard = await db.trips.update_one(
        {"id": trip_id, "version": current_version}, {"$inc": {"version": 1}})
    if guard.modified_count == 0:
        raise HTTPException(409, "Balances changed, please refresh and retry")
    await db.payments.insert_one(doc)
    doc.pop("_id", None)
    await enqueue_notification_event(
        event_type="payment.recorded",
        source_id=doc["id"],
        trip_id=trip_id,
        actor_user_id=user["id"],
        background_tasks=background_tasks,
    )
    return doc


@router.patch("/trips/{trip_id}/payments/{payment_id}")
async def edit_payment(trip_id: str, payment_id: str, body: PaymentPatch,
                       user=Depends(get_current_user)):
    # Edit amount/note (direction fixed). Receiver-or-admin only. A new amount may not over-settle the
    # direction: cap = current pair payable + this payment's own effect (i.e. the payable as if this
    # payment didn't exist), so create and edit share one rule.
    trip, payment = await _payment_or_403(trip_id, payment_id, user["id"])
    current_version = trip.get("version", 0)
    updates: dict = {}
    if body.amount is not None:
        requested = decimal_amount(body.amount)
        existing = decimal_amount(payment["amount"])
        # Older clients resend the current amount on every note edit. Treat an exactly unchanged
        # value as no amount edit so legacy decimal records remain note-editable after rollout.
        if requested != existing:
            amount, audit_fields = validate_new_amount(trip, requested)
            bal = await _compute_balances(trip_id, diagnostic=is_trip_admin(trip, user["id"]))
            residual = _suggested_amount(bal["transfers"],
                                         payment["from_member_id"], payment["to_member_id"])
            cap = residual + existing
            if amount > cap + payable_tolerance(trip):
                raise HTTPException(400, f"Amount exceeds the {round(cap, 2)} payable for this pair")
            updates["amount"] = int(amount) if audit_fields else float(amount)
            updates.update(audit_fields)
    if body.note is not None:
        updates["note"] = body.note
    if updates:
        # An amount change has the same over-settle risk as recording, so guard it against concurrent
        # writes; a note-only edit doesn't touch balances and needs no guard.
        if body.amount is not None:
            guard = await db.trips.update_one(
                {"id": trip_id, "version": current_version}, {"$inc": {"version": 1}})
            if guard.modified_count == 0:
                raise HTTPException(409, "Balances changed, please refresh and retry")
        await db.payments.update_one({"id": payment_id, "trip_id": trip_id}, {"$set": updates})
        payment.update(updates)
    return payment


@router.delete("/trips/{trip_id}/payments/{payment_id}")
async def delete_payment(trip_id: str, payment_id: str, user=Depends(get_current_user)):
    # Delete a recorded payment (balances self-heal on the next recompute). Receiver-or-admin only.
    trip, _payment = await _payment_or_403(trip_id, payment_id, user["id"])
    guard = await db.trips.update_one(
        {"id": trip_id, "version": trip.get("version", 0)}, {"$inc": {"version": 1}}
    )
    if guard.modified_count == 0:
        raise HTTPException(409, "Balances changed, please refresh and retry")
    await db.payments.delete_one({"id": payment_id, "trip_id": trip_id})
    return {"ok": True}
