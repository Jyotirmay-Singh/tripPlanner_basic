import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError

from models.push import PushDeviceUpsert
from routes import push
from services import push_notifications as notifications
from utils.common import now_utc


VALID_TOKEN = "ExpoPushToken[abcdefghijklmnopqrstuv]"
TRIP_ID = "12345678-1234-4678-9234-567812345678"
SOURCE_ID = "87654321-4321-4765-8123-210987654321"


def run(awaitable):
    return asyncio.run(awaitable)


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, length):
        return self.rows[:length]


def test_push_device_model_accepts_only_android_expo_tokens():
    body = PushDeviceUpsert(token=f"  {VALID_TOKEN}  ", platform="android")
    assert body.token == VALID_TOKEN
    with pytest.raises(ValidationError):
        PushDeviceUpsert(token="not-a-push-token", platform="android")
    with pytest.raises(ValidationError):
        PushDeviceUpsert(token=VALID_TOKEN, platform="ios")


def test_push_eligibility_is_true_for_a_current_trip_member(monkeypatch):
    trips = SimpleNamespace(find_one=AsyncMock(return_value={"id": "trip-private"}))
    join_requests = SimpleNamespace(find_one=AsyncMock())
    monkeypatch.setattr(push, "db", SimpleNamespace(
        trips=trips, join_requests=join_requests,
    ))

    result = run(push.get_push_eligibility(user={"id": "u1"}))

    assert result == {"eligible": True}
    assert list(result) == ["eligible"]
    trips.find_one.assert_awaited_once_with(
        {"user_ids": "u1"}, {"_id": 0, "id": 1},
    )
    join_requests.find_one.assert_not_awaited()


def test_push_eligibility_http_contract_requires_authentication():
    app = FastAPI()
    app.include_router(push.router, prefix="/api")

    response = TestClient(app).get("/api/push/eligibility")

    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}


def test_push_eligibility_is_true_for_zero_trip_pending_requester(monkeypatch):
    trips = SimpleNamespace(find_one=AsyncMock(return_value=None))
    join_requests = SimpleNamespace(find_one=AsyncMock(return_value={"id": "request-private"}))
    monkeypatch.setattr(push, "db", SimpleNamespace(
        trips=trips, join_requests=join_requests,
    ))

    result = run(push.get_push_eligibility(user={"id": "requester"}))

    assert result == {"eligible": True}
    assert "request-private" not in str(result)
    join_requests.find_one.assert_awaited_once_with(
        {
            "requester_user_id": "requester",
            "active": True,
            "status": {"$in": ["pending", "approving"]},
        },
        {"_id": 0, "id": 1},
    )


def test_push_eligibility_is_false_without_trip_or_active_pending_request(monkeypatch):
    trips = SimpleNamespace(find_one=AsyncMock(return_value=None))
    join_requests = SimpleNamespace(find_one=AsyncMock(return_value=None))
    monkeypatch.setattr(push, "db", SimpleNamespace(
        trips=trips, join_requests=join_requests,
    ))

    assert run(push.get_push_eligibility(user={"id": "u1"})) == {"eligible": False}


def test_register_reassigns_token_and_never_exposes_it(monkeypatch, caplog):
    devices = SimpleNamespace(update_many=AsyncMock(), update_one=AsyncMock())
    monkeypatch.setattr(push, "db", SimpleNamespace(push_devices=devices))
    installation_id = UUID("12345678-1234-4678-9234-567812345678")

    result = run(push.register_push_device(
        installation_id,
        PushDeviceUpsert(token=VALID_TOKEN, platform="android"),
        user={"id": "u1"},
    ))

    assert result == {"ok": True}
    deactivate_filter = devices.update_many.await_args.args[0]
    assert deactivate_filter["token"] == VALID_TOKEN
    upsert_filter, update = devices.update_one.await_args.args[:2]
    assert upsert_filter == {"installation_id": str(installation_id)}
    assert update["$set"]["user_id"] == "u1"
    assert update["$set"]["active"] is True
    # The API response deliberately contains no installation or token material.
    assert VALID_TOKEN not in str(result)
    assert VALID_TOKEN not in caplog.text


