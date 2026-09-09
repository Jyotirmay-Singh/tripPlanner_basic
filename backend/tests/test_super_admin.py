import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import BackgroundTasks, HTTPException
from starlette.websockets import WebSocketDisconnect

import server
from config import SUPER_ADMIN_EMAIL
from routes import admin, auth, chat, trips
from services import admin_audit
from utils import deps
from utils.permissions import (
    can_delete_trip,
    can_edit_trip_settings,
    can_manage_admins,
    can_manage_members,
    can_modify_any_expense,
    can_record_payment,
    can_transfer_ownership,
    can_view,
    is_super_admin,
    role_of,
)


SUPER_ADMIN = {
    "id": "application-admin-id",
    "email": SUPER_ADMIN_EMAIL,
    "role": "super_admin",
}
TRIP = {
    "id": "trip-1",
    "name": "Client retreat",
    "owner_id": "owner-1",
    "admin_ids": ["owner-1"],
    "user_ids": ["owner-1", "member-1"],
    "members": [{"id": "member-row", "kind": "individual", "user_id": "member-1"}],
}


def run(awaitable):
    return asyncio.run(awaitable)


@pytest.mark.parametrize(
    "viewer",
    [
        {"id": "x", "email": f"{SUPER_ADMIN_EMAIL}.evil", "role": "super_admin"},
        {"id": "x", "email": "jyotirmaysingh03+ops@gmail.com", "role": "super_admin"},
        {"id": "x", "email": SUPER_ADMIN_EMAIL, "role": "admin"},
        {"id": "x", "email": "someone@gmail.com", "role": "super_admin"},
        SUPER_ADMIN_EMAIL,
        None,
    ],
)
def test_only_exact_promoted_identity_is_super_admin(viewer):
    assert is_super_admin(viewer) is False


def test_super_admin_has_every_trip_scoped_capability_without_membership():
    assert is_super_admin(SUPER_ADMIN) is True
    assert role_of(TRIP, SUPER_ADMIN) == "super_admin"
    for capability in (
        can_view,
        can_manage_members,
        can_edit_trip_settings,
        can_modify_any_expense,
        can_manage_admins,
        can_transfer_ownership,
        can_delete_trip,
    ):
        assert capability(TRIP, SUPER_ADMIN) is True
    assert can_record_payment(TRIP, "member-row", SUPER_ADMIN) is True


def test_auth_payload_exposes_only_server_verified_super_admin_status():
    privileged = {**SUPER_ADMIN, "name": "Admin"}
    spoofed = {**privileged, "email": "someone@gmail.com"}

    assert auth._user_payload(privileged)["is_super_admin"] is True
    assert auth._user_payload(spoofed)["is_super_admin"] is False


def test_trip_guard_allows_super_admin_but_still_rejects_normal_outsider(monkeypatch):
    collection = SimpleNamespace(find_one=AsyncMock(return_value=TRIP))
    monkeypatch.setattr(deps, "db", SimpleNamespace(trips=collection))

    assert run(deps._trip_or_404("trip-1", SUPER_ADMIN)) == TRIP
    with pytest.raises(HTTPException) as error:
        run(deps._trip_or_404(
            "trip-1", {"id": "outsider", "email": "outsider@gmail.com", "role": "admin"}
        ))
    assert error.value.status_code == 403


def test_admin_dependency_rejects_non_super_users():
    with pytest.raises(HTTPException) as error:
        run(deps.require_super_admin(
            user={"id": "trip-admin", "email": "tripadmin@gmail.com", "role": "admin"}
        ))
    assert error.value.status_code == 403
    assert run(deps.require_super_admin(user=SUPER_ADMIN)) == SUPER_ADMIN


def test_startup_promotion_preserves_existing_credentials(monkeypatch):
    existing = {
        "id": SUPER_ADMIN["id"],
        "email": SUPER_ADMIN_EMAIL,
        "role": "user",
        "password_hash": "keep-password-hash",
        "google_subject": "keep-google-subject",
        "credentials_set": False,
    }
    users = SimpleNamespace(
        find_one=AsyncMock(return_value=existing),
        insert_one=AsyncMock(),
        update_one=AsyncMock(),
    )
    monkeypatch.setattr(server, "db", SimpleNamespace(users=users))

    run(server._ensure_super_admin())

    users.insert_one.assert_not_awaited()
    users.update_one.assert_awaited_once_with(
        {"id": SUPER_ADMIN["id"]},
        {"$set": {"role": "super_admin", "email_verified": True}},
    )
    update = users.update_one.await_args.args[1]["$set"]
    assert "password_hash" not in update
    assert "google_subject" not in update
    assert "credentials_set" not in update


