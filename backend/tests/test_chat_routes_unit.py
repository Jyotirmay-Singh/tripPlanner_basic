import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import BackgroundTasks, HTTPException
from pymongo.errors import DuplicateKeyError

from models.chat import ChatMessageCreate, ChatMessagePatch
from routes import chat
from services.chat_realtime import ChatConnectionManager
from starlette.websockets import WebSocketDisconnect


TRIP = {
    "id": "t1",
    "owner_id": "u1",
    "user_ids": ["u1", "u2"],
    "members": [
        {"id": "p1", "name": "Owner", "kind": "individual", "user_id": "u1"},
        {"id": "p2", "name": "Friend", "kind": "individual", "user_id": "u2"},
    ],
}


def run(awaitable):
    return asyncio.run(awaitable)


def test_create_persists_before_broadcast_and_snapshots_sender(monkeypatch):
    messages = SimpleNamespace(
        find_one=AsyncMock(return_value=None),
        insert_one=AsyncMock(return_value=SimpleNamespace(inserted_id="mongo")),
        delete_one=AsyncMock(),
    )
    counters = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value={"latest_sequence": 7})
    )
    monkeypatch.setattr(chat, "db", SimpleNamespace(chat_messages=messages, chat_counters=counters))
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(
        chat,
        "_chat_state",
        AsyncMock(return_value={"latest_sequence": 7, "cleared_through_sequence": 0}),
    )
    broadcast = AsyncMock()
    enqueue = AsyncMock()
    monkeypatch.setattr(chat, "_broadcast", broadcast)
    monkeypatch.setattr(chat, "enqueue_notification_event", enqueue)
    background = BackgroundTasks()

    result = run(chat.create_chat_message(
        "t1",
        ChatMessageCreate(
            client_message_id="12345678-1234-5678-1234-567812345678",
            text="Meet in the lobby",
        ),
        background,
        user={"id": "u1"},
    ))

    stored = messages.insert_one.await_args.args[0]
    assert stored["sequence"] == 7
    assert stored["sender_name"] == "Owner"
    assert stored["text"] == "Meet in the lobby"
    assert result["id"] == stored["id"]
    assert messages.insert_one.await_count == 1
    enqueue.assert_awaited_once_with(
        event_type="chat.message.created",
        source_id=stored["id"],
        trip_id="t1",
        actor_user_id="u1",
        background_tasks=background,
    )
    assert broadcast.await_count == 1


def test_clear_history_race_removes_message_without_notification(monkeypatch):
    messages = SimpleNamespace(
        find_one=AsyncMock(return_value=None),
        insert_one=AsyncMock(return_value=SimpleNamespace(inserted_id="mongo")),
        delete_one=AsyncMock(),
    )
    counters = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value={"latest_sequence": 7})
    )
    monkeypatch.setattr(chat, "db", SimpleNamespace(
        chat_messages=messages, chat_counters=counters,
    ))
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(
        chat,
        "_chat_state",
        AsyncMock(return_value={"latest_sequence": 7, "cleared_through_sequence": 7}),
    )
    enqueue = AsyncMock()
    broadcast = AsyncMock()
    monkeypatch.setattr(chat, "enqueue_notification_event", enqueue)
    monkeypatch.setattr(chat, "_broadcast", broadcast)

    with pytest.raises(HTTPException) as error:
        run(chat.create_chat_message(
            "t1",
            ChatMessageCreate(
                client_message_id="12345678-1234-5678-1234-567812345678",
                text="Do not resurrect this message",
            ),
            BackgroundTasks(),
            user={"id": "u1"},
        ))

    assert error.value.status_code == 409
    messages.delete_one.assert_awaited_once()
    enqueue.assert_not_awaited()
    broadcast.assert_not_awaited()


def test_idempotent_retry_returns_existing_without_allocating_sequence(monkeypatch):
    existing = {
        "id": "m1", "client_message_id": "12345678-1234-5678-1234-567812345678",
        "trip_id": "t1", "sequence": 2, "sender_user_id": "u1", "sender_person_id": "p1",
        "sender_name": "Owner", "text": "Already stored", "created_at": "now",
    }
    messages = SimpleNamespace(find_one=AsyncMock(return_value=existing))
    counters = SimpleNamespace(find_one_and_update=AsyncMock())
    monkeypatch.setattr(chat, "db", SimpleNamespace(chat_messages=messages, chat_counters=counters))
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    enqueue = AsyncMock()
    monkeypatch.setattr(chat, "enqueue_notification_event", enqueue)

    result = run(chat.create_chat_message(
        "t1",
        ChatMessageCreate(
            client_message_id="12345678-1234-5678-1234-567812345678", text="Already stored"
        ),
        BackgroundTasks(),
        user={"id": "u1"},
    ))
    assert result["id"] == "m1"
    counters.find_one_and_update.assert_not_awaited()
    enqueue.assert_not_awaited()