def test_register_retries_a_concurrent_active_token_reassignment(monkeypatch):
    devices = SimpleNamespace(
        update_many=AsyncMock(),
        update_one=AsyncMock(side_effect=[DuplicateKeyError("active token race"), None]),
    )
    monkeypatch.setattr(push, "db", SimpleNamespace(push_devices=devices))
    installation_id = UUID("12345678-1234-4678-9234-567812345678")

    result = run(push.register_push_device(
        installation_id,
        PushDeviceUpsert(token=VALID_TOKEN, platform="android"),
        user={"id": "u1"},
    ))

    assert result == {"ok": True}
    assert devices.update_many.await_count == 2
    assert devices.update_one.await_count == 2


def test_unregister_is_idempotent_and_scoped_to_current_user(monkeypatch):
    devices = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(push, "db", SimpleNamespace(push_devices=devices))
    installation_id = UUID("12345678-1234-4678-9234-567812345678")

    response = run(push.unregister_push_device(installation_id, user={"id": "u1"}))

    assert response.status_code == 204
    query = devices.update_one.await_args.args[0]
    assert query == {"installation_id": str(installation_id), "user_id": "u1"}
    assert devices.update_one.await_args.args[1]["$set"]["disabled_reason"] == "logout"


def test_unregister_records_permission_revocation_without_exposing_token(monkeypatch, caplog):
    devices = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(push, "db", SimpleNamespace(push_devices=devices))
    installation_id = UUID("12345678-1234-5678-9234-567812345678")

    response = run(push.unregister_push_device(
        installation_id, reason="permission_denied", user={"id": "u1"},
    ))

    assert response.status_code == 204
    assert devices.update_one.await_args.args[1]["$set"]["disabled_reason"] == "permission_denied"
    assert VALID_TOKEN not in caplog.text


def test_recipient_resolution_excludes_actor_and_duplicates():
    trip = {"user_ids": ["actor", "u2", None, " ", "u2", "u3", "actor"]}
    assert notifications.recipient_user_ids(trip, "actor") == ["u2", "u3"]


@pytest.mark.parametrize(
    ("event_type", "target", "id_key", "title"),
    [
        (
            "expense.created", "trip_expenses", "expenseId",
            "Expense added",
        ),
        (
            "payment.recorded", "settle_up", "paymentId",
            "Payment recorded",
        ),
        (
            "settlement.paid", "settle_up", "settlementId",
            "Settlement marked paid",
        ),
        (
            "chat.message.created", "trip_chat", "messageId",
            "New group message",
        ),
        (
            "join.request.created", "trip_members", "requestId",
            "Join request received",
        ),
        (
            "join.request.approved", "trip_summary", "requestId",
            "Join request approved",
        ),
        (
            "join.request.rejected", "join_request", "requestId",
            "Join request declined",
        ),
    ],
)
def test_payload_is_private_versioned_and_contains_typed_routing_data(
    event_type, target, id_key, title,
):
    event = {
        "event_key": f"{event_type}:{SOURCE_ID}",
        "event_type": event_type,
        "source_id": SOURCE_ID,
        "trip_id": TRIP_ID,
        "trip_name": "Weekend in Goa",
        "target": target,
        "amount": 999,
        "note": "private note",
        "text": "private message",
        "person_name": "Private Person",
        "rejection_reason": "private reason",
    }
    message = notifications.build_expo_message(event, {"token": VALID_TOKEN})

    assert message["title"] == title
    assert message["body"] == "Weekend in Goa"
    assert message["channelId"] == "trip_activity"
    assert message["priority"] == "high"
    assert message["data"] == {
        "payloadVersion": 1,
        "eventKey": f"{event_type}:{SOURCE_ID}",
        "eventType": event_type,
        "tripId": TRIP_ID,
        "target": target,
        "sourceId": SOURCE_ID,
        id_key: SOURCE_ID,
    }
    assert "999" not in str(message)
    assert "private note" not in str(message)
    assert "private message" not in str(message)
    assert "Private Person" not in str(message)
    assert "private reason" not in str(message)


