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

_sweeper_task: Optional[asyncio.Task] = None
_sweeper_stop: Optional[asyncio.Event] = None


async def expire_payment_attempts(
    trip_id: Optional[str] = None,
    *,
    timestamp: Optional[datetime] = None,
) -> int:
    """Soft-expire due unresolved rows. Expiry deliberately emits no notification."""

    current = timestamp or now_utc()
    query: dict = {
        "status": {"$in": list(ACTIVE_PAYMENT_ATTEMPT_STATUSES)},
        "expires_at": {"$lte": current},
    }
    if trip_id is not None:
        query["trip_id"] = trip_id
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


async def _sweeper_loop(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            expired = await expire_payment_attempts()
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
