import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError

from models.join import JoinPreviewRequest, JoinRequest
from routes import invites as invite_routes
from services import invites, join_requests
from utils.common import now_utc


def run(awaitable):
    return asyncio.run(awaitable)


def invite_document(**overrides):
    timestamp = now_utc()
    document = {
        "id": "invite-1",
        "trip_id": "trip-1",
        "trip_name": "Coast trip",
        "token_hash": invites.hash_invite_token("x" * 43),
        "created_by": "owner-1",
        "created_by_name": "Owner",
        "created_at": timestamp,
        "expires_at": timestamp + timedelta(days=7),
        "audit_expires_at": timestamp + timedelta(days=97),
        "revoked_at": None,
        "revoked_by": None,
        "revocation_reason": None,
        "active": True,
        "use_count": 0,
        "last_used_at": None,
    }
    document.update(overrides)
    return document


def test_join_payload_requires_exactly_one_credential():
    assert JoinPreviewRequest(code="ABC123").code == "ABC123"
    assert JoinPreviewRequest(invite_token="x" * 43).invite_token == "x" * 43
    assert JoinRequest(code="ABC123", mode="individual").mode == "individual"

    with pytest.raises(ValidationError):
        JoinPreviewRequest()
    with pytest.raises(ValidationError):
        JoinPreviewRequest(code="ABC123", invite_token="x" * 43)


def test_create_invite_stores_only_hash_and_returns_seven_day_link(monkeypatch):
    collection = SimpleNamespace(update_many=AsyncMock(), insert_one=AsyncMock())
    monkeypatch.setattr(invites, "db", SimpleNamespace(trip_invites=collection))
    monkeypatch.setattr(invites.secrets, "token_urlsafe", lambda _size: "a" * 43)
    monkeypatch.setattr(invites, "INVITE_BASE_URL", "https://tripsplitter-web.vercel.app")

    user = {"id": "owner-1", "name": "Ravi", "email": "ravi@gmail.com"}
    payload = run(invites.create_invite({"id": "trip-1", "name": "Coast trip"}, user))

    stored = collection.insert_one.await_args.args[0]
    rotation_query, rotation = collection.update_many.await_args.args
    assert rotation_query == {
        "trip_id": "trip-1", "created_by": "owner-1", "revoked_at": None,
    }
    assert rotation["$set"]["active"] is False
    assert rotation["$set"]["revocation_reason"] == "rotated"
    assert stored["token_hash"] == invites.hash_invite_token("a" * 43)
    assert "token" not in stored and "url" not in stored
    assert stored["active"] is True
    assert stored["created_by_name"] == "Ravi"
    assert stored["expires_at"] - stored["created_at"] == timedelta(days=7)
    assert payload["url"] == f"https://tripsplitter-web.vercel.app/invite/{'a' * 43}"
    assert "token_hash" not in payload


def test_public_status_exposes_no_code_or_roster(monkeypatch):
    document = invite_document()
    database = SimpleNamespace(
        trip_invites=SimpleNamespace(find_one=AsyncMock(return_value=document)),
        trips=SimpleNamespace(find_one=AsyncMock(return_value={"name": "Coast trip"})),
    )
    monkeypatch.setattr(invites, "db", database)
    monkeypatch.setattr(invites, "INVITE_LINKS_ENABLED", True)

    payload = run(invites.public_invite_status("x" * 43))

    assert payload["status"] == "active"
    assert payload["trip_name"] == "Coast trip"
    assert set(payload) == {"status", "trip_name", "expires_at"}


@pytest.mark.parametrize(
    ("overrides", "detail_code"),
    [
        ({"expires_at": now_utc() - timedelta(seconds=1)}, "invite_expired"),
        ({"revoked_at": now_utc(), "revoked_by": "owner-1"}, "invite_revoked"),
    ],
)
def test_join_resolution_rejects_expired_and_revoked_links(monkeypatch, overrides, detail_code):
    document = invite_document(**overrides)
    monkeypatch.setattr(invites, "INVITE_LINKS_ENABLED", True)
    monkeypatch.setattr(invites, "db", SimpleNamespace(
        trip_invites=SimpleNamespace(find_one=AsyncMock(return_value=document)),
        trips=SimpleNamespace(find_one=AsyncMock()),
    ))

    with pytest.raises(HTTPException) as error:
        run(invites.resolve_join_credential(None, "x" * 43))

    assert error.value.status_code == 410
    assert error.value.detail["code"] == detail_code