def test_trip_name_is_single_line_bounded_and_has_a_generic_fallback():
    assert notifications.notification_trip_name("  Goa\n  Weekend\t2026  ") == "Goa Weekend 2026"
    assert notifications.notification_trip_name(None) is None
    assert notifications.notification_trip_name(" \n\t ") is None

    long_name = "A" * 80
    compact = notifications.notification_trip_name(long_name)
    assert compact == ("A" * 59) + "…"
    assert len(compact) == notifications.TRIP_NAME_MAX_LENGTH

    event = {
        "event_key": f"expense.created:{SOURCE_ID}",
        "event_type": "expense.created",
        "source_id": SOURCE_ID,
        "trip_id": TRIP_ID,
        "target": "trip_expenses",
    }
    message = notifications.build_expo_message(event, {"token": VALID_TOKEN})
    assert message["title"] == "Expense added"
    assert message["body"] == "One of your trips"


def test_enqueue_is_idempotent_and_schedules_immediate_dispatch(monkeypatch):
    outbox = SimpleNamespace(insert_one=AsyncMock())
    background = SimpleNamespace(add_task=Mock())
    monkeypatch.setattr(notifications, "PUSH_NOTIFICATIONS_ENABLED", True)
    monkeypatch.setattr(notifications, "db", SimpleNamespace(notification_outbox=outbox))

    inserted = run(notifications.enqueue_financial_event(
        event_key="expense.created:e1",
        event_type="expense.created",
        source_id="e1",
        trip_id="t1",
        actor_user_id="u1",
        target="trip_expenses",
        background_tasks=background,
    ))

    assert inserted is True
    stored = outbox.insert_one.await_args.args[0]
    assert stored["event_key"] == "expense.created:e1"
    assert stored["status"] == "pending"
    assert stored["trip_name"] is None
    assert stored["deliveries"] == []
    background.add_task.assert_called_once_with(
        notifications.dispatch_outbox_event, "expense.created:e1",
    )

    outbox.insert_one.side_effect = DuplicateKeyError("duplicate")
    inserted_again = run(notifications.enqueue_financial_event(
        event_key="expense.created:e1",
        event_type="expense.created",
        source_id="e1",
        trip_id="t1",
        actor_user_id="u1",
        target="trip_expenses",
        background_tasks=None,
    ))
    assert inserted_again is False


def test_join_event_stores_only_the_explicit_private_audience(monkeypatch):
    outbox = SimpleNamespace(insert_one=AsyncMock())
    monkeypatch.setattr(notifications, "PUSH_NOTIFICATIONS_ENABLED", True)
    monkeypatch.setattr(notifications, "db", SimpleNamespace(notification_outbox=outbox))

    inserted = run(notifications.enqueue_notification_event(
        event_type="join.request.created",
        source_id=SOURCE_ID,
        trip_id=TRIP_ID,
        actor_user_id="requester",
        recipient_user_ids_override=["admin-1", "requester", "admin-1", "admin-2"],
    ))

    assert inserted is True
    document = outbox.insert_one.await_args.args[0]
    assert document["recipient_user_ids"] == ["admin-1", "admin-2"]
    assert "requester_email" not in document
    assert "target_name" not in document
    assert "target_email" not in document


def test_disabled_feature_does_not_accumulate_old_outbox_events(monkeypatch):
    outbox = SimpleNamespace(insert_one=AsyncMock())
    monkeypatch.setattr(notifications, "PUSH_NOTIFICATIONS_ENABLED", False)
    monkeypatch.setattr(notifications, "db", SimpleNamespace(notification_outbox=outbox))

    assert run(notifications.enqueue_financial_event(
        event_key="expense.created:e1",
        event_type="expense.created",
        source_id="e1",
        trip_id="t1",
        actor_user_id="u1",
        target="trip_expenses",
    )) is False
    outbox.insert_one.assert_not_awaited()


