from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from database import db
from models.payment import PaymentCreate, PaymentPatch, PaymentRecipientDetails
from utils.common import gen_id, now_utc
from utils.deps import get_current_user, _trip_or_404, _payment_or_403, is_trip_admin
from utils.members import padded_family_member_ids
from utils.permissions import can_record_payment, is_linked_to_member
from utils.balances import _compute_balances
from utils.settlement_gate import (
    decimal_amount,
    payable_tolerance,
    validate_new_amount,
)
from services.push_notifications import enqueue_notification_event
from utils.currency_rules import currency_minor_units
from services.admin_audit import record_admin_action

router = APIRouter()

def _suggested_amount(transfers: list, from_id: str, to_id: str):
    """Current backend-recommended payable for one direction (zero when it was rerouted)."""
    for t in transfers:
        if t["from_member_id"] == from_id and t["to_member_id"] == to_id:
            return decimal_amount(t["amount"])
    return decimal_amount(0)


async def _recipient_candidates(recipient: dict) -> list[dict]:
    """Resolve roster people to the minimum payment-profile projection needed by the client."""
    if recipient.get("kind") == "family":
        names = recipient.get("family_members") or []
        person_ids = padded_family_member_ids(recipient)
        linked_user_ids = recipient.get("family_member_user_ids") or []
        roster = [
            {
                "person_id": person_ids[index],
                "name": name,
                "family_id": recipient["id"],
                "family_name": recipient.get("name"),
                "linked_user_id": linked_user_ids[index]
                if index < len(linked_user_ids) else None,
            }
            for index, name in enumerate(names)
        ]
    else:
        roster = [{
            "person_id": recipient["id"],
            "name": recipient.get("name") or "",
            "family_id": None,
            "family_name": None,
            "linked_user_id": recipient.get("user_id"),
        }]

    user_ids = list(dict.fromkeys(
        person["linked_user_id"] for person in roster if person["linked_user_id"]
    ))
    profiles_by_id: dict[str, dict] = {}
    if user_ids:
        profiles = await db.users.find(
            {"id": {"$in": user_ids}},
            {"_id": 0, "id": 1, "upi_id": 1, "upi_updated_at": 1},
        ).to_list(None)
        profiles_by_id = {profile["id"]: profile for profile in profiles}

    return [
        {
            "person_id": person["person_id"],
            "name": person["name"],
            "family_id": person["family_id"],
            "family_name": person["family_name"],
            "account_linked": person["linked_user_id"] in profiles_by_id,
            "upi_id": profiles_by_id.get(person["linked_user_id"], {}).get("upi_id"),
            "upi_updated_at": profiles_by_id.get(
                person["linked_user_id"], {}
            ).get("upi_updated_at"),
        }
        for person in roster
    ]


@router.get(
    "/trips/{trip_id}/payment-recipient-details",
    response_model=PaymentRecipientDetails,
)
async def payment_recipient_details(
    trip_id: str,
    from_member_id: str,
    to_member_id: str,
    user=Depends(get_current_user),
):
    """Return fresh UPI details only for an active recommended payer/recipient pair."""
    trip = await _trip_or_404(trip_id, user)
    members_by_id = {member["id"]: member for member in trip.get("members", [])}
    payer = members_by_id.get(from_member_id)
    recipient = members_by_id.get(to_member_id)
    if payer is None or recipient is None:
        raise HTTPException(404, "Member not found")

    if not is_trip_admin(trip, user) and not is_linked_to_member(payer, user):
        raise HTTPException(403, "Only the payer or a trip admin can view payment details")

    balances = await _compute_balances(trip_id, diagnostic=is_trip_admin(trip, user))
    active = any(
        transfer.get("from_member_id") == from_member_id
        and transfer.get("to_member_id") == to_member_id
        for transfer in balances.get("transfers", [])
    )
    if not active:
        raise HTTPException(409, "This settlement recommendation is no longer active")

    return {
        "trip_id": trip_id,
        "from_member_id": from_member_id,
        "to_member_id": to_member_id,
        "recipients": await _recipient_candidates(recipient),
    }