def test_concurrent_idempotent_retry_handles_only_duplicate_key(monkeypatch):
    existing = {
        "id": "m1", "client_message_id": "12345678-1234-5678-1234-567812345678",
        "trip_id": "t1", "sequence": 2, "sender_user_id": "u1", "sender_person_id": "p1",
        "sender_name": "Owner", "text": "Already stored", "created_at": "now",
    }
    messages = SimpleNamespace(
        find_one=AsyncMock(side_effect=[None, existing]),
        insert_one=AsyncMock(side_effect=DuplicateKeyError("duplicate retry")),
    )
    counters = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value={"latest_sequence": 3})
    )
    monkeypatch.setattr(chat, "db", SimpleNamespace(chat_messages=messages, chat_counters=counters))
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    enqueue = AsyncMock()
    monkeypatch.setattr(chat, "enqueue_notification_event", enqueue)

    result = run(chat.create_chat_message(
        "t1",
        ChatMessageCreate(
            client_message_id="12345678-1234-5678-1234-567812345678", text="Already stored"
        ),
        BackgroundTasks(),
        user={"id": "u1"},
    ))

    assert result["id"] == "m1"
    messages.insert_one.assert_awaited_once()
    enqueue.assert_not_awaited()


def test_only_sender_can_edit_or_delete(monkeypatch):
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(chat, "_message_or_404", AsyncMock(return_value={
        "id": "m1", "trip_id": "t1", "sequence": 1, "sender_user_id": "u1",
        "sender_name": "Owner", "text": "Original", "deleted_at": None,
    }))

    with pytest.raises(HTTPException) as edit_error:
        run(chat.update_chat_message(
            "t1", "m1", ChatMessagePatch(text="Changed"), user={"id": "u2"}
        ))
    assert edit_error.value.status_code == 403

    with pytest.raises(HTTPException) as delete_error:
        run(chat.delete_chat_message("t1", "m1", user={"id": "u2"}))
    assert delete_error.value.status_code == 403


def test_edit_does_not_broadcast_stale_text_when_delete_wins_race(monkeypatch):
    stored = {
        "id": "m1", "trip_id": "t1", "sequence": 1, "sender_user_id": "u1",
        "sender_name": "Owner", "text": "Original", "deleted_at": None,
    }
    tombstone = {**stored, "text": None, "deleted_at": "2026-08-22T10:00:00Z"}
    messages = SimpleNamespace(find_one_and_update=AsyncMock(return_value=None))
    monkeypatch.setattr(chat, "db", SimpleNamespace(chat_messages=messages))
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(chat, "_message_or_404", AsyncMock(side_effect=[stored, tombstone]))
    broadcast = AsyncMock()
    monkeypatch.setattr(chat, "_broadcast", broadcast)

    with pytest.raises(HTTPException) as error:
        run(chat.update_chat_message(
            "t1", "m1", ChatMessagePatch(text="Changed"), user={"id": "u1"}
        ))

    assert error.value.status_code == 409
    broadcast.assert_not_awaited()


def test_delete_unsets_original_text_and_broadcasts_tombstone(monkeypatch):
    stored = {
        "id": "m1", "trip_id": "t1", "sequence": 1, "sender_user_id": "u1",
        "sender_name": "Owner", "text": "Remove me", "deleted_at": None,
    }
    messages = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(chat, "db", SimpleNamespace(chat_messages=messages))
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(chat, "_message_or_404", AsyncMock(return_value=stored))
    broadcast = AsyncMock()
    monkeypatch.setattr(chat, "_broadcast", broadcast)

    result = run(chat.delete_chat_message("t1", "m1", user={"id": "u1"}))
    update = messages.update_one.await_args.args[1]
    assert update["$unset"] == {"text": ""}
    assert result["text"] is None
    assert result["deleted_at"]
    assert broadcast.await_args.args[1]["type"] == "message.updated"


class FakeSocket:
    def __init__(self):
        self.sent = []
        self.closed = []

    async def send_json(self, event):
        self.sent.append(event)

    async def close(self, code):
        self.closed.append(code)