def test_startup_seeds_fixed_admin_only_when_missing(monkeypatch):
    users = SimpleNamespace(
        find_one=AsyncMock(return_value=None),
        insert_one=AsyncMock(),
        update_one=AsyncMock(),
    )
    monkeypatch.setattr(server, "db", SimpleNamespace(users=users))
    monkeypatch.setattr(server, "hash_secret", lambda value: f"hashed:{value}")
    monkeypatch.setenv("ADMIN_PASSWORD", "configured-secret")

    run(server._ensure_super_admin())

    inserted = users.insert_one.await_args.args[0]
    assert inserted["email"] == SUPER_ADMIN_EMAIL
    assert inserted["role"] == "super_admin"
    assert inserted["password_hash"] == "hashed:configured-secret"
    users.update_one.assert_not_awaited()


def test_startup_refuses_to_seed_a_global_admin_with_no_password(monkeypatch):
    users = SimpleNamespace(
        find_one=AsyncMock(return_value=None),
        insert_one=AsyncMock(),
        update_one=AsyncMock(),
    )
    monkeypatch.setattr(server, "db", SimpleNamespace(users=users))
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)

    with pytest.raises(RuntimeError, match="ADMIN_PASSWORD is required"):
        run(server._ensure_super_admin())
    users.insert_one.assert_not_awaited()


def test_admin_audit_is_append_only_and_value_free(monkeypatch):
    insert_one = AsyncMock()
    monkeypatch.setattr(
        admin_audit,
        "db",
        SimpleNamespace(admin_audit_logs=SimpleNamespace(insert_one=insert_one)),
    )

    run(admin_audit.record_admin_action(
        SUPER_ADMIN,
        "expense.updated",
        trip=TRIP,
        resource_type="expense",
        resource_id="expense-1",
        changed_fields=("description", "amount", "description"),
    ))

    insert_one.assert_awaited_once()
    event = insert_one.await_args.args[0]
    assert event["actor_email"] == SUPER_ADMIN_EMAIL
    assert event["trip_id"] == "trip-1"
    assert event["changed_fields"] == ["amount", "description"]
    assert "request" not in event
    assert "values" not in event


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _limit):
        return list(self.rows)


def test_admin_trip_overview_returns_cursor_page_and_summary_pipeline(monkeypatch):
    aggregate = MagicMock(side_effect=[
        FakeCursor([{"count": 2}]),
        FakeCursor([
            {"id": "trip-2", "created_at": "2026-09-09T10:00:00Z", "name": "Two"},
            {"id": "trip-1", "created_at": "", "name": "Legacy"},
        ]),
    ])
    monkeypatch.setattr(admin, "db", SimpleNamespace(trips=SimpleNamespace(aggregate=aggregate)))

    page = run(admin.list_all_trips(query="", limit=1, cursor=None, _admin=SUPER_ADMIN))

    assert page["total"] == 2
    assert [item["id"] for item in page["items"]] == ["trip-2"]
    assert admin._decode_cursor(page["next_cursor"]) == (
        "2026-09-09T10:00:00Z", "trip-2",
    )
    data_pipeline = aggregate.call_args_list[1].args[0]
    assert any("$lookup" in stage and stage["$lookup"].get("from") == "expenses"
               for stage in data_pipeline)
    assert {"$sort": {"_admin_created_at": -1, "id": -1}} in data_pipeline