def test_plain_member_can_create_and_lists_only_their_invites(monkeypatch):
    trip = {
        "id": "trip-1", "owner_id": "owner-1", "admin_ids": ["owner-1"],
        "user_ids": ["owner-1", "member-1"],
    }
    guard = AsyncMock(return_value=trip)
    create = AsyncMock(return_value={"id": "new-invite"})
    listed = AsyncMock(return_value=[])
    monkeypatch.setattr(invite_routes, "INVITE_LINKS_ENABLED", True)
    monkeypatch.setattr(invite_routes, "_trip_or_404", guard)
    monkeypatch.setattr(invite_routes, "create_invite", create)
    monkeypatch.setattr(invite_routes, "list_invites", listed)
    user = {"id": "member-1", "name": "Member"}

    assert run(invite_routes.issue_trip_invite("trip-1", user=user)) == {"id": "new-invite"}
    assert run(invite_routes.get_trip_invites("trip-1", user=user)) == []

    create.assert_awaited_once_with(trip, user)
    listed.assert_awaited_once_with("trip-1", created_by="member-1")


def test_admin_lists_every_creators_invites(monkeypatch):
    trip = {
        "id": "trip-1", "owner_id": "owner-1", "admin_ids": ["owner-1", "admin-1"],
        "user_ids": ["owner-1", "admin-1", "member-1"],
    }
    monkeypatch.setattr(invite_routes, "_trip_or_404", AsyncMock(return_value=trip))
    listed = AsyncMock(return_value=[])
    monkeypatch.setattr(invite_routes, "list_invites", listed)

    run(invite_routes.get_trip_invites("trip-1", user={"id": "admin-1"}))

    listed.assert_awaited_once_with("trip-1", created_by=None)


def test_creator_or_admin_can_revoke_but_other_member_gets_not_found(monkeypatch):
    active = invite_document(created_by="member-1", created_by_name="Member")
    updated = {**active, "active": False, "revoked_at": now_utc(), "revoked_by": "member-1"}
    creator_collection = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value=updated),
        find_one=AsyncMock(),
    )
    monkeypatch.setattr(invites, "db", SimpleNamespace(trip_invites=creator_collection))

    run(invites.revoke_invite("trip-1", "invite-1", "member-1"))

    creator_query = creator_collection.find_one_and_update.await_args.args[0]
    assert creator_query["created_by"] == "member-1"

    admin_collection = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value={**updated, "revoked_by": "admin-1"}),
        find_one=AsyncMock(),
    )
    monkeypatch.setattr(invites, "db", SimpleNamespace(trip_invites=admin_collection))
    run(invites.revoke_invite(
        "trip-1", "invite-1", "admin-1", can_revoke_all=True,
    ))
    admin_query = admin_collection.find_one_and_update.await_args.args[0]
    assert "created_by" not in admin_query

    hidden_collection = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value=None),
        find_one=AsyncMock(return_value=None),
    )
    monkeypatch.setattr(invites, "db", SimpleNamespace(trip_invites=hidden_collection))
    with pytest.raises(HTTPException) as error:
        run(invites.revoke_invite("trip-1", "invite-1", "member-2"))
    assert error.value.status_code == 404
    assert hidden_collection.find_one.await_args.args[0]["created_by"] == "member-2"


def test_concurrent_active_insert_returns_structured_retryable_conflict(monkeypatch):
    collection = SimpleNamespace(
        update_many=AsyncMock(),
        insert_one=AsyncMock(side_effect=DuplicateKeyError("active invite exists")),
    )
    monkeypatch.setattr(invites, "db", SimpleNamespace(trip_invites=collection))

    with pytest.raises(HTTPException) as error:
        run(invites.create_invite(
            {"id": "trip-1", "name": "Coast trip"},
            {"id": "member-1", "name": "Member"},
        ))

    assert error.value.status_code == 409
    assert error.value.detail == {
        "code": "invite_rotation_conflict",
        "message": "Another invite link was created at the same time. Please try sharing again.",
        "retryable": True,
    }


