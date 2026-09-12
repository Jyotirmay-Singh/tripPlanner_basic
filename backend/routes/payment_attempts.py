from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pymongo.errors import DuplicateKeyError

from database import db
from models.payment_attempt import (
    PaymentAttemptCreate,
    PaymentAttemptRecipientPatch,
    PaymentAttemptSenderPatch,
)
from services.exchange_rates import decimal_value
from services.ledger_transactions import (
    TransactionUnavailableError,
    is_retryable_transaction_error,
    run_required_transaction,
)
from services.payment_attempts import (
    PAYMENT_ATTEMPT_LIFETIME,
    expire_payment_attempts,
)
from services.push_notifications import enqueue_notification_event
from utils.balances import _compute_balances
from utils.common import gen_id, now_utc
from utils.currency_rules import quantize_currency
from utils.deps import _trip_or_404, get_current_user, is_trip_admin
from utils.members import padded_family_member_ids
from utils.permissions import can_initiate_upi_payment, can_record_payment
from utils.settlement_gate import decimal_amount, payable_tolerance, validate_new_amount
from utils.upi_rules import normalize_upi_id


router = APIRouter()


class _ConcurrentLedgerChange(RuntimeError):
    pass


def _error(
    status_code: int,
    code: str,
    message: str,
    *,
    retryable: bool = False,
    **context,
) -> HTTPException:
    return HTTPException(status_code, {
        "code": code,
        "message": message,
        "retryable": retryable,
        **context,
    })


def _aware_datetime(value: object) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _active_key(trip_id: str, from_member_id: str, to_member_id: str) -> str:
    return f"{trip_id}:{from_member_id}:{to_member_id}"


def _suggested_amount(transfers: list, from_id: str, to_id: str) -> Decimal:
    for transfer in transfers:
        if (
            transfer.get("from_member_id") == from_id
            and transfer.get("to_member_id") == to_id
        ):
            return decimal_amount(transfer.get("amount", 0))
    return Decimal("0")


def _money_string(value: object, currency: str) -> str:
    return format(quantize_currency(value, currency), "f")


def _ledger_number(value: Decimal, audit_fields: dict) -> int | float:
    return int(value) if audit_fields else float(value)


def _changed(result: object) -> bool:
    count = getattr(result, "modified_count", None)
    return count != 0 if isinstance(count, int) else True


def _response(document: dict, *, redact_sender_private: bool = False) -> dict:
    result = {
        key: value
        for key, value in document.items()
        if key not in {"_id", "active_key"}
    }
    if redact_sender_private:
        # A different account linked to the same family payer may discover the direction lock by
        # trying to create an attempt, but it is not the initiating payer and must not receive that
        # payer's optional private reference. Recipient/admin list access remains unchanged.
        result["transaction_reference"] = None
    expires_at = _aware_datetime(result.get("expires_at"))
    if expires_at is not None:
        result["expires_at"] = expires_at.isoformat()
    paise = int(result.get("amount_paise") or 0)
    result["inr_amount"] = f"{paise // 100}.{paise % 100:02d}"
    return result


def _creditor_people(member: dict) -> list[dict]:
    if member.get("kind") != "family":
        return [{
            "person_id": member.get("id"),
            "person_name": member.get("name") or "",
            "family_id": None,
            "family_name": None,
            "linked_user_id": member.get("user_id"),
        }]

    names = member.get("family_members") or []
    person_ids = padded_family_member_ids(member)
    linked_user_ids = member.get("family_member_user_ids") or []
    return [
        {
            "person_id": person_ids[index],
            "person_name": name,
            "family_id": member.get("id"),
            "family_name": member.get("name") or "",
            "linked_user_id": linked_user_ids[index] if index < len(linked_user_ids) else None,
        }
        for index, name in enumerate(names)
    ]


