"""Expiry lifecycle for unresolved recipient-confirmed UPI payment attempts."""

import asyncio
from datetime import datetime, timedelta
from typing import Optional

from config import logger
from database import db
from utils.common import now_utc


ACTIVE_PAYMENT_ATTEMPT_STATUSES = (
    "initiated",
    "awaiting_confirmation",
    "needs_review",
)
MEMBER_BLOCKING_PAYMENT_ATTEMPT_STATUSES = (
    *ACTIVE_PAYMENT_ATTEMPT_STATUSES,
    "settled_recipient_confirmed",
)
PAYMENT_ATTEMPT_LIFETIME = timedelta(hours=24)


def has_sent_evidence(attempt):
    return bool(attempt.get("awaiting_confirmation_at") or attempt.get("sender_reported_by")
                or attempt.get("reported_by") or attempt.get("recipient_not_received_by"))

_sweeper_task: Optional[asyncio.Task] = None
_sweeper_stop: Optional[asyncio.Event] = None


async def expire_payment_attempts(
    trip_id: Optional[str] = None,
    *,
    timestamp: Optional[datetime] = None,
) -> int:
    """Expire only unreported starts. A sent claim never times out into another payment."""

    current = timestamp or now_utc()
    query: dict = {
        "status": "initiated",
        "settlement_intent_id": {"$exists": False},
        "awaiting_confirmation_at": None,
        "sender_reported_by": None,
        "expires_at": {"$lte": current},
    }
    if trip_id is not None:
        query["trip_id"] = trip_id
    protected = [row["id"] for row in await db.trips.find({"$or": [
        {"expense_settlement_activation_version": {"$exists": True, "$nin": [None, 0]}},
        {"financial_write_guard_version": {"$exists": True, "$nin": [None, 0]}}]}, {"_id": 0, "id": 1}).to_list(None)]
    if protected:
        query["trip_id"] = {"$nin": protected, **({"$eq": trip_id} if trip_id else {})}
    result = await db.payment_attempts.update_many(
        query,
        {
            "$set": {
                "status": "expired",
                "reason": "confirmation_window_elapsed",
                "expired_at": current.isoformat(),
                "updated_at": current.isoformat(),
            },
            "$unset": {"active_key": ""},
        },
    )
    return int(getattr(result, "modified_count", 0) or 0)


async def expire_settlement_intents(*, timestamp=None):
    from services.coverage_journal import run_snapshot_transaction
    current = timestamp or now_utc()
    rows = await db.settlement_intents.find({"status": "initiated", "expires_at": {"$lte": current.isoformat()}}, {"_id": 0}).to_list(None)
    for row in rows:
        async def expire(session):
            intent = await db.settlement_intents.find_one({"id": row["id"], "status": "initiated"}, {"_id": 0}, session=session)
            if not intent or intent.get("mode") == "offset" or not intent.get("expires_at") or intent["expires_at"] > current.isoformat():
                return
            if any(leg.get("source_id") or leg.get("receipt_status") != "initiated" for leg in intent.get("cash_legs", [])):
                return
            trip = await db.trips.find_one({"id": intent["trip_id"]}, {"_id": 0}, session=session)
            if not trip:
                return
            guard = await db.trips.update_one({"id": trip["id"], "version": trip.get("version", 0)}, {"$inc": {"version": 1}}, session=session)
            if guard.matched_count != 1:
                from services.coverage_support import CoverageError
                raise CoverageError("eligibility_changed")
            intent.update(status="expired", version=intent["version"] + 1, expired_at=current.isoformat())
            for leg in intent["cash_legs"]:
                leg["receipt_status"] = "expired"
            await db.settlement_intents.replace_one({"id": intent["id"]}, intent, session=session)
            await db.payment_attempts.update_many({"settlement_intent_id": intent["id"], "status": "initiated"},
                {"$set": {"status": "expired", "expired_at": current.isoformat()}, "$unset": {"active_key": ""}}, session=session)
            from services.coverage_support import stable_id
            action_id = stable_id("settlement-expiry", intent["id"])
            await db.settlement_intent_actions.insert_one({"id": action_id, "trip_id": trip["id"],
                "intent_id": intent["id"], "actor_user_id": None, "actor_role": "system",
                "operation": "settlement.intent.expire", "client_mutation_id": action_id,
                "event": "expired", "created_at": current.isoformat(),
                "request": {"deadline": intent["expires_at"]}}, session=session)
            from services.push_notifications import enqueue_notification_event
            await enqueue_notification_event(event_type="settlement.review_required", source_id=intent["id"],
                trip_id=trip["id"], actor_user_id=None, event_id=action_id, session=session)
        await run_snapshot_transaction(expire)