def test_invalid_notification_target_is_rejected_before_storage(monkeypatch):
    outbox = SimpleNamespace(insert_one=AsyncMock())
    monkeypatch.setattr(notifications, "PUSH_NOTIFICATIONS_ENABLED", True)
    monkeypatch.setattr(notifications, "db", SimpleNamespace(notification_outbox=outbox))

    assert run(notifications.enqueue_financial_event(
        event_key="expense.created:e1",
        event_type="expense.created",
        source_id="e1",
        trip_id="t1",
        actor_user_id="u1",
        target="https://example.invalid/private",
    )) is False
    outbox.insert_one.assert_not_awaited()


def test_enqueue_failure_is_contained_after_business_write(monkeypatch):
    outbox = SimpleNamespace(insert_one=AsyncMock(side_effect=RuntimeError("database unavailable")))
    monkeypatch.setattr(notifications, "PUSH_NOTIFICATIONS_ENABLED", True)
    monkeypatch.setattr(notifications, "db", SimpleNamespace(notification_outbox=outbox))
    monkeypatch.setattr(notifications.asyncio, "sleep", AsyncMock())

    result = run(notifications.enqueue_financial_event(
        event_key="payment.recorded:p1",
        event_type="payment.recorded",
        source_id="p1",
        trip_id="t1",
        actor_user_id="u1",
        target="settle_up",
    ))

    assert result is False
    assert outbox.insert_one.await_count == 3


def test_enqueue_retries_a_transient_outbox_write_without_duplicate_dispatch(monkeypatch):
    outbox = SimpleNamespace(
        insert_one=AsyncMock(side_effect=[RuntimeError("temporary"), None]),
    )
    background = SimpleNamespace(add_task=Mock())
    monkeypatch.setattr(notifications, "PUSH_NOTIFICATIONS_ENABLED", True)
    monkeypatch.setattr(notifications, "db", SimpleNamespace(notification_outbox=outbox))
    monkeypatch.setattr(notifications.asyncio, "sleep", AsyncMock())

    result = run(notifications.enqueue_notification_event(
        event_type="chat.message.created",
        source_id="m1",
        trip_id="t1",
        actor_user_id="u1",
        background_tasks=background,
    ))

    assert result is True
    assert outbox.insert_one.await_count == 2
    background.add_task.assert_called_once_with(
        notifications.dispatch_outbox_event, "chat.message.created:m1",
    )


def test_delivery_snapshot_uses_current_membership_and_active_android_devices(monkeypatch):
    timestamp = now_utc()
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "actor_user_id": "u1",
        "delivery_snapshot_at": None,
    }
    trips = SimpleNamespace(find_one=AsyncMock(return_value={
        "name": "  Weekend\n in Goa  ",
        "user_ids": ["u1", "u2", "u3"],
    }))
    devices = SimpleNamespace(find=Mock(return_value=FakeCursor([
        {"installation_id": "i2", "user_id": "u2", "token": VALID_TOKEN},
    ])))
    outbox = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        trips=trips, push_devices=devices, notification_outbox=outbox,
    ))

    assert run(notifications._prepare_deliveries(event, timestamp)) is True
    query = devices.find.call_args.args[0]
    assert query["user_id"]["$in"] == ["u2", "u3"]
    assert query["active"] is True and query["platform"] == "android"
    assert [delivery["user_id"] for delivery in event["deliveries"]] == ["u2"]
    assert event["trip_name"] == "Weekend in Goa"
    persisted = outbox.update_one.await_args.args[1]["$set"]
    assert persisted["trip_name"] == "Weekend in Goa"


def test_delivery_snapshot_honors_explicit_request_recipient_outside_trip_membership(monkeypatch):
    timestamp = now_utc()
    event = {
        "event_key": "join.request.rejected:r1",
        "event_type": "join.request.rejected",
        "source_id": "r1",
        "trip_id": "t1",
        "actor_user_id": "admin-1",
        "recipient_user_ids": ["requester-1"],
        "delivery_snapshot_at": None,
    }
    trips = SimpleNamespace(find_one=AsyncMock(return_value={
        "user_ids": ["admin-1", "member-1"],
    }))
    devices = SimpleNamespace(find=Mock(return_value=FakeCursor([{
        "installation_id": "requester-device",
        "user_id": "requester-1",
        "token": VALID_TOKEN,
    }])))
    outbox = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        trips=trips, push_devices=devices, notification_outbox=outbox,
    ))

    assert run(notifications._prepare_deliveries(event, timestamp)) is True
    assert devices.find.call_args.args[0]["user_id"]["$in"] == ["requester-1"]
    assert [delivery["user_id"] for delivery in event["deliveries"]] == ["requester-1"]