async def _selected_recipient(member: dict, person_id: str) -> dict:
    person = next(
        (candidate for candidate in _creditor_people(member)
         if candidate["person_id"] == person_id),
        None,
    )
    if person is None:
        raise _error(
            409,
            "recipient_changed",
            "The selected recipient is no longer part of this payment destination",
        )
    linked_user_id = person.get("linked_user_id")
    if not linked_user_id:
        raise _error(
            409,
            "recipient_unavailable",
            "The selected recipient no longer has a linked account",
        )
    profile = await db.users.find_one(
        {"id": linked_user_id},
        {"_id": 0, "id": 1, "name": 1, "upi_id": 1, "upi_updated_at": 1},
    )
    if not profile:
        raise _error(
            409,
            "recipient_unavailable",
            "The selected recipient no longer has a linked account",
        )
    try:
        upi_id = normalize_upi_id(profile.get("upi_id"))
    except (TypeError, ValueError) as exc:
        raise _error(
            409,
            "recipient_upi_unavailable",
            "The selected recipient no longer has a valid UPI ID",
        ) from exc
    return {
        **person,
        "linked_user_id": profile["id"],
        "linked_user_name": profile.get("name") or person["person_name"],
        "upi_id": upi_id,
        "upi_updated_at": profile.get("upi_updated_at"),
    }


async def _safe_enqueue(**kwargs) -> None:
    try:
        await enqueue_notification_event(**kwargs)
    except Exception:
        # Push is strictly best effort. The persisted attempt is the in-app source of truth.
        return


async def _attempt_or_404(trip_id: str, attempt_id: str) -> dict:
    attempt = await db.payment_attempts.find_one(
        {"id": attempt_id, "trip_id": trip_id}, {"_id": 0}
    )
    if not attempt:
        raise HTTPException(404, "Payment attempt not found")
    return attempt