async def recover_expired_sent_reports():
    """Retain conflicts separately; never reassign a released unique pair key."""
    from services.coverage_journal import run_snapshot_transaction
    async def recover(session):
        protected = [row["id"] for row in await db.trips.find({"$or": [
            {"expense_settlement_activation_version": {"$exists": True, "$nin": [None, 0]}},
            {"financial_write_guard_version": {"$exists": True, "$nin": [None, 0]}}]}, {"_id": 0, "id": 1}, session=session).to_list(None)]
        sent = {"status": "expired", "$or": [
            {"awaiting_confirmation_at": {"$type": "string"}}, {"sender_reported_by": {"$type": "string"}},
            {"reported_by": {"$type": "string"}}, {"recipient_not_received_by": {"$type": "string"}}]}
        retained = await db.payment_attempts.find({**sent, "trip_id": {"$in": protected}}, {"_id": 0}, session=session).to_list(None)
        from services.coverage_support import stable_id
        for attempt in retained:
            at = now_utc().isoformat()
            await db.payment_attempts.update_one({"id": attempt["id"], "status": "expired"}, {"$set": {
                "status": "needs_review", "expires_at": None, "reason": "expired_sent_report_recovered",
                "duplicate_payment_blocker": True}}, session=session)
            await db.trips.update_one({"id": attempt["trip_id"]}, {"$inc": {"version": 1}}, session=session)
            await db.settlement_intent_actions.insert_one({"id": stable_id("legacy-recovery", attempt["id"]),
                "trip_id": attempt["trip_id"], "intent_id": attempt.get("settlement_intent_id") or f"legacy:{attempt['id']}",
                "actor_user_id": None, "actor_role": "system", "operation": "settlement.legacy.recover",
                "event": "needs_review", "created_at": at}, session=session)
            from services.push_notifications import enqueue_notification_event
            await enqueue_notification_event(event_type="settlement.review_required",
                source_id=attempt.get("settlement_intent_id") or f"legacy:{attempt['id']}", trip_id=attempt["trip_id"],
                actor_user_id=None, event_id=stable_id("legacy-recovery", attempt["id"]), session=session)
        return await db.payment_attempts.update_many({"trip_id": {"$nin": protected}, **sent}, {"$set": {"status": "needs_review", "expires_at": None,
                "reason": "expired_sent_report_recovered", "duplicate_payment_blocker": True}}, session=session)
    return await run_snapshot_transaction(recover)


async def _sweeper_loop(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            expired = await expire_payment_attempts()
            await expire_settlement_intents()
            await recover_expired_sent_reports()
            if expired:
                logger.info("payment_attempt.expired count=%s", expired)
        except Exception as exc:
            logger.error("Payment-attempt expiry sweep failed (%s)", type(exc).__name__)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=300)
        except asyncio.TimeoutError:
            pass


async def start_payment_attempt_sweeper() -> None:
    global _sweeper_task, _sweeper_stop
    if _sweeper_task and not _sweeper_task.done():
        return
    _sweeper_stop = asyncio.Event()
    _sweeper_task = asyncio.create_task(
        _sweeper_loop(_sweeper_stop), name="payment-attempt-expiry-sweeper"
    )


async def stop_payment_attempt_sweeper() -> None:
    global _sweeper_task, _sweeper_stop
    if not _sweeper_task:
        return
    if _sweeper_stop:
        _sweeper_stop.set()
    try:
        await _sweeper_task
    finally:
        _sweeper_task = None
        _sweeper_stop = None