def test_rotation_makes_the_previous_link_unusable(monkeypatch):
    old = invite_document(created_by="member-1")
    collection = SimpleNamespace(update_many=AsyncMock(), insert_one=AsyncMock())
    monkeypatch.setattr(invites, "db", SimpleNamespace(trip_invites=collection))
    run(invites.create_invite(
        {"id": "trip-1", "name": "Coast trip"}, {"id": "member-1", "name": "Member"},
    ))
    old.update(collection.update_many.await_args.args[1]["$set"])

    monkeypatch.setattr(invites, "INVITE_LINKS_ENABLED", True)
    monkeypatch.setattr(invites, "db", SimpleNamespace(
        trip_invites=SimpleNamespace(find_one=AsyncMock(return_value=old)),
        trips=SimpleNamespace(find_one=AsyncMock()),
    ))
    with pytest.raises(HTTPException) as error:
        run(invites.resolve_join_credential(None, "x" * 43))
    assert error.value.detail["code"] == "invite_revoked"


def test_startup_normalizes_legacy_rows_to_one_active_link_per_creator(monkeypatch):
    timestamp = now_utc()
    rows = [
        invite_document(
            id="newest", created_by="member-1", created_at=timestamp,
            expires_at=timestamp + timedelta(days=5), active=None,
        ),
        invite_document(
            id="older", created_by="member-1", created_at=timestamp - timedelta(days=1),
            expires_at=timestamp + timedelta(days=4), active=None,
        ),
        invite_document(
            id="expired", created_by="member-2", created_at=timestamp - timedelta(days=10),
            expires_at=timestamp - timedelta(days=3), active=None,
        ),
    ]

    class Cursor:
        def __init__(self):
            self.index = 0

        def sort(self, _fields):
            return self

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self.index >= len(rows):
                raise StopAsyncIteration
            row = rows[self.index]
            self.index += 1
            return row

    update = AsyncMock()
    collection = SimpleNamespace(find=lambda *_args: Cursor(), update_one=update)
    monkeypatch.setattr(invites, "db", SimpleNamespace(trip_invites=collection))

    run(invites.normalize_invite_active_flags())

    mutations = {
        call.args[0]["id"]: call.args[1]["$set"] for call in update.await_args_list
    }
    assert mutations["newest"] == {"active": True}
    assert mutations["older"]["active"] is False
    assert mutations["older"]["revocation_reason"] == "migration_rotation"
    assert mutations["expired"] == {"active": False}


def test_record_invite_use_updates_only_audit_fields(monkeypatch):
    update = AsyncMock()
    monkeypatch.setattr(invites, "db", SimpleNamespace(
        trip_invites=SimpleNamespace(update_one=update),
    ))

    run(invites.record_invite_use(invite_document()))

    query, mutation = update.await_args.args
    assert query == {"id": "invite-1"}
    assert mutation["$inc"] == {"use_count": 1}
    assert set(mutation["$set"]) == {"last_used_at"}


def test_token_preview_can_suppress_code_from_an_older_code_request():
    payload = join_requests.request_payload({
        "id": "request-1",
        "trip_id": "trip-1",
        "trip_name": "Coast trip",
        "trip_code": "ABC123",
        "invite_id": None,
        "requester_user_id": "user-1",
        "requester_name": "Ravi",
        "requester_email": "ravi@gmail.com",
        "target_kind": "individual",
        "member_id": "member-1",
        "target_name": "Ravi",
        "target_email_before": None,
        "email_relation": "missing",
        "status": "pending",
        "active": True,
        "created_at": now_utc(),
        "updated_at": now_utc(),
        "decided_at": None,
        "rejection_reason": None,
    }, include_code=False)

    assert payload["trip"] == {"id": "trip-1", "name": "Coast trip"}


def test_trip_deletion_revocation_restarts_ninety_day_audit_window(monkeypatch):
    update = AsyncMock(return_value=SimpleNamespace(modified_count=2))
    monkeypatch.setattr(invites, "db", SimpleNamespace(
        trip_invites=SimpleNamespace(update_many=update),
    ))

    run(invites.revoke_trip_invites("trip-1", "owner-1"))

    query, mutation = update.await_args.args
    changed = mutation["$set"]
    assert query == {"trip_id": "trip-1", "revoked_at": None}
    assert changed["active"] is False
    assert changed["revoked_by"] == "owner-1"
    assert changed["revocation_reason"] == "trip_deleted"
    assert changed["audit_expires_at"] - changed["revoked_at"] == invites.AUDIT_RETENTION