@router.post("/trips/{trip_id}/payment-attempts")
async def create_payment_attempt(
    trip_id: str,
    body: PaymentAttemptCreate,
    user=Depends(get_current_user),
):
    """Persist an immutable UPI handoff snapshot before any clipboard or app action."""

    trip = await _trip_or_404(trip_id, user)
    await expire_payment_attempts(trip_id)

    # quote_id is the idempotency key. Once accepted, retries return the immutable snapshot even if
    # the short-lived exchange quote has since expired.
    existing = await db.payment_attempts.find_one({"quote_id": body.quote_id}, {"_id": 0})
    if existing:
        if (
            existing.get("trip_id") == trip_id
            and existing.get("initiating_payer_user_id") == user.get("id")
        ):
            return _response(existing)
        raise _error(409, "quote_already_used", "This payment quote was already used")

    quote = await db.exchange_rate_quotes.find_one({"id": body.quote_id}, {"_id": 0})
    if not quote:
        raise _error(428, "quote_expired", "The reviewed conversion expired; review a new quote")
    if quote.get("user_id") != user.get("id"):
        raise _error(403, "quote_not_owned", "This conversion quote belongs to another account")
    quote_expires_at = _aware_datetime(quote.get("expires_at"))
    if quote_expires_at is None or quote_expires_at <= now_utc():
        raise _error(428, "quote_expired", "The reviewed conversion expired; review a new quote")

    context = quote.get("payment_handoff")
    if not isinstance(context, dict) or context.get("trip_id") != trip_id:
        raise _error(409, "quote_mismatch", "The reviewed quote is not for this trip")
    from_member_id = context.get("from_member_id")
    to_member_id = context.get("to_member_id")
    members = {member.get("id"): member for member in trip.get("members", [])}
    payer = members.get(from_member_id)
    creditor = members.get(to_member_id)
    if not payer or not creditor:
        raise _error(409, "member_changed", "The payer or recipient is no longer in this trip")
    if not can_initiate_upi_payment(trip, from_member_id, user):
        raise _error(
            403,
            "wrong_payer",
            "Only an account linked to the recommended payer can initiate this payment",
        )

    currency = str(trip.get("currency") or "INR").upper()
    try:
        source_amount, _source_audit = validate_new_amount(trip, quote.get("source_amount"))
        target_amount = decimal_value(quote.get("target_amount"))
        rate = decimal_value(quote.get("rate"))
    except (HTTPException, TypeError, ValueError) as exc:
        if isinstance(exc, HTTPException):
            raise
        raise _error(409, "quote_mismatch", "The reviewed quote contains invalid amounts") from exc
    if (
        quote.get("mode") != "automatic"
        or quote.get("source_currency") != currency
        or quote.get("target_currency") != "INR"
        or target_amount <= 0
        or rate <= 0
    ):
        raise _error(409, "quote_mismatch", "The reviewed quote contains different payment details")
    inr_amount = quantize_currency(target_amount, "INR")
    if target_amount != inr_amount:
        raise _error(409, "quote_mismatch", "The reviewed INR amount is not exact to paise")

    balances = await _compute_balances(trip_id, diagnostic=False)
    payable = _suggested_amount(balances.get("transfers", []), from_member_id, to_member_id)
    current_payable_snapshot = context.get("current_payable")
    try:
        reviewed_payable = decimal_amount(current_payable_snapshot)
    except HTTPException as exc:
        raise _error(409, "quote_mismatch", "The reviewed payable is invalid") from exc
    if payable <= 0 or reviewed_payable != payable:
        raise _error(
            409,
            "payable_changed",
            "The payable changed after review; approve the latest details",
            current_payable=_money_string(payable, currency),
            source_currency=currency,
        )
    if source_amount > payable + payable_tolerance(trip):
        raise _error(
            409,
            "payable_changed",
            "The payable changed after review; approve the latest details",
            current_payable=_money_string(payable, currency),
            source_currency=currency,
        )

    recipient = await _selected_recipient(creditor, body.recipient_person_id)
    key = _active_key(trip_id, from_member_id, to_member_id)
    active = await db.payment_attempts.find_one({"active_key": key}, {"_id": 0})
    if active:
        return _response(
            active,
            redact_sender_private=(
                active.get("initiating_payer_user_id") != user.get("id")
            ),
        )

    timestamp = now_utc()
    source_amount_text = _money_string(source_amount, currency)
    document = {
        "id": gen_id(),
        "quote_id": body.quote_id,
        "trip_id": trip_id,
        "from_member_id": from_member_id,
        "to_member_id": to_member_id,
        "initiating_payer_user_id": user["id"],
        "selected_recipient_person_id": recipient["person_id"],
        "selected_recipient_user_id": recipient["linked_user_id"],
        "trip_name_snapshot": trip.get("name") or "",
        "from_name_snapshot": payer.get("name") or "",
        "to_name_snapshot": creditor.get("name") or "",
        "initiating_payer_name_snapshot": user.get("name") or payer.get("name") or "",
        "selected_recipient_name_snapshot": recipient["person_name"],
        "selected_recipient_family_name_snapshot": recipient.get("family_name"),
        "upi_id_snapshot": recipient["upi_id"],
        "upi_updated_at_snapshot": recipient.get("upi_updated_at"),
        "source_amount": source_amount_text,
        "source_currency": currency,
        "amount_paise": int(inr_amount * 100),
        "currency": "INR",
        "quote_rate_snapshot": str(rate),
        "quote_effective_rate_date_snapshot": quote.get("effective_rate_date"),
        "quote_provider_snapshot": quote.get("provider"),
        "quote_stale_snapshot": bool(quote.get("stale")),
        "quote_expires_at_snapshot": quote_expires_at.isoformat(),
        "handoff_method": body.handoff_method,
        "transaction_reference": None,
        "linked_payment_id": None,
        "posted_amount": None,
        "posted_currency": currency,
        "status": "initiated",
        "reason": None,
        "active_key": key,
        "initiated_at": timestamp.isoformat(),
        "updated_at": timestamp.isoformat(),
        "expires_at": timestamp + PAYMENT_ATTEMPT_LIFETIME,
    }
    try:
        await db.payment_attempts.insert_one(document)
    except DuplicateKeyError:
        duplicate = await db.payment_attempts.find_one(
            {"$or": [{"quote_id": body.quote_id}, {"active_key": key}]}, {"_id": 0}
        )
        if duplicate:
            if duplicate.get("quote_id") == body.quote_id:
                if (
                    duplicate.get("trip_id") == trip_id
                    and duplicate.get("initiating_payer_user_id") == user.get("id")
                ):
                    return _response(duplicate)
                raise _error(409, "quote_already_used", "This payment quote was already used")
            if duplicate.get("trip_id") == trip_id and duplicate.get("active_key") == key:
                return _response(
                    duplicate,
                    redact_sender_private=(
                        duplicate.get("initiating_payer_user_id") != user.get("id")
                    ),
                )
        raise
    return _response(document)