def test_realtime_manager_prunes_revoked_members():
    async def scenario():
        manager = ChatConnectionManager()
        allowed = FakeSocket()
        revoked = FakeSocket()
        await manager.connect("t1", "u1", allowed)
        await manager.connect("t1", "u2", revoked)
        await manager.broadcast("t1", {"type": "ready"}, ["u1"])
        return allowed, revoked

    allowed, revoked = run(scenario())
    assert allowed.sent == [{"type": "ready"}]
    assert revoked.sent == []
    assert revoked.closed == [4403]


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *_args):
        return self

    def limit(self, *_args):
        return self

    async def to_list(self, _limit):
        return list(self.rows)


def test_history_is_chronological_and_exposes_clear_boundary(monkeypatch):
    rows = [
        {"id": "m3", "trip_id": "t1", "sequence": 3, "sender_name": "Owner", "text": "3"},
        {"id": "m2", "trip_id": "t1", "sequence": 2, "sender_name": "Owner", "text": "2"},
    ]
    messages = SimpleNamespace(find=lambda *_args, **_kwargs: FakeCursor(rows))
    monkeypatch.setattr(chat, "db", SimpleNamespace(chat_messages=messages))
    monkeypatch.setattr(chat, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(
        chat, "_chat_state",
        AsyncMock(return_value={"latest_sequence": 3, "cleared_through_sequence": 1}),
    )

    result = run(chat.list_chat_messages(
        "t1", before_sequence=None, after_sequence=None, limit=50, user={"id": "u1"}
    ))
    assert [message["sequence"] for message in result["items"]] == [2, 3]
    assert result["cleared_through_sequence"] == 1


class AuthSocket:
    def __init__(self, frames):
        self.frames = list(frames)
        self.sent = []
        self.closed = []
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def receive_json(self):
        if not self.frames:
            raise WebSocketDisconnect()
        frame = self.frames.pop(0)
        if isinstance(frame, Exception):
            raise frame
        return frame

    async def send_json(self, event):
        self.sent.append(event)

    async def close(self, code):
        self.closed.append(code)


def test_websocket_authenticates_in_first_frame_without_url_token(monkeypatch):
    socket = AuthSocket([{"type": "auth", "token": "jwt"}])
    manager = SimpleNamespace(connect=AsyncMock(), disconnect=AsyncMock())
    users = SimpleNamespace(find_one=AsyncMock(return_value={"id": "u1"}))
    trips = SimpleNamespace(find_one=AsyncMock(return_value={"id": "t1", "user_ids": ["u1"]}))
    monkeypatch.setattr(chat, "db", SimpleNamespace(users=users, trips=trips))
    monkeypatch.setattr(chat, "decode_token", lambda token: {"sub": "u1"})
    monkeypatch.setattr(chat, "chat_connections", manager)

    run(chat.chat_websocket(socket, "t1"))
    assert socket.accepted
    assert socket.sent == [{"type": "ready"}]
    manager.connect.assert_awaited_once_with("t1", "u1", socket)
    manager.disconnect.assert_awaited_once_with("t1", socket)


def test_websocket_rejects_missing_auth_frame(monkeypatch):
    socket = AuthSocket([{"type": "ping"}])
    run(chat.chat_websocket(socket, "t1"))
    assert socket.closed == [4401]


def test_websocket_rejects_invalid_auth_without_logging_token(monkeypatch, caplog):
    token = "sensitive-invalid-token"
    socket = AuthSocket([{"type": "auth", "token": token}])

    def reject_token(_token):
        raise HTTPException(401, "Invalid token")

    monkeypatch.setattr(chat, "decode_token", reject_token)
    caplog.set_level("WARNING", logger="trip-splitter")
    run(chat.chat_websocket(socket, "t1"))

    assert socket.closed == [4401]
    assert "reason=invalid_auth" in caplog.text
    assert token not in caplog.text


def test_websocket_stops_with_permission_denied_for_non_member(monkeypatch):
    socket = AuthSocket([{"type": "auth", "token": "jwt"}])
    users = SimpleNamespace(find_one=AsyncMock(return_value={"id": "u3"}))
    trips = SimpleNamespace(find_one=AsyncMock(return_value={"id": "t1", "user_ids": ["u1"]}))
    monkeypatch.setattr(chat, "db", SimpleNamespace(users=users, trips=trips))
    monkeypatch.setattr(chat, "decode_token", lambda _token: {"sub": "u3"})

    run(chat.chat_websocket(socket, "t1"))

    assert socket.closed == [4403]
