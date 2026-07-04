from fastapi import APIRouter, Depends, HTTPException

from database import db
from models.payment import PaymentCreate, PaymentPatch
from utils.common import gen_id, now_utc
from utils.deps import get_current_user, _trip_or_404, _payment_or_403
from utils.permissions import can_record_payment
from utils.balances import _compute_balances

router = APIRouter()

_EPS = 0.01


def _suggested_amount(transfers: list, from_id: str, to_id: str) -> float:
    """Current greedy payable for the exact debtor->creditor direction (0.0 if not suggested)."""
    for t in transfers:
        if t["from_member_id"] == from_id and t["to_member_id"] == to_id:
            return float(t["amount"])
    return 0.0


# ---------- Partial Payments (Phase 20) ----------
@router.get("/trips/{trip_id}/payments")
async def list_payments(trip_id: str, user=Depends(get_current_user)):
    # Any trip member may view the payment log (everyone sees badges + logs), newest first.
    await _trip_or_404(trip_id, user["id"])
    return await db.payments.find({"trip_id": trip_id}, {"_id": 0}) \
        .sort("created_at", -1).to_list(5000)


@router.post("/trips/{trip_id}/payments")
async def record_payment(trip_id: str, body: PaymentCreate, user=Depends(get_current_user)):
    # Record a (possibly partial) payment along a CURRENTLY SUGGESTED debtor->creditor pair. The
    # receiver (creditor's app user) or a trip admin may record; the payer never self-records.
    trip = await _trip_or_404(trip_id, user["id"])
    if not can_record_payment(trip, body.to_member_id, user["id"]):
        raise HTTPException(403, "Only the receiver or a trip admin can record this payment")
    if body.amount <= 0:
        raise HTTPException(400, "Amount must be greater than zero")
    if body.from_member_id == body.to_member_id:
        raise HTTPException(400, "A payment cannot be from and to the same member")
    member_ids = {m["id"] for m in trip.get("members", [])}
    if body.from_member_id not in member_ids or body.to_member_id not in member_ids:
        raise HTTPException(400, "Both members must belong to this trip")

    # The current payable for this pair is the greedy suggestion (already net of prior payments).
    bal = await _compute_balances(trip_id)
    payable = _suggested_amount(bal["transfers"], body.from_member_id, body.to_member_id)
    if payable <= _EPS:
        raise HTTPException(400, "You can only record a payment along a currently suggested transfer")
    if body.amount > payable + _EPS:
        raise HTTPException(400, f"Amount exceeds the {round(payable, 2)} payable for this pair")

    doc = {"id": gen_id(), "trip_id": trip_id,
           "from_member_id": body.from_member_id,
           "to_member_id": body.to_member_id,
           "amount": float(body.amount),
           "currency": trip.get("currency", "INR"),
           "created_at": now_utc().isoformat(),
           "recorded_by": user["id"],
           "note": body.note}
    await db.payments.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.patch("/trips/{trip_id}/payments/{payment_id}")
async def edit_payment(trip_id: str, payment_id: str, body: PaymentPatch,
                       user=Depends(get_current_user)):
    # Edit amount/note (direction fixed). Receiver-or-admin only. A new amount may not over-settle the
    # direction: cap = current pair payable + this payment's own effect (i.e. the payable as if this
    # payment didn't exist), so create and edit share one rule.
    trip, payment = await _payment_or_403(trip_id, payment_id, user["id"])
    updates: dict = {}
    if body.amount is not None:
        if body.amount <= 0:
            raise HTTPException(400, "Amount must be greater than zero")
        bal = await _compute_balances(trip_id)
        residual = _suggested_amount(bal["transfers"],
                                     payment["from_member_id"], payment["to_member_id"])
        cap = residual + float(payment["amount"])
        if body.amount > cap + _EPS:
            raise HTTPException(400, f"Amount exceeds the {round(cap, 2)} payable for this pair")
        updates["amount"] = float(body.amount)
    if body.note is not None:
        updates["note"] = body.note
    if updates:
        await db.payments.update_one({"id": payment_id, "trip_id": trip_id}, {"$set": updates})
        payment.update(updates)
    return payment


@router.delete("/trips/{trip_id}/payments/{payment_id}")
async def delete_payment(trip_id: str, payment_id: str, user=Depends(get_current_user)):
    # Delete a recorded payment (balances self-heal on the next recompute). Receiver-or-admin only.
    await _payment_or_403(trip_id, payment_id, user["id"])
    await db.payments.delete_one({"id": payment_id, "trip_id": trip_id})
    return {"ok": True}