def test_delivery_snapshot_deduplicates_tokens_and_skips_incomplete_devices(monkeypatch):
    timestamp = now_utc()
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "actor_user_id": "u1",
        "delivery_snapshot_at": None,
    }
    trips = SimpleNamespace(find_one=AsyncMock(return_value={"user_ids": ["u1", "u2", "u3"]}))
    devices = SimpleNamespace(find=Mock(return_value=FakeCursor([
        {"installation_id": "i2", "user_id": "u2", "token": VALID_TOKEN},
        {"installation_id": "i3", "user_id": "u3", "token": VALID_TOKEN},
        {"installation_id": "missing-token", "user_id": "u2"},
        {"user_id": "u3", "token": "ExpoPushToken[uniquevalidtokenvalue]"},
        {
            "installation_id": "i4", "user_id": "u3",
            "token": "ExpoPushToken[uniquevalidtokenvalue]",
        },
    ])))
    outbox = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        trips=trips, push_devices=devices, notification_outbox=outbox,
    ))

    assert run(notifications._prepare_deliveries(event, timestamp)) is True
    assert [delivery["installation_id"] for delivery in event["deliveries"]] == ["i2", "i4"]


def test_zero_device_snapshot_is_visible_and_completes_without_sending(monkeypatch, caplog):
    caplog.set_level("INFO", logger=notifications.logger.name)
    timestamp = now_utc()
    event = {
        "event_key": "chat.message.created:m1",
        "event_type": "chat.message.created",
        "source_id": "m1",
        "trip_id": "t1",
        "actor_user_id": "u1",
        "delivery_snapshot_at": None,
    }
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        trips=SimpleNamespace(find_one=AsyncMock(return_value={"user_ids": ["u1", "u2"]})),
        push_devices=SimpleNamespace(find=Mock(return_value=FakeCursor([]))),
        notification_outbox=SimpleNamespace(update_one=AsyncMock()),
    ))

    assert run(notifications._prepare_deliveries(event, timestamp)) is True
    run(notifications._finalize_event(event, timestamp))

    assert event["status"] == "complete"
    assert "recipient_count=1 device_count=0" in caplog.text
    assert "delivery_count=0" in caplog.text


def test_send_ticket_and_device_not_registered_receipt(monkeypatch):
    timestamp = now_utc()
    event = {
        "event_key": "payment.recorded:p1",
        "event_type": "payment.recorded",
        "source_id": "p1",
        "trip_id": "t1",
        "target": "settle_up",
        "created_at": timestamp,
        "deliveries": [{
            "installation_id": "i1", "user_id": "u2", "token": VALID_TOKEN,
            "status": "pending", "attempts": 0, "receipt_attempts": 0,
            "next_attempt_at": timestamp,
        }],
    }
    expo_post = AsyncMock(return_value=(200, {"data": [{"status": "ok", "id": "ticket-1"}]}))
    devices = SimpleNamespace(update_one=AsyncMock())
    outbox = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(notifications, "_expo_post", expo_post)
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        push_devices=devices, notification_outbox=outbox,
    ))

    run(notifications._send_due_deliveries(event, timestamp))
    delivery = event["deliveries"][0]
    assert delivery["status"] == "ticketed"
    assert delivery["ticket_id"] == "ticket-1"
    assert delivery["receipt_check_at"] == timestamp + timedelta(minutes=15)

    receipt_time = timestamp + timedelta(minutes=15)
    expo_post.return_value = (200, {"data": {
        "ticket-1": {"status": "error", "details": {"error": "DeviceNotRegistered"}},
    }})
    run(notifications._poll_due_receipts(event, receipt_time))
    assert delivery["status"] == "dead"
    devices.update_one.assert_awaited_once()