# ---------- Partial Payments (Phase 20) ----------
@router.get("/trips/{trip_id}/payments")
async def list_payments(trip_id: str, user=Depends(get_current_user)):
    # Any trip member may view the payment log (everyone sees badges + logs), newest first.
    await _trip_or_404(trip_id, user)
    return await db.payments.find({"trip_id": trip_id}, {"_id": 0}) \
        .sort("created_at", -1).to_list(None)


@router.post("/trips/{trip_id}/payments")
async def record_payment(trip_id: str, body: PaymentCreate, background_tasks: BackgroundTasks,
                         user=Depends(get_current_user)):
    # Record a (possibly partial) payment along a CURRENTLY SUGGESTED debtor->creditor pair. The
    # receiver (creditor's app user) or a trip admin may record; the payer never self-records.
    trip = await _trip_or_404(trip_id, user)
    current_version = trip.get("version", 0)
    if not can_record_payment(trip, body.to_member_id, user):
        raise HTTPException(403, "Only the receiver or a trip admin can record this payment")
    amount, audit_fields = validate_new_amount(trip, body.amount)
    if body.from_member_id == body.to_member_id:
        raise HTTPException(400, "A payment cannot be from and to the same member")
    member_ids = {m["id"] for m in trip.get("members", [])}
    if body.from_member_id not in member_ids or body.to_member_id not in member_ids:
        raise HTTPException(400, "Both members must belong to this trip")

    # Recommendations already include prior payments and may be rerouted after any ledger change.
    bal = await _compute_balances(trip_id, diagnostic=is_trip_admin(trip, user))
    payable = _suggested_amount(bal["transfers"], body.from_member_id, body.to_member_id)
    tolerance = payable_tolerance(trip)
    if payable <= 0:
        raise HTTPException(400, "You can only record a payment along a currently suggested transfer")
    if amount > payable + tolerance:
        digits = currency_minor_units(trip.get("currency", "INR"))
        raise HTTPException(400, f"Amount exceeds the {payable:.{digits}f} payable for this pair")

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
    await record_admin_action(
        user, "payment.created", trip=trip, resource_type="payment", resource_id=doc["id"],
        changed_fields=("from_member_id", "to_member_id", "amount", "note"),
    )
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
    trip, payment = await _payment_or_403(trip_id, payment_id, user)
    current_version = trip.get("version", 0)
    updates: dict = {}
    if body.amount is not None:
        requested = decimal_amount(body.amount)
        existing = decimal_amount(payment["amount"])
        # Older clients resend the current amount on every note edit. Treat an exactly unchanged
        # value as no amount edit so legacy decimal records remain note-editable after rollout.
        if requested != existing:
            amount, audit_fields = validate_new_amount(trip, requested)
            bal = await _compute_balances(trip_id, diagnostic=is_trip_admin(trip, user))
            residual = _suggested_amount(bal["transfers"],
                                         payment["from_member_id"], payment["to_member_id"])
            cap = residual + existing
            if amount > cap + payable_tolerance(trip):
                digits = currency_minor_units(trip.get("currency", "INR"))
                raise HTTPException(400, f"Amount exceeds the {cap:.{digits}f} payable for this pair")
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
        await record_admin_action(
            user, "payment.updated", trip=trip, resource_type="payment",
            resource_id=payment_id, changed_fields=updates.keys(),
        )
    return payment


@router.delete("/trips/{trip_id}/payments/{payment_id}")
async def delete_payment(trip_id: str, payment_id: str, user=Depends(get_current_user)):
    # Delete a recorded payment (balances self-heal on the next recompute). Receiver-or-admin only.
    trip, _payment = await _payment_or_403(trip_id, payment_id, user)
    guard = await db.trips.update_one(
        {"id": trip_id, "version": trip.get("version", 0)}, {"$inc": {"version": 1}}
    )
    if guard.modified_count == 0:
        raise HTTPException(409, "Balances changed, please refresh and retry")
    await db.payments.delete_one({"id": payment_id, "trip_id": trip_id})
    await record_admin_action(
        user, "payment.deleted", trip=trip, resource_type="payment", resource_id=payment_id,
    )
    return {"ok": True}
