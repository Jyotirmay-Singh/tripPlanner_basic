import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

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
        "created_at": timestamp,
        "expires_at": timestamp + timedelta(days=7),
        "audit_expires_at": timestamp + timedelta(days=97),
        "revoked_at": None,
        "revoked_by": None,
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
    collection = SimpleNamespace(insert_one=AsyncMock())
    monkeypatch.setattr(invites, "db", SimpleNamespace(trip_invites=collection))
    monkeypatch.setattr(invites.secrets, "token_urlsafe", lambda _size: "a" * 43)
    monkeypatch.setattr(invites, "INVITE_BASE_URL", "https://tripsplitter-web.vercel.app")

    payload = run(invites.create_invite({"id": "trip-1", "name": "Coast trip"}, "owner-1"))

    stored = collection.insert_one.await_args.args[0]
    assert stored["token_hash"] == invites.hash_invite_token("a" * 43)
    assert "token" not in stored and "url" not in stored
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


def test_plain_member_cannot_create_or_list_invites(monkeypatch):
    guard = AsyncMock(side_effect=HTTPException(403, "Admin privileges required"))
    create = AsyncMock()
    monkeypatch.setattr(invite_routes, "INVITE_LINKS_ENABLED", True)
    monkeypatch.setattr(invite_routes, "_trip_admin_or_403", guard)
    monkeypatch.setattr(invite_routes, "create_invite", create)

    with pytest.raises(HTTPException) as error:
        run(invite_routes.issue_trip_invite("trip-1", user={"id": "member-1"}))

    assert error.value.status_code == 403
    create.assert_not_awaited()


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
    assert changed["revoked_by"] == "owner-1"
    assert changed["audit_expires_at"] - changed["revoked_at"] == invites.AUDIT_RETENTION