@pytest.mark.parametrize("status_code", [401, 403, 429, 500, 503])
def test_retryable_http_failure_uses_bounded_backoff(monkeypatch, status_code):
    timestamp = now_utc()
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "target": "trip_expenses",
        "created_at": timestamp,
        "deliveries": [{
            "installation_id": "i1", "user_id": "u2", "token": VALID_TOKEN,
            "status": "pending", "attempts": 0, "next_attempt_at": timestamp,
        }],
    }
    monkeypatch.setattr(
        notifications, "_expo_post", AsyncMock(return_value=(status_code, None)),
    )
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        notification_outbox=SimpleNamespace(update_one=AsyncMock()),
    ))

    run(notifications._send_due_deliveries(event, timestamp))
    delivery = event["deliveries"][0]
    assert delivery["status"] == "retry"
    assert delivery["attempts"] == 1
    assert delivery["last_error"] == f"expo_http_{status_code}"
    assert delivery["next_attempt_at"] == timestamp + timedelta(minutes=1)


@pytest.mark.parametrize("response", [None, {}, {"data": {}}, {"data": []}])
def test_malformed_expo_ticket_response_is_retried(monkeypatch, response):
    timestamp = now_utc()
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "target": "trip_expenses",
        "created_at": timestamp,
        "deliveries": [{
            "installation_id": "i1", "user_id": "u2", "token": VALID_TOKEN,
            "status": "pending", "attempts": 0, "next_attempt_at": timestamp,
        }],
    }
    monkeypatch.setattr(
        notifications, "_expo_post", AsyncMock(return_value=(200, response)),
    )
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        notification_outbox=SimpleNamespace(update_one=AsyncMock()),
    ))

    run(notifications._send_due_deliveries(event, timestamp))

    delivery = event["deliveries"][0]
    assert delivery["status"] == "retry"
    assert delivery["last_error"] == "malformed_expo_response"
    assert delivery["next_attempt_at"] == timestamp + timedelta(minutes=1)


def test_malformed_individual_expo_ticket_is_retried(monkeypatch):
    timestamp = now_utc()
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "target": "trip_expenses",
        "created_at": timestamp,
        "deliveries": [{
            "installation_id": "i1", "user_id": "u2", "token": VALID_TOKEN,
            "status": "pending", "attempts": 0, "next_attempt_at": timestamp,
        }],
    }
    monkeypatch.setattr(
        notifications, "_expo_post", AsyncMock(return_value=(200, {"data": ["invalid"]})),
    )
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        notification_outbox=SimpleNamespace(update_one=AsyncMock()),
    ))

    run(notifications._send_due_deliveries(event, timestamp))

    assert event["deliveries"][0]["status"] == "retry"
    assert event["deliveries"][0]["last_error"] == "malformed_expo_ticket"


def test_successful_receipt_completes_the_outbox_event(monkeypatch):
    timestamp = now_utc()
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "target": "trip_expenses",
        "deliveries": [{
            "installation_id": "i1", "user_id": "u2", "token": VALID_TOKEN,
            "status": "ticketed", "ticket_id": "ticket-1", "receipt_attempts": 0,
            "receipt_check_at": timestamp, "ticketed_at": timestamp,
        }],
    }
    outbox = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(notifications, "_expo_post", AsyncMock(return_value=(
        200, {"data": {"ticket-1": {"status": "ok"}}},
    )))
    monkeypatch.setattr(notifications, "db", SimpleNamespace(notification_outbox=outbox))

    run(notifications._poll_due_receipts(event, timestamp))
    assert event["deliveries"][0]["status"] == "receipt_ok"
    run(notifications._finalize_event(event, timestamp))
    assert event["status"] == "complete"
    assert event["completed_at"] == timestamp