@router.get("/trips/{trip_id}/payment-attempts")
async def list_payment_attempts(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user)
    await expire_payment_attempts(trip_id)
    if is_trip_admin(trip, user):
        query: dict = {"trip_id": trip_id}
    else:
        creditor_ids = [
            member.get("id")
            for member in trip.get("members", [])
            if can_record_payment(trip, member.get("id"), user)
        ]
        query = {
            "trip_id": trip_id,
            "$or": [
                {"initiating_payer_user_id": user.get("id")},
                {"to_member_id": {"$in": creditor_ids}},
            ],
        }
    rows = await db.payment_attempts.find(query, {"_id": 0}).sort(
        "initiated_at", -1
    ).to_list(None)
    return [_response(row) for row in rows]


@router.patch("/trips/{trip_id}/payment-attempts/{attempt_id}/sender")
async def update_payment_attempt_sender(
    trip_id: str,
    attempt_id: str,
    body: PaymentAttemptSenderPatch,
    background_tasks: BackgroundTasks,
    user=Depends(get_current_user),
):
    await _trip_or_404(trip_id, user)
    await expire_payment_attempts(trip_id)
    attempt = await _attempt_or_404(trip_id, attempt_id)
    if attempt.get("initiating_payer_user_id") != user.get("id"):
        raise HTTPException(403, "Only the initiating payer can update this payment attempt")

    status = attempt.get("status")
    if body.action == "report_paid":
        if status == "awaiting_confirmation":
            return _response(attempt)
        if status != "initiated":
            raise _error(409, "invalid_transition", "This payment can no longer be reported as paid")
        timestamp = now_utc()
        updates = {
            "status": "awaiting_confirmation",
            "reason": "payer_reported_paid",
            "transaction_reference": body.transaction_reference,
            "sender_reported_by": user["id"],
            "awaiting_confirmation_at": timestamp.isoformat(),
            "updated_at": timestamp.isoformat(),
            "expires_at": timestamp + PAYMENT_ATTEMPT_LIFETIME,
        }
        result = await db.payment_attempts.update_one(
            {"id": attempt_id, "trip_id": trip_id, "status": "initiated"},
            {"$set": updates},
        )
        if not _changed(result):
            fresh = await _attempt_or_404(trip_id, attempt_id)
            if fresh.get("status") == "awaiting_confirmation":
                return _response(fresh)
            raise _error(409, "invalid_transition", "This payment attempt changed; refresh and retry")
        attempt.update(updates)
        await _safe_enqueue(
            event_type="payment_attempt.confirmation_requested",
            source_id=attempt_id,
            trip_id=trip_id,
            actor_user_id=user["id"],
            recipient_user_ids_override=[attempt.get("selected_recipient_user_id")],
            background_tasks=background_tasks,
        )
        return _response(attempt)

    if status == "canceled":
        return _response(attempt)
    if status != "initiated":
        raise _error(
            409,
            "invalid_transition",
            "A reported payment claim cannot be canceled by the payer",
        )
    timestamp = now_utc()
    updates = {
        "status": "canceled",
        "reason": "payer_reported_not_paid",
        "canceled_by": user["id"],
        "canceled_at": timestamp.isoformat(),
        "updated_at": timestamp.isoformat(),
    }
    result = await db.payment_attempts.update_one(
        {"id": attempt_id, "trip_id": trip_id, "status": "initiated"},
        {"$set": updates, "$unset": {"active_key": ""}},
    )
    if not _changed(result):
        raise _error(409, "invalid_transition", "This payment attempt changed; refresh and retry")
    attempt.update(updates)
    attempt.pop("active_key", None)
    return _response(attempt)


