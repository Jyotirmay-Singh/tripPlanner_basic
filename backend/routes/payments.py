from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from database import db
from models.payment import (
    PaymentCreate,
    PaymentHandoffPreview,
    PaymentHandoffPreviewRequest,
    PaymentPatch,
    PaymentRecipientDetails,
)
from services.exchange_rates import (
    ExchangeRateError,
    create_quote,
    decimal_value,
)
from utils.common import gen_id, now_utc
from utils.deps import get_current_user, _trip_or_404, _payment_or_403, is_trip_admin
from utils.members import padded_family_member_ids
from utils.permissions import (
    can_initiate_upi_payment,
    can_record_payment,
    is_linked_to_member,
)
from utils.balances import _compute_balances
from utils.settlement_gate import (
    decimal_amount,
    payable_tolerance,
    validate_new_amount,
)
from services.push_notifications import enqueue_notification_event
from utils.currency_rules import currency_minor_units, quantize_currency
from services.admin_audit import record_admin_action
from services.ledger_transactions import (
    TransactionUnavailableError,
    run_optional_transaction,
    run_required_transaction,
)

router = APIRouter()


def _write_changed(result) -> bool:
    count = getattr(result, "modified_count", None)
    return count != 0 if isinstance(count, int) else True


def _balances_changed() -> HTTPException:
    return HTTPException(409, "Balances changed, please refresh and retry")


def _handoff_error(status_code: int, code: str, message: str, *, retryable: bool = False,
                   **context) -> HTTPException:
    return HTTPException(status_code, {
        "code": code,
        "message": message,
        "retryable": retryable,
        **context,
    })


def _money_string(value: object, currency: str) -> str:
    return format(quantize_currency(value, currency), "f")


def _aware_datetime(value: object):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _handoff_quote_projection(document: dict) -> dict:
    expires_at = _aware_datetime(document.get("expires_at"))
    return {
        "quote_id": document["id"],
        "rate": str(decimal_value(document["rate"])),
        "effective_rate_date": document.get("effective_rate_date"),
        "provider": document["provider"],
        "stale": bool(document.get("stale")),
        "expires_at": expires_at.isoformat() if expires_at else str(document.get("expires_at")),
    }

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


