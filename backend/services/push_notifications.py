"""Durable, privacy-preserving Android push delivery through the Expo Push Service.

Financial writes only enqueue an idempotent event. A best-effort FastAPI background task sends it
immediately, while the single-process dispatcher reclaims due or interrupted work from MongoDB.
No payment details are ever copied into a notification or an application log.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from config import (
    EXPO_PUSH_ACCESS_TOKEN,
    PUSH_NOTIFICATIONS_ENABLED,
    logger,
)
from database import db
from utils.common import now_utc


EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
PUSH_TITLE = "Trip Splitter"
PUSH_BODY = "There's new activity in one of your trips."
PUSH_CHANNEL_ID = "trip_activity"

_ACTIVE_EVENT_STATUSES = ("pending", "waiting", "processing")
_TARGETS = ("trip_expenses", "settle_up")
_LEASE_SECONDS = 120
_RECEIPT_DELAY_SECONDS = 15 * 60
_RECEIPT_RETRY_SECONDS = 5 * 60
_MAX_ATTEMPTS = 8
_MAX_AGE = timedelta(hours=24)
_RETRY_DELAYS = (60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60)
_RETRYABLE_TICKET_ERRORS = {
    "MessageRateExceeded",
    "InvalidCredentials",
    "MismatchSenderId",
}

_dispatcher_task: Optional[asyncio.Task] = None
_dispatcher_stop: Optional[asyncio.Event] = None


def recipient_user_ids(trip: dict, actor_user_id: str) -> list[str]:
    """Return current linked accounts, once each, preserving trip order and excluding the actor."""
    seen: set[str] = set()
    recipients: list[str] = []
    for raw_user_id in trip.get("user_ids", []):
        user_id = str(raw_user_id)
        if not user_id or user_id == actor_user_id or user_id in seen:
            continue
        seen.add(user_id)
        recipients.append(user_id)
    return recipients


def build_expo_message(event: dict, delivery: dict) -> dict:
    """Build the only allowed lock-screen payload; intentionally excludes financial data."""
    return {
        "to": delivery["token"],
        "title": PUSH_TITLE,
        "body": PUSH_BODY,
        "sound": "default",
        "channelId": PUSH_CHANNEL_ID,
        "priority": "default",
        "data": {
            "eventKey": event["event_key"],
            "tripId": event["trip_id"],
            "target": event["target"],
        },
    }


async def enqueue_financial_event(
    *,
    event_key: str,
    event_type: str,
    source_id: str,
    trip_id: str,
    actor_user_id: str,
    target: str,
    background_tasks: Any = None,
) -> bool:
    """Persist one idempotent event without ever failing the completed business operation."""
    if not PUSH_NOTIFICATIONS_ENABLED:
        return False
    if target not in _TARGETS:
        logger.error("Push outbox rejected an invalid target for event %s", event_key)
        return False

    timestamp = now_utc()
    document = {
        "event_key": event_key,
        "event_type": event_type,
        "source_id": source_id,
        "trip_id": trip_id,
        "actor_user_id": actor_user_id,
        "target": target,
        "status": "pending",
        "attempts": 0,
        "next_attempt_at": timestamp,
        "lease_until": None,
        "delivery_snapshot_at": None,
        "deliveries": [],
        "last_error": None,
        "created_at": timestamp,
        "updated_at": timestamp,
        "completed_at": None,
    }
    inserted = False
    try:
        await db.notification_outbox.insert_one(document)
        inserted = True
    except DuplicateKeyError:
        # A retry of the originating API call must not fan out a second notification.
        pass
    except Exception as exc:
        logger.error(
            "Could not enqueue push event %s (%s)", event_key, type(exc).__name__,
        )
        return False

    if background_tasks is not None:
        try:
            background_tasks.add_task(dispatch_outbox_event, event_key)
        except Exception as exc:
            logger.error(
                "Could not schedule immediate push event %s (%s)",
                event_key, type(exc).__name__,
            )
    return inserted


async def _expo_post(url: str, payload: Any) -> tuple[int, Any]:
    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
    }
    if EXPO_PUSH_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {EXPO_PUSH_ACCESS_TOKEN}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        response = await client.post(url, json=payload, headers=headers)
    try:
        body = response.json()
    except ValueError:
        body = None
    return response.status_code, body


def _aware(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return fallback


def _is_expired(attempts: int, started_at: Any, timestamp: datetime) -> bool:
    return attempts >= _MAX_ATTEMPTS or timestamp - _aware(started_at, timestamp) >= _MAX_AGE


def _retry_delay(attempts: int) -> int:
    index = max(0, min(attempts - 1, len(_RETRY_DELAYS) - 1))
    return _RETRY_DELAYS[index]


def _retry_delivery(delivery: dict, code: str, event: dict, timestamp: datetime) -> None:
    delivery["last_error"] = code[:120]
    if _is_expired(delivery.get("attempts", 0), event.get("created_at"), timestamp):
        delivery["status"] = "dead"
        delivery["next_attempt_at"] = None
        return
    delivery["status"] = "retry"
    delivery["next_attempt_at"] = timestamp + timedelta(
        seconds=_retry_delay(delivery.get("attempts", 1)),
    )


def _retry_receipt(delivery: dict, code: str, timestamp: datetime) -> None:
    delivery["last_error"] = code[:120]
    receipt_attempts = delivery.get("receipt_attempts", 0)
    if _is_expired(receipt_attempts, delivery.get("ticketed_at"), timestamp):
        # Expo accepted the message but never returned a terminal receipt. Preserve that distinction
        # instead of incorrectly claiming either delivery or failure.
        delivery["status"] = "receipt_unavailable"
        delivery["receipt_check_at"] = None
        return
    delivery["status"] = "ticketed"
    delivery["receipt_check_at"] = timestamp + timedelta(seconds=_RECEIPT_RETRY_SECONDS)


async def _deactivate_delivery_device(delivery: dict) -> None:
    await db.push_devices.update_one(
        {
            "installation_id": delivery["installation_id"],
            "token": delivery["token"],
            "active": True,
        },
        {"$set": {
            "active": False,
            "disabled_reason": "device_not_registered",
            "updated_at": now_utc(),
        }},
    )


async def _prepare_deliveries(event: dict, timestamp: datetime) -> bool:
    if event.get("delivery_snapshot_at") is not None:
        return True

    trip = await db.trips.find_one({"id": event["trip_id"]}, {"_id": 0, "user_ids": 1})
    if not trip:
        await db.notification_outbox.update_one(
            {"event_key": event["event_key"]},
            {"$set": {
                "status": "dead",
                "last_error": "trip_missing",
                "lease_until": None,
                "completed_at": timestamp,
                "updated_at": timestamp,
            }},
        )
        return False

    recipients = recipient_user_ids(trip, event["actor_user_id"])
    devices: list[dict] = []
    if recipients:
        cursor = db.push_devices.find(
            {"user_id": {"$in": recipients}, "active": True, "platform": "android"},
            {"_id": 0},
        )
        devices = await cursor.to_list(length=5000)

    deliveries = []
    seen_tokens: set[str] = set()
    for device in devices:
        token = device.get("token")
        installation = device.get("installation_id")
        if not token or not installation or token in seen_tokens:
            continue
        seen_tokens.add(token)
        deliveries.append({
            "installation_id": installation,
            "user_id": device.get("user_id"),
            "token": token,
            "status": "pending",
            "attempts": 0,
            "receipt_attempts": 0,
            "ticket_id": None,
            "ticketed_at": None,
            "receipt_check_at": None,
            "next_attempt_at": timestamp,
            "last_error": None,
        })

    event["deliveries"] = deliveries
    event["delivery_snapshot_at"] = timestamp
    await db.notification_outbox.update_one(
        {"event_key": event["event_key"]},
        {"$set": {
            "deliveries": deliveries,
            "delivery_snapshot_at": timestamp,
            "updated_at": timestamp,
        }},
    )
    return True


async def _handle_ticket(
    event: dict,
    delivery: dict,
    ticket: Any,
    timestamp: datetime,
) -> None:
    if not isinstance(ticket, dict):
        _retry_delivery(delivery, "malformed_expo_ticket", event, timestamp)
        return
    if ticket.get("status") == "ok" and isinstance(ticket.get("id"), str):
        delivery.update({
            "status": "ticketed",
            "ticket_id": ticket["id"],
            "ticketed_at": timestamp,
            "receipt_check_at": timestamp + timedelta(seconds=_RECEIPT_DELAY_SECONDS),
            "next_attempt_at": None,
            "last_error": None,
        })
        return

    details = ticket.get("details") if isinstance(ticket.get("details"), dict) else {}
    error_code = details.get("error")
    if error_code == "DeviceNotRegistered":
        delivery.update({"status": "dead", "next_attempt_at": None,
                         "last_error": "DeviceNotRegistered"})
        await _deactivate_delivery_device(delivery)
    elif error_code in _RETRYABLE_TICKET_ERRORS or not error_code:
        _retry_delivery(delivery, error_code or "expo_ticket_error", event, timestamp)
    else:
        delivery.update({"status": "dead", "next_attempt_at": None,
                         "last_error": str(error_code)[:120]})


async def _persist_delivery_state(event: dict, timestamp: datetime) -> None:
    """Narrow the crash window between an Expo response and the event-level finalization."""
    await db.notification_outbox.update_one(
        {"event_key": event["event_key"]},
        {"$set": {"deliveries": event.get("deliveries", []), "updated_at": timestamp}},
    )


async def _send_due_deliveries(event: dict, timestamp: datetime) -> None:
    deliveries = event.get("deliveries", [])
    due = [
        delivery for delivery in deliveries
        if delivery.get("status") in ("pending", "retry")
        and _aware(delivery.get("next_attempt_at"), timestamp) <= timestamp
    ][:100]
    if not due:
        return

    for delivery in due:
        delivery["attempts"] = delivery.get("attempts", 0) + 1
    messages = [build_expo_message(event, delivery) for delivery in due]
    try:
        status_code, response = await _expo_post(EXPO_SEND_URL, messages)
    except Exception as exc:
        code = f"push_request_{type(exc).__name__}"
        for delivery in due:
            _retry_delivery(delivery, code, event, timestamp)
        await _persist_delivery_state(event, timestamp)
        return

    if status_code == 429 or status_code >= 500 or status_code in (401, 403):
        for delivery in due:
            _retry_delivery(delivery, f"expo_http_{status_code}", event, timestamp)
        await _persist_delivery_state(event, timestamp)
        return
    if status_code >= 400:
        for delivery in due:
            delivery.update({"status": "dead", "next_attempt_at": None,
                             "last_error": f"expo_http_{status_code}"})
        await _persist_delivery_state(event, timestamp)
        return

    tickets = response.get("data") if isinstance(response, dict) else None
    if not isinstance(tickets, list) or len(tickets) != len(due):
        for delivery in due:
            _retry_delivery(delivery, "malformed_expo_response", event, timestamp)
        await _persist_delivery_state(event, timestamp)
        return
    for delivery, ticket in zip(due, tickets):
        await _handle_ticket(event, delivery, ticket, timestamp)
    await _persist_delivery_state(event, timestamp)


async def _handle_receipt(delivery: dict, receipt: Any, timestamp: datetime) -> None:
    if not isinstance(receipt, dict):
        _retry_receipt(delivery, "malformed_expo_receipt", timestamp)
        return
    if receipt.get("status") == "ok":
        delivery.update({
            "status": "receipt_ok",
            "receipt_check_at": None,
            "last_error": None,
        })
        return

    details = receipt.get("details") if isinstance(receipt.get("details"), dict) else {}
    error_code = details.get("error")
    if error_code == "DeviceNotRegistered":
        delivery.update({"status": "dead", "receipt_check_at": None,
                         "last_error": "DeviceNotRegistered"})
        await _deactivate_delivery_device(delivery)
    elif error_code in _RETRYABLE_TICKET_ERRORS or not error_code:
        _retry_receipt(delivery, error_code or "expo_receipt_error", timestamp)
    else:
        delivery.update({"status": "dead", "receipt_check_at": None,
                         "last_error": str(error_code)[:120]})


async def _poll_due_receipts(event: dict, timestamp: datetime) -> None:
    deliveries = event.get("deliveries", [])
    due = [
        delivery for delivery in deliveries
        if delivery.get("status") == "ticketed"
        and _aware(delivery.get("receipt_check_at"), timestamp) <= timestamp
        and delivery.get("ticket_id")
    ][:100]
    if not due:
        return

    for delivery in due:
        delivery["receipt_attempts"] = delivery.get("receipt_attempts", 0) + 1
    ticket_ids = [delivery["ticket_id"] for delivery in due]
    try:
        status_code, response = await _expo_post(EXPO_RECEIPTS_URL, {"ids": ticket_ids})
    except Exception as exc:
        code = f"receipt_request_{type(exc).__name__}"
        for delivery in due:
            _retry_receipt(delivery, code, timestamp)
        await _persist_delivery_state(event, timestamp)
        return

    if status_code == 429 or status_code >= 500 or status_code in (401, 403):
        for delivery in due:
            _retry_receipt(delivery, f"expo_receipt_http_{status_code}", timestamp)
        await _persist_delivery_state(event, timestamp)
        return
    if status_code >= 400:
        for delivery in due:
            delivery.update({"status": "dead", "receipt_check_at": None,
                             "last_error": f"expo_receipt_http_{status_code}"})
        await _persist_delivery_state(event, timestamp)
        return

    receipts = response.get("data") if isinstance(response, dict) else None
    if not isinstance(receipts, dict):
        for delivery in due:
            _retry_receipt(delivery, "malformed_expo_receipts_response", timestamp)
        await _persist_delivery_state(event, timestamp)
        return
    for delivery in due:
        receipt = receipts.get(delivery["ticket_id"])
        if receipt is None:
            _retry_receipt(delivery, "expo_receipt_not_ready", timestamp)
        else:
            await _handle_receipt(delivery, receipt, timestamp)
    await _persist_delivery_state(event, timestamp)


async def _finalize_event(event: dict, timestamp: datetime) -> None:
    deliveries = event.get("deliveries", [])
    next_actions: list[datetime] = []
    for delivery in deliveries:
        if delivery.get("status") in ("pending", "retry"):
            next_actions.append(_aware(delivery.get("next_attempt_at"), timestamp))
        elif delivery.get("status") == "ticketed":
            next_actions.append(_aware(delivery.get("receipt_check_at"), timestamp))

    if next_actions:
        status = "waiting"
        next_attempt_at: Optional[datetime] = min(next_actions)
        completed_at = None
        last_error = None
    else:
        all_failed = bool(deliveries) and all(
            delivery.get("status") == "dead" for delivery in deliveries
        )
        status = "dead" if all_failed else "complete"
        next_attempt_at = None
        completed_at = timestamp
        last_error = "all_deliveries_failed" if all_failed else None

    event.update({
        "status": status,
        "next_attempt_at": next_attempt_at,
        "lease_until": None,
        "completed_at": completed_at,
        "last_error": last_error,
        "updated_at": timestamp,
    })
    await db.notification_outbox.update_one(
        {"event_key": event["event_key"]},
        {"$set": {
            "deliveries": deliveries,
            "status": status,
            "next_attempt_at": next_attempt_at,
            "lease_until": None,
            "completed_at": completed_at,
            "last_error": last_error,
            "updated_at": timestamp,
        }},
    )


async def _claim_due_event(event_key: Optional[str] = None) -> Optional[dict]:
    timestamp = now_utc()
    query: dict[str, Any] = {
        "status": {"$in": list(_ACTIVE_EVENT_STATUSES)},
        "next_attempt_at": {"$lte": timestamp},
        "$or": [
            {"lease_until": None},
            {"lease_until": {"$exists": False}},
            {"lease_until": {"$lte": timestamp}},
        ],
    }
    if event_key is not None:
        query["event_key"] = event_key
    return await db.notification_outbox.find_one_and_update(
        query,
        {"$set": {
            "status": "processing",
            "lease_until": timestamp + timedelta(seconds=_LEASE_SECONDS),
            "updated_at": timestamp,
        }, "$inc": {"attempts": 1}},
        sort=[("next_attempt_at", 1)],
        return_document=ReturnDocument.AFTER,
    )


async def _process_claimed_event(event: dict) -> None:
    timestamp = now_utc()
    if not await _prepare_deliveries(event, timestamp):
        return
    await _poll_due_receipts(event, timestamp)
    await _send_due_deliveries(event, timestamp)
    await _finalize_event(event, timestamp)


async def dispatch_outbox_event(event_key: str) -> bool:
    """Best-effort immediate dispatch for a just-committed outbox event."""
    if not PUSH_NOTIFICATIONS_ENABLED:
        return False
    event = await _claim_due_event(event_key)
    if not event:
        return False
    try:
        await _process_claimed_event(event)
    except Exception as exc:
        # Leave the processing lease intact. The durable loop will reclaim it after expiry.
        logger.error(
            "Push event %s dispatch failed (%s)", event_key, type(exc).__name__,
        )
        return False
    return True


async def dispatch_due_notifications(limit: int = 20) -> int:
    """Drain up to ``limit`` due outbox claims, including receipt work and expired leases."""
    if not PUSH_NOTIFICATIONS_ENABLED:
        return 0
    processed = 0
    for _ in range(limit):
        event = await _claim_due_event()
        if not event:
            break
        try:
            await _process_claimed_event(event)
        except Exception as exc:
            logger.error(
                "Push outbox dispatch failed for event %s (%s)",
                event.get("event_key", "unknown"), type(exc).__name__,
            )
        processed += 1
    return processed


async def _dispatcher_loop(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            processed = await dispatch_due_notifications()
        except Exception as exc:
            logger.error("Push dispatcher loop failed (%s)", type(exc).__name__)
            processed = 0
        timeout = 1 if processed >= 20 else 30
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass


async def start_push_dispatcher() -> None:
    global _dispatcher_task, _dispatcher_stop
    if not PUSH_NOTIFICATIONS_ENABLED or (_dispatcher_task and not _dispatcher_task.done()):
        return
    if not EXPO_PUSH_ACCESS_TOKEN:
        logger.warning(
            "Push notifications are enabled without EXPO_PUSH_ACCESS_TOKEN; "
            "Expo enhanced push security must remain disabled until it is configured."
        )
    _dispatcher_stop = asyncio.Event()
    _dispatcher_task = asyncio.create_task(
        _dispatcher_loop(_dispatcher_stop), name="push-notification-dispatcher",
    )
    logger.info("Push notification dispatcher started")


async def stop_push_dispatcher() -> None:
    global _dispatcher_task, _dispatcher_stop
    if not _dispatcher_task:
        return
    if _dispatcher_stop:
        _dispatcher_stop.set()
    try:
        await _dispatcher_task
    finally:
        _dispatcher_task = None
        _dispatcher_stop = None