async def _confirm_received_transaction(
    trip_id: str,
    attempt_id: str,
    user: dict,
) -> tuple[dict, Optional[str]]:
    payment_id = gen_id()

    async def callback(session):
        attempt = await db.payment_attempts.find_one(
            {"id": attempt_id, "trip_id": trip_id}, {"_id": 0}, session=session
        )
        if not attempt:
            raise HTTPException(404, "Payment attempt not found")
        if attempt.get("status") == "settled_recipient_confirmed":
            return attempt, None
        if attempt.get("status") not in {"awaiting_confirmation", "needs_review"}:
            raise _error(409, "invalid_transition", "This payment is not awaiting confirmation")

        trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
        if not trip:
            raise HTTPException(404, "Trip not found")
        if not can_record_payment(trip, attempt.get("to_member_id"), user):
            raise HTTPException(403, "Only the recipient or a trip admin can confirm this payment")

        balances = await _compute_balances(trip_id, diagnostic=is_trip_admin(trip, user), session=session)
        payable = _suggested_amount(
            balances.get("transfers", []),
            attempt.get("from_member_id"),
            attempt.get("to_member_id"),
        )
        original = decimal_amount(attempt.get("source_amount"))
        posted = min(original, payable) if payable > 0 else Decimal("0")
        timestamp = now_utc()

        if posted <= 0:
            updates = {
                "status": "needs_review",
                "reason": "no_current_payable",
                "confirmation_attempted_by": user["id"],
                "confirmation_attempted_at": timestamp.isoformat(),
                "updated_at": timestamp.isoformat(),
                "expires_at": timestamp + PAYMENT_ATTEMPT_LIFETIME,
            }
            changed = await db.payment_attempts.update_one(
                {
                    "id": attempt_id,
                    "trip_id": trip_id,
                    "status": {"$in": ["awaiting_confirmation", "needs_review"]},
                },
                {"$set": updates},
                session=session,
            )
            if not _changed(changed):
                raise _ConcurrentLedgerChange()
            attempt.update(updates)
            return attempt, "payment_attempt.not_received"

        posted, audit_fields = validate_new_amount(trip, posted)
        version = trip.get("version", 0)
        guard = await db.trips.update_one(
            {"id": trip_id, "version": version},
            {"$inc": {"version": 1}},
            session=session,
        )
        if not _changed(guard):
            raise _ConcurrentLedgerChange()
        payment = {
            "id": payment_id,
            "trip_id": trip_id,
            "from_member_id": attempt["from_member_id"],
            "to_member_id": attempt["to_member_id"],
            "amount": _ledger_number(posted, audit_fields),
            "currency": trip.get("currency", "INR"),
            "created_at": timestamp.isoformat(),
            "recorded_by": user["id"],
            "note": None,
            "source": "upi_recipient_confirmed",
            "payment_attempt_id": attempt_id,
            **audit_fields,
        }
        await db.payments.insert_one(payment, session=session)
        updates = {
            "status": "settled_recipient_confirmed",
            "reason": "recipient_confirmed",
            "recipient_confirmed_by": user["id"],
            "confirmed_at": timestamp.isoformat(),
            "updated_at": timestamp.isoformat(),
            "linked_payment_id": payment_id,
            "posted_amount": _ledger_number(posted, audit_fields),
            "posted_currency": trip.get("currency", "INR"),
        }
        changed = await db.payment_attempts.update_one(
            {
                "id": attempt_id,
                "trip_id": trip_id,
                "status": {"$in": ["awaiting_confirmation", "needs_review"]},
            },
            {"$set": updates, "$unset": {"active_key": ""}},
            session=session,
        )
        if not _changed(changed):
            raise _ConcurrentLedgerChange()
        attempt.update(updates)
        attempt.pop("active_key", None)
        return attempt, "payment_attempt.confirmed"

    try:
        return await run_required_transaction(callback)
    except TransactionUnavailableError as exc:
        raise _error(
            503,
            "payment_confirmation_unavailable",
            "Recipient confirmation is temporarily unavailable. Try again.",
            retryable=True,
        ) from exc
    except _ConcurrentLedgerChange as exc:
        raise _error(
            409,
            "balances_changed",
            "Balances changed while confirming. Refresh and retry.",
            retryable=True,
        ) from exc
    except Exception as exc:
        if is_retryable_transaction_error(exc):
            raise _error(
                409,
                "confirmation_conflict",
                "Another ledger update is in progress. Refresh and retry.",
                retryable=True,
            ) from exc
        raise


