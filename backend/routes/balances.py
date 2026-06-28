from fastapi import APIRouter, Depends, HTTPException

from database import db
from models.settlement import SettleIn, SettlementCreate, SettlementPatch
from utils.common import gen_id, now_utc
from utils.deps import (
    get_current_user,
    _trip_or_404,
    _settlement_mark_paid_or_403,
)
from utils.balances import _compute_balances

router = APIRouter()


# ---------- Balances / Settle Up ----------
@router.get("/trips/{trip_id}/balances")
async def balances(trip_id: str, user=Depends(get_current_user)):
    await _trip_or_404(trip_id, user["id"])
    return await _compute_balances(trip_id)


@router.post("/trips/{trip_id}/settle")
async def settle(trip_id: str, body: SettleIn, user=Depends(get_current_user)):
    # Legacy one-shot "record a completed payment". Kept for backward compatibility; the doc is
    # now stamped status:"paid"/paid_at so it offsets balances (unchanged behavior) and renders
    # in the Phase 10 settlement history. New clients use POST/PATCH /settlements instead.
    await _trip_or_404(trip_id, user["id"])
    ts = now_utc().isoformat()
    doc = {"id": gen_id(), "trip_id": trip_id,
           "from_member_id": body.from_member_id,
           "to_member_id": body.to_member_id,
           "amount": float(body.amount),
           "status": "paid",
           "created_at": ts,
           "paid_at": ts,
           "recorded_by": user["id"]}
    await db.settlements.insert_one(doc)
    doc.pop("_id", None)
    return doc


# ---------- Settlement history (Phase 10) ----------
@router.get("/trips/{trip_id}/settlements")
async def list_settlements(trip_id: str, user=Depends(get_current_user)):
    # Any trip member may view the history (pending + paid), newest first.
    await _trip_or_404(trip_id, user["id"])
    return await db.settlements.find({"trip_id": trip_id}, {"_id": 0}) \
        .sort("created_at", -1).to_list(5000)


@router.post("/trips/{trip_id}/settlements")
async def create_settlement(trip_id: str, body: SettlementCreate, user=Depends(get_current_user)):
    # Record a suggested transfer as a durable PENDING settlement (does not offset balances until
    # marked paid). Any trip member may record — it moves no money. Status is server-controlled.
    trip = await _trip_or_404(trip_id, user["id"])
    if body.amount <= 0:
        raise HTTPException(400, "Amount must be greater than zero")
    if body.from_member_id == body.to_member_id:
        raise HTTPException(400, "A settlement cannot be from and to the same member")
    member_ids = {m["id"] for m in trip.get("members", [])}
    if body.from_member_id not in member_ids or body.to_member_id not in member_ids:
        raise HTTPException(400, "Both members must belong to this trip")
    doc = {"id": gen_id(), "trip_id": trip_id,
           "from_member_id": body.from_member_id,
           "to_member_id": body.to_member_id,
           "amount": float(body.amount),
           "status": "pending",
           "created_at": now_utc().isoformat(),
           "paid_at": None,
           "recorded_by": user["id"],
           "note": body.note}
    await db.settlements.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.patch("/trips/{trip_id}/settlements/{settlement_id}")
async def mark_settlement_paid(trip_id: str, settlement_id: str, body: SettlementPatch,
                               user=Depends(get_current_user)):
    # Flip pending -> paid (offsets balances). Gated to the lender (creditor's app user) or a trip
    # admin. Idempotent: a settlement already paid is returned unchanged.
    _trip, settlement = await _settlement_mark_paid_or_403(trip_id, settlement_id, user["id"])
    if settlement.get("status") == "paid":
        return settlement
    paid_at = now_utc().isoformat()
    await db.settlements.update_one(
        {"id": settlement_id, "trip_id": trip_id},
        {"$set": {"status": "paid", "paid_at": paid_at, "marked_paid_by": user["id"]}},
    )
    settlement.update({"status": "paid", "paid_at": paid_at, "marked_paid_by": user["id"]})
    return settlement
