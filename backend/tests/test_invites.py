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


def trip_document(**overrides):
    trip = {
        "id": "trip-1",
        "name": "Coast trip",
        "code": "ABC123",
        "invite_generation": 0,
        "owner_id": "owner-1",
        "admin_ids": ["owner-1", "admin-1"],
        "user_ids": ["owner-1", "admin-1", "member-1"],
        "members": [],
    }
    trip.update(overrides)
    return trip


def legacy_invite_document(**overrides):
    timestamp = now_utc()
    document = {
        "id": "legacy-invite-1",
        "trip_id": "trip-1",
        "token_hash": invites.hash_invite_token("x" * 43),
        "revoked_at": None,
        "active": True,
        "audit_expires_at": timestamp + timedelta(days=90),
    }
    document.update(overrides)
    return document


def test_join_payload_requires_exactly_one_credential():
    token = invites.create_signed_invite_token(trip_document())
    assert JoinPreviewRequest(code="ABC123").code == "ABC123"
    assert JoinPreviewRequest(invite_token=token).invite_token == token
    assert JoinRequest(code="ABC123", mode="individual").mode == "individual"

    with pytest.raises(ValidationError):
        JoinPreviewRequest()
    with pytest.raises(ValidationError):
        JoinPreviewRequest(code="ABC123", invite_token=token)


def test_trip_link_is_stable_url_safe_and_changes_only_with_generation(monkeypatch):
    monkeypatch.setattr(invites, "INVITE_BASE_URL", "https://tripsplitter-web.vercel.app")
    trip = trip_document()

    first = invites.current_invite_link(trip)["url"]
    second = invites.current_invite_link({**trip})["url"]
    replacement = invites.current_invite_link({**trip, "invite_generation": 1})["url"]
    token = first.rsplit("/", 1)[1]

    assert first == second
    assert first != replacement
    assert invites.INVITE_TOKEN_PATTERN.fullmatch(token)
    assert invites.decode_signed_invite_token(token) == ("trip-1", 0)
    assert invites.decode_signed_invite_token(token[:-1] + ("A" if token[-1] != "A" else "B")) is None


def test_existing_trip_without_generation_uses_zero():
    trip = trip_document()
    trip.pop("invite_generation")
    token = invites.create_signed_invite_token(trip)

    assert invites.decode_signed_invite_token(token) == ("trip-1", 0)


def test_public_status_exposes_only_active_status_and_trip_name(monkeypatch):
    trip = trip_document()
    token = invites.create_signed_invite_token(trip)
    database = SimpleNamespace(
        trips=SimpleNamespace(find_one=AsyncMock(return_value=trip)),
    )
    monkeypatch.setattr(invites, "db", database)
    monkeypatch.setattr(invites, "INVITE_LINKS_ENABLED", True)

    payload = run(invites.public_invite_status(token))

    assert payload == {"status": "active", "trip_name": "Coast trip"}


def test_reset_generation_makes_previous_link_unusable(monkeypatch):
    token = invites.create_signed_invite_token(trip_document(invite_generation=0))
    database = SimpleNamespace(
        trips=SimpleNamespace(find_one=AsyncMock(return_value=trip_document(invite_generation=1))),
    )
    monkeypatch.setattr(invites, "db", database)
    monkeypatch.setattr(invites, "INVITE_LINKS_ENABLED", True)

    with pytest.raises(HTTPException) as error:
        run(invites.resolve_join_credential(None, token))

    assert error.value.status_code == 410
    assert error.value.detail["code"] == "invite_revoked"


def test_signed_link_resolves_trip_and_returns_invite_marker(monkeypatch):
    trip = trip_document()
    token = invites.create_signed_invite_token(trip)
    monkeypatch.setattr(invites, "INVITE_LINKS_ENABLED", True)
    monkeypatch.setattr(invites, "db", SimpleNamespace(
        trips=SimpleNamespace(find_one=AsyncMock(return_value=trip)),
    ))

    resolved_trip, marker = run(invites.resolve_join_credential(None, token))

    assert resolved_trip == trip
    assert marker == {"kind": "stable_link"}


def test_legacy_token_is_immediately_reported_as_revoked(monkeypatch):
    token = "x" * 43
    monkeypatch.setattr(invites, "INVITE_LINKS_ENABLED", True)
    monkeypatch.setattr(invites, "db", SimpleNamespace(
        trip_invites=SimpleNamespace(find_one=AsyncMock(return_value=legacy_invite_document())),
    ))

    with pytest.raises(HTTPException) as error:
        run(invites.public_invite_status(token))

    assert error.value.status_code == 410
    assert error.value.detail["code"] == "invite_revoked"