@pytest.mark.parametrize("status_code", [401, 403, 429, 500, 503])
def test_retryable_receipt_http_failure_uses_bounded_delay(monkeypatch, status_code):
    timestamp = now_utc()
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "deliveries": [{
            "installation_id": "i1", "user_id": "u2", "token": VALID_TOKEN,
            "status": "ticketed", "ticket_id": "ticket-1", "receipt_attempts": 0,
            "receipt_check_at": timestamp, "ticketed_at": timestamp,
        }],
    }
    monkeypatch.setattr(
        notifications, "_expo_post", AsyncMock(return_value=(status_code, None)),
    )
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        notification_outbox=SimpleNamespace(update_one=AsyncMock()),
    ))

    run(notifications._poll_due_receipts(event, timestamp))

    delivery = event["deliveries"][0]
    assert delivery["status"] == "ticketed"
    assert delivery["receipt_attempts"] == 1
    assert delivery["last_error"] == f"expo_receipt_http_{status_code}"
    assert delivery["receipt_check_at"] == timestamp + timedelta(minutes=5)


def test_delayed_receipt_retries_then_finishes_as_unavailable(monkeypatch):
    timestamp = now_utc()
    delivery = {
        "installation_id": "i1", "user_id": "u2", "token": VALID_TOKEN,
        "status": "ticketed", "ticket_id": "ticket-1", "receipt_attempts": 0,
        "receipt_check_at": timestamp, "ticketed_at": timestamp,
    }
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "deliveries": [delivery],
    }
    monkeypatch.setattr(
        notifications, "_expo_post", AsyncMock(return_value=(200, {"data": {}})),
    )
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        notification_outbox=SimpleNamespace(update_one=AsyncMock()),
    ))

    run(notifications._poll_due_receipts(event, timestamp))
    assert delivery["status"] == "ticketed"
    assert delivery["last_error"] == "expo_receipt_not_ready"
    assert delivery["receipt_check_at"] == timestamp + timedelta(minutes=5)

    delivery["receipt_attempts"] = 7
    final_check = timestamp + timedelta(minutes=5)
    run(notifications._poll_due_receipts(event, final_check))
    assert delivery["receipt_attempts"] == 8
    assert delivery["status"] == "receipt_unavailable"
    assert delivery["receipt_check_at"] is None


def test_malformed_receipt_envelope_is_retried(monkeypatch):
    timestamp = now_utc()
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "deliveries": [{
            "installation_id": "i1", "user_id": "u2", "token": VALID_TOKEN,
            "status": "ticketed", "ticket_id": "ticket-1", "receipt_attempts": 0,
            "receipt_check_at": timestamp, "ticketed_at": timestamp,
        }],
    }
    monkeypatch.setattr(
        notifications, "_expo_post", AsyncMock(return_value=(200, {"data": []})),
    )
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        notification_outbox=SimpleNamespace(update_one=AsyncMock()),
    ))

    run(notifications._poll_due_receipts(event, timestamp))

    delivery = event["deliveries"][0]
    assert delivery["status"] == "ticketed"
    assert delivery["last_error"] == "malformed_expo_receipts_response"
    assert delivery["receipt_check_at"] == timestamp + timedelta(minutes=5)


def test_retry_exhaustion_marks_delivery_and_event_dead(monkeypatch):
    timestamp = now_utc()
    event = {
        "event_key": "expense.created:e1",
        "event_type": "expense.created",
        "source_id": "e1",
        "trip_id": "t1",
        "target": "trip_expenses",
        "created_at": timestamp,
        "deliveries": [{
            "installation_id": "i1", "user_id": "u2", "token": VALID_TOKEN,
            "status": "retry", "attempts": 7, "next_attempt_at": timestamp,
        }],
    }
    monkeypatch.setattr(notifications, "_expo_post", AsyncMock(return_value=(429, None)))
    monkeypatch.setattr(notifications, "db", SimpleNamespace(
        notification_outbox=SimpleNamespace(update_one=AsyncMock()),
    ))

    run(notifications._send_due_deliveries(event, timestamp))
    assert event["deliveries"][0]["attempts"] == 8
    assert event["deliveries"][0]["status"] == "dead"
    run(notifications._finalize_event(event, timestamp))
    assert event["status"] == "dead"
    assert event["last_error"] == "all_deliveries_failed"