def test_trip_deletion_cleans_all_related_live_collections(monkeypatch):
    collection_names = (
        "trips",
        "expenses",
        "settlements",
        "payments",
        "join_requests",
        "notification_outbox",
        "chat_messages",
        "chat_reads",
        "chat_counters",
    )
    collections = {
        name: SimpleNamespace(delete_one=AsyncMock(), delete_many=AsyncMock())
        for name in collection_names
    }
    monkeypatch.setattr(trips, "db", SimpleNamespace(**collections))
    monkeypatch.setattr(trips, "_trip_owner_or_403", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(trips, "revoke_trip_invites", AsyncMock())
    monkeypatch.setattr(trips, "delete_receipts_for_trip", AsyncMock())
    disconnect = AsyncMock()
    monkeypatch.setattr(trips, "chat_connections", SimpleNamespace(disconnect_trip=disconnect))
    audit = AsyncMock()
    monkeypatch.setattr(trips, "record_admin_action", audit)

    assert run(trips.delete_trip("trip-1", user=SUPER_ADMIN)) == {"ok": True}

    collections["trips"].delete_one.assert_awaited_once_with({"id": "trip-1"})
    for name in collection_names[1:]:
        collections[name].delete_many.assert_awaited_once_with({"trip_id": "trip-1"})
    trips.revoke_trip_invites.assert_awaited_once_with("trip-1", SUPER_ADMIN["id"])
    trips.delete_receipts_for_trip.assert_awaited_once_with("trip-1")
    disconnect.assert_awaited_once_with("trip-1")
    audit.assert_awaited_once()


def test_super_admin_can_moderate_another_users_chat_message(monkeypatch):
    stored = {
        "id": "message-1",
        "trip_id": "trip-1",
        "sequence": 1,
        "sender_user_id": "member-1",
        "sender_name": "Member",
        "text": "Original",
        "deleted_at": None,
    }
    updated = {**stored, "text": "Moderated", "edited_at": "2026-09-09T10:00:00Z"}
    find_one_and_update = AsyncMock(return_value=updated)
    monkeypatch.setattr(
        chat,
        "db",
        SimpleNamespace(chat_messages=SimpleNamespace(find_one_and_update=find_one_and_update)),
    )
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(chat, "_message_or_404", AsyncMock(return_value=stored))
    monkeypatch.setattr(chat, "_broadcast", AsyncMock())
    audit = AsyncMock()
    monkeypatch.setattr(chat, "record_admin_action", audit)

    result = run(chat.update_chat_message(
        "trip-1", "message-1", chat.ChatMessagePatch(text="Moderated"), user=SUPER_ADMIN,
    ))

    assert result["text"] == "Moderated"
    update_filter = find_one_and_update.await_args.args[0]
    assert "sender_user_id" not in update_filter
    audit.assert_awaited_once()


def test_nonmember_super_admin_chat_uses_privileged_sender_identity(monkeypatch):
    messages = SimpleNamespace(
        find_one=AsyncMock(return_value=None),
        insert_one=AsyncMock(),
        delete_one=AsyncMock(),
    )
    counters = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value={"latest_sequence": 4})
    )
    monkeypatch.setattr(
        chat,
        "db",
        SimpleNamespace(chat_messages=messages, chat_counters=counters),
    )
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(
        chat,
        "_chat_state",
        AsyncMock(return_value={"latest_sequence": 4, "cleared_through_sequence": 0}),
    )
    monkeypatch.setattr(chat, "_broadcast", AsyncMock())
    monkeypatch.setattr(chat, "enqueue_notification_event", AsyncMock())
    audit = AsyncMock()
    monkeypatch.setattr(chat, "record_admin_action", audit)

    result = run(chat.create_chat_message(
        "trip-1",
        chat.ChatMessageCreate(
            client_message_id="12345678-1234-5678-1234-567812345678",
            text="Administrative notice",
        ),
        BackgroundTasks(),
        user=SUPER_ADMIN,
    ))

    stored = messages.insert_one.await_args.args[0]
    assert stored["sender_name"] == "Application Admin"
    assert stored["sender_person_id"] == f"application-admin:{SUPER_ADMIN['id']}"
    assert result["sender_name"] == "Application Admin"
    audit.assert_awaited_once()


class AdminAuthSocket:
    def __init__(self):
        self.frames = [{"type": "auth", "token": "jwt"}]
        self.sent = []
        self.closed = []

    async def accept(self):
        return None

    async def receive_json(self):
        if self.frames:
            return self.frames.pop(0)
        raise WebSocketDisconnect()

    async def send_json(self, event):
        self.sent.append(event)

    async def close(self, code):
        self.closed.append(code)


def test_nonmember_super_admin_can_open_privileged_chat_websocket(monkeypatch):
    socket = AdminAuthSocket()
    manager = SimpleNamespace(connect=AsyncMock(), disconnect=AsyncMock())
    users = SimpleNamespace(find_one=AsyncMock(return_value=SUPER_ADMIN))
    trips_collection = SimpleNamespace(
        find_one=AsyncMock(return_value={"id": "trip-1", "user_ids": ["owner-1"]})
    )
    monkeypatch.setattr(chat, "db", SimpleNamespace(users=users, trips=trips_collection))
    monkeypatch.setattr(chat, "decode_token", lambda _token: {"sub": SUPER_ADMIN["id"]})
    monkeypatch.setattr(chat, "chat_connections", manager)

    run(chat.chat_websocket(socket, "trip-1"))

    assert socket.sent == [{"type": "ready"}]
    manager.connect.assert_awaited_once_with(
        "trip-1", SUPER_ADMIN["id"], socket, privileged=True,
    )
    manager.disconnect.assert_awaited_once_with("trip-1", socket)