@router.post(
    "/trips/{trip_id}/payment-handoff/preview",
    response_model=PaymentHandoffPreview,
)
async def preview_payment_handoff(
    trip_id: str,
    body: PaymentHandoffPreviewRequest,
    user=Depends(get_current_user),
):
    """Create or revalidate a review-only quote for an external UPI app handoff.

    This endpoint deliberately performs no payment, settlement, trip-version, notification, audit,
    or ledger write. The only per-attempt document is the existing 30-minute exchange-rate quote.
    """

    trip = await _trip_or_404(trip_id, user)
    members_by_id = {member["id"]: member for member in trip.get("members", [])}
    payer = members_by_id.get(body.from_member_id)
    recipient = members_by_id.get(body.to_member_id)
    if payer is None or recipient is None:
        raise _handoff_error(404, "member_not_found", "Payer or recipient is no longer in this trip")
    if not can_initiate_upi_payment(trip, body.from_member_id, user):
        raise _handoff_error(
            403,
            "wrong_payer",
            "Only an account linked to the recommended payer can initiate this payment",
        )

    try:
        amount, _unused_audit_fields = validate_new_amount(trip, body.amount)
    except HTTPException as exc:
        if isinstance(exc.detail, dict):
            raise
        message = str(exc.detail)
        code = "whole_unit_required" if "whole" in message.lower() else "invalid_amount"
        raise _handoff_error(exc.status_code, code, message) from exc
    except ValueError as exc:
        raise _handoff_error(422, "invalid_amount", str(exc)) from exc

    balances = await _compute_balances(trip_id, diagnostic=False)
    payable = _suggested_amount(
        balances.get("transfers", []), body.from_member_id, body.to_member_id
    )
    currency = str(trip.get("currency") or "INR").upper()
    current_payable = _money_string(payable, currency)
    if payable <= 0:
        raise _handoff_error(
            409,
            "payment_pair_inactive",
            "This payment recommendation is no longer active or has been rerouted",
        )
    if amount > payable + payable_tolerance(trip):
        raise _handoff_error(
            409,
            "payable_changed",
            "The payable changed; review the latest amount before continuing",
            current_payable=current_payable,
            source_currency=currency,
        )

    handoff_context = {
        "trip_id": trip_id,
        "from_member_id": body.from_member_id,
        "to_member_id": body.to_member_id,
        "current_payable": current_payable,
    }

    if body.quote_id:
        quote_document = await db.exchange_rate_quotes.find_one(
            {"id": body.quote_id}, {"_id": 0}
        )
        if quote_document is None:
            raise _handoff_error(
                428,
                "quote_expired",
                "The reviewed conversion expired; review a new quote",
            )
        if quote_document.get("user_id") != user.get("id"):
            raise _handoff_error(
                403,
                "quote_not_owned",
                "This conversion quote belongs to another account",
            )
        expires_at = _aware_datetime(quote_document.get("expires_at"))
        if expires_at is None or expires_at <= now_utc():
            raise _handoff_error(
                428,
                "quote_expired",
                "The reviewed conversion expired; review a new quote",
            )

        stored_context = quote_document.get("payment_handoff")
        if not isinstance(stored_context, dict) or any(
            stored_context.get(key) != value
            for key, value in handoff_context.items()
            if key != "current_payable"
        ):
            raise _handoff_error(
                409,
                "quote_mismatch",
                "The reviewed quote does not belong to this payment direction",
            )
        if stored_context.get("current_payable") != current_payable:
            raise _handoff_error(
                409,
                "payable_changed",
                "The payable changed after review; approve the latest details",
                current_payable=current_payable,
                source_currency=currency,
            )
        try:
            quote_amount = decimal_value(quote_document.get("source_amount"))
        except Exception as exc:
            raise _handoff_error(409, "quote_mismatch", "The reviewed quote is invalid") from exc
        if (
            quote_document.get("mode") != "automatic"
            or quote_document.get("source_currency") != currency
            or quote_document.get("target_currency") != "INR"
            or quote_amount != amount
        ):
            raise _handoff_error(
                409,
                "quote_mismatch",
                "The reviewed amount or currency no longer matches this payment",
            )
        quote = _handoff_quote_projection(quote_document)
        inr_amount = _money_string(decimal_value(quote_document["target_amount"]), "INR")
    else:
        try:
            created_quote = await create_quote(
                user_id=user["id"],
                source_currency=currency,
                target_currency="INR",
                source_amount=format(amount, "f"),
                requested_date=None,
                mode="automatic",
                payment_handoff=handoff_context,
            )
        except ExchangeRateError as exc:
            raise _handoff_error(
                exc.status_code,
                "conversion_unavailable",
                str(exc),
                retryable=exc.retryable,
                conversion_code=exc.code,
            ) from exc
        except ValueError as exc:
            raise _handoff_error(422, "conversion_unavailable", str(exc)) from exc
        quote = {
            "quote_id": created_quote["quote_id"],
            "rate": created_quote["rate"],
            "effective_rate_date": created_quote.get("effective_rate_date"),
            "provider": created_quote["provider"],
            "stale": bool(created_quote.get("stale")),
            "expires_at": created_quote["expires_at"],
        }
        inr_amount = _money_string(created_quote["target_amount"], "INR")

    return {
        "trip_id": trip_id,
        "trip_name": trip.get("name") or "",
        "from_member_id": body.from_member_id,
        "from_name": payer.get("name") or "",
        "to_member_id": body.to_member_id,
        "to_name": recipient.get("name") or "",
        "source_amount": format(amount, "f"),
        "source_currency": currency,
        "current_payable": current_payable,
        "inr_amount": inr_amount,
        "quote": quote,
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
    async def transactional_write(session):
        guard = await db.trips.update_one(
            {"id": trip_id, "version": current_version},
            {"$inc": {"version": 1}},
            session=session,
        )
        if not _write_changed(guard):
            raise _balances_changed()
        await db.payments.insert_one(doc, session=session)

    async def standalone_write():
        guard = await db.trips.update_one(
            {"id": trip_id, "version": current_version}, {"$inc": {"version": 1}}
        )
        if not _write_changed(guard):
            raise _balances_changed()
        await db.payments.insert_one(doc)

    await run_optional_transaction(transactional_write, standalone_write)
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
        amount_changed = "amount" in updates

        async def update_payment(session=None):
            options = {"session": session} if session is not None else {}
            if amount_changed:
                guard = await db.trips.update_one(
                    {"id": trip_id, "version": current_version},
                    {"$inc": {"version": 1}},
                    **options,
                )
                if not _write_changed(guard):
                    raise _balances_changed()
            await db.payments.update_one(
                {"id": payment_id, "trip_id": trip_id}, {"$set": updates}, **options
            )

        if amount_changed:
            await run_optional_transaction(update_payment, update_payment)
        else:
            await update_payment()
        payment.update(updates)
        await record_admin_action(
            user, "payment.updated", trip=trip, resource_type="payment",
            resource_id=payment_id, changed_fields=updates.keys(),
        )
    return payment


@router.delete("/trips/{trip_id}/payments/{payment_id}")
async def delete_payment(trip_id: str, payment_id: str, user=Depends(get_current_user)):
    # Delete a recorded payment (balances self-heal on the next recompute). Receiver-or-admin only.
    trip, payment = await _payment_or_403(trip_id, payment_id, user)

    if payment.get("payment_attempt_id"):
        attempt_id = payment["payment_attempt_id"]

        async def void_confirmed_payment(session):
            current_trip = await db.trips.find_one(
                {"id": trip_id}, {"_id": 0}, session=session
            )
            current_payment = await db.payments.find_one(
                {"id": payment_id, "trip_id": trip_id}, {"_id": 0}, session=session
            )
            if not current_trip or not current_payment:
                raise HTTPException(404, "Payment not found")
            guard = await db.trips.update_one(
                {"id": trip_id, "version": current_trip.get("version", 0)},
                {"$inc": {"version": 1}},
                session=session,
            )
            if not _write_changed(guard):
                raise _balances_changed()
            await db.payments.delete_one(
                {"id": payment_id, "trip_id": trip_id}, session=session
            )
            timestamp = now_utc().isoformat()
            changed = await db.payment_attempts.update_one(
                {
                    "id": attempt_id,
                    "trip_id": trip_id,
                    "linked_payment_id": payment_id,
                    "status": "settled_recipient_confirmed",
                },
                {"$set": {
                    "status": "voided",
                    "reason": "linked_payment_deleted",
                    "voided_by": user["id"],
                    "voided_at": timestamp,
                    "updated_at": timestamp,
                }, "$unset": {"active_key": ""}},
                session=session,
            )
            if not _write_changed(changed):
                raise HTTPException(409, "The linked UPI confirmation changed; refresh and retry")

        try:
            await run_required_transaction(void_confirmed_payment)
        except TransactionUnavailableError as exc:
            raise _handoff_error(
                503,
                "payment_void_unavailable",
                "This confirmed UPI payment cannot be removed safely right now. Try again.",
                retryable=True,
            ) from exc
    else:
        async def transactional_delete(session):
            guard = await db.trips.update_one(
                {"id": trip_id, "version": trip.get("version", 0)},
                {"$inc": {"version": 1}},
                session=session,
            )
            if not _write_changed(guard):
                raise _balances_changed()
            await db.payments.delete_one(
                {"id": payment_id, "trip_id": trip_id}, session=session
            )

        async def standalone_delete():
            guard = await db.trips.update_one(
                {"id": trip_id, "version": trip.get("version", 0)},
                {"$inc": {"version": 1}},
            )
            if not _write_changed(guard):
                raise _balances_changed()
            await db.payments.delete_one({"id": payment_id, "trip_id": trip_id})

        await run_optional_transaction(transactional_delete, standalone_delete)
    await record_admin_action(
        user, "payment.deleted", trip=trip, resource_type="payment", resource_id=payment_id,
    )
    return {"ok": True}