@router.patch("/trips/{trip_id}/payment-attempts/{attempt_id}/recipient")
async def update_payment_attempt_recipient(
    trip_id: str,
    attempt_id: str,
    body: PaymentAttemptRecipientPatch,
    background_tasks: BackgroundTasks,
    user=Depends(get_current_user),
):
    trip = await _trip_or_404(trip_id, user)
    await expire_payment_attempts(trip_id)
    attempt = await _attempt_or_404(trip_id, attempt_id)
    if not can_record_payment(trip, attempt.get("to_member_id"), user):
        raise HTTPException(403, "Only the recipient or a trip admin can review this payment")

    if body.action == "confirm_received":
        confirmed, event_type = await _confirm_received_transaction(trip_id, attempt_id, user)
        if event_type:
            await _safe_enqueue(
                event_type=event_type,
                source_id=attempt_id,
                trip_id=trip_id,
                actor_user_id=user["id"],
                recipient_user_ids_override=[confirmed.get("initiating_payer_user_id")],
                background_tasks=background_tasks,
            )
        return _response(confirmed)

    status = attempt.get("status")
    if body.action == "report_not_received":
        if status == "needs_review":
            return _response(attempt)
        if status != "awaiting_confirmation":
            raise _error(409, "invalid_transition", "This payment is not awaiting confirmation")
        timestamp = now_utc()
        updates = {
            "status": "needs_review",
            "reason": "recipient_reported_not_received",
            "recipient_not_received_by": user["id"],
            "not_received_at": timestamp.isoformat(),
            "updated_at": timestamp.isoformat(),
            "expires_at": timestamp + PAYMENT_ATTEMPT_LIFETIME,
        }
        result = await db.payment_attempts.update_one(
            {"id": attempt_id, "trip_id": trip_id, "status": "awaiting_confirmation"},
            {"$set": updates},
        )
        if not _changed(result):
            raise _error(409, "invalid_transition", "This payment attempt changed; refresh and retry")
        attempt.update(updates)
        await _safe_enqueue(
            event_type="payment_attempt.not_received",
            source_id=attempt_id,
            trip_id=trip_id,
            actor_user_id=user["id"],
            recipient_user_ids_override=[attempt.get("initiating_payer_user_id")],
            background_tasks=background_tasks,
        )
        return _response(attempt)

    if status == "closed":
        return _response(attempt)
    if status != "needs_review":
        raise _error(409, "invalid_transition", "Only a payment needing review can be closed")
    timestamp = now_utc()
    updates = {
        "status": "closed",
        "reason": "review_closed_without_posting",
        "review_closed_by": user["id"],
        "closed_at": timestamp.isoformat(),
        "updated_at": timestamp.isoformat(),
    }
    result = await db.payment_attempts.update_one(
        {"id": attempt_id, "trip_id": trip_id, "status": "needs_review"},
        {"$set": updates, "$unset": {"active_key": ""}},
    )
    if not _changed(result):
        raise _error(409, "invalid_transition", "This payment attempt changed; refresh and retry")
    attempt.update(updates)
    attempt.pop("active_key", None)
    await _safe_enqueue(
        event_type="payment_attempt.review_closed",
        source_id=attempt_id,
        trip_id=trip_id,
        actor_user_id=user["id"],
        recipient_user_ids_override=[attempt.get("initiating_payer_user_id")],
        background_tasks=background_tasks,
    )
    return _response(attempt)