def test_invalid_token_remains_not_found(monkeypatch):
    monkeypatch.setattr(invites, "INVITE_LINKS_ENABLED", True)

    with pytest.raises(HTTPException) as error:
        run(invites.public_invite_status("short"))

    assert error.value.status_code == 404
    assert error.value.detail["code"] == "invite_invalid"


def test_member_can_read_the_single_link_and_legacy_create_is_idempotent(monkeypatch):
    trip = trip_document()
    guard = AsyncMock(return_value=trip)
    monkeypatch.setattr(invite_routes, "INVITE_LINKS_ENABLED", True)
    monkeypatch.setattr(invite_routes, "_trip_or_404", guard)
    user = {"id": "member-1", "name": "Member"}

    current = run(invite_routes.get_trip_invite_link("trip-1", user=user))
    compatibility = run(invite_routes.issue_trip_invite("trip-1", user=user))
    history = run(invite_routes.get_trip_invites("trip-1", user=user))

    assert current == compatibility
    assert history == []
    assert guard.await_count == 3


def test_admin_can_reset_and_action_is_audited(monkeypatch):
    trip = trip_document()
    reset = AsyncMock(return_value={"url": "https://example.test/invite/replacement"})
    audit = AsyncMock()
    monkeypatch.setattr(invite_routes, "INVITE_LINKS_ENABLED", True)
    monkeypatch.setattr(invite_routes, "_trip_admin_or_403", AsyncMock(return_value=trip))
    monkeypatch.setattr(invite_routes, "reset_invite_link", reset)
    monkeypatch.setattr(invite_routes, "record_admin_action", audit)
    user = {"id": "admin-1"}

    payload = run(invite_routes.reset_trip_invite_link("trip-1", user=user))

    assert payload == {"url": "https://example.test/invite/replacement"}
    reset.assert_awaited_once_with("trip-1")
    audit.assert_awaited_once_with(
        user,
        "invite.reset",
        trip=trip,
        resource_type="trip_invite",
        resource_id="trip-1",
        changed_fields=("invite_generation",),
    )


def test_regular_member_cannot_reset(monkeypatch):
    reset = AsyncMock()
    monkeypatch.setattr(invite_routes, "INVITE_LINKS_ENABLED", True)
    monkeypatch.setattr(
        invite_routes,
        "_trip_admin_or_403",
        AsyncMock(side_effect=HTTPException(403, "Admin privileges required")),
    )
    monkeypatch.setattr(invite_routes, "reset_invite_link", reset)

    with pytest.raises(HTTPException) as error:
        run(invite_routes.reset_trip_invite_link("trip-1", user={"id": "member-1"}))

    assert error.value.status_code == 403
    reset.assert_not_awaited()


def test_reset_atomically_increments_generation(monkeypatch):
    collection = SimpleNamespace(find_one_and_update=AsyncMock(return_value={
        "id": "trip-1", "invite_generation": 4,
    }))
    monkeypatch.setattr(invites, "db", SimpleNamespace(trips=collection))

    payload = run(invites.reset_invite_link("trip-1"))

    query, mutation = collection.find_one_and_update.await_args.args
    assert query == {"id": "trip-1"}
    assert mutation == {"$inc": {"invite_generation": 1}}
    assert invites.decode_signed_invite_token(payload["url"].rsplit("/", 1)[1]) == ("trip-1", 4)


def test_startup_retires_legacy_rows_once(monkeypatch):
    update = AsyncMock(return_value=SimpleNamespace(modified_count=2))
    monkeypatch.setattr(invites, "db", SimpleNamespace(
        trip_invites=SimpleNamespace(update_many=update),
    ))

    run(invites.retire_legacy_invites())

    query, mutation = update.await_args.args
    changed = mutation["$set"]
    assert query == {"revoked_at": None}
    assert changed["active"] is False
    assert changed["revoked_by"] == "system"
    assert changed["revocation_reason"] == "single_link_migration"
    assert changed["audit_expires_at"] - changed["revoked_at"] == invites.AUDIT_RETENTION


def test_stable_link_use_does_not_create_visible_usage_history(monkeypatch):
    collection = SimpleNamespace(update_one=AsyncMock())
    monkeypatch.setattr(invites, "db", SimpleNamespace(trip_invites=collection))

    run(invites.record_invite_use({"kind": "stable_link"}))

    collection.update_one.assert_not_awaited()


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


def test_trip_deletion_retires_remaining_legacy_rows(monkeypatch):
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
