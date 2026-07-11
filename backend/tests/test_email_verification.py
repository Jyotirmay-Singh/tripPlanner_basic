# Email-verification endpoint tests (register-sends, verify-email, resend-verification) plus
# the Google-signup auto-verify. In-process FastAPI TestClient with the users collection, the
# token helpers, and the emailer all mocked, so every branch runs without Mongo or real email.
import sys
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app  # noqa: E402
import routes.auth as auth_module  # noqa: E402
from utils.auth_tokens import VERIFY_EMAIL  # noqa: E402
from utils.deps import get_current_user  # noqa: E402


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def fake_users(monkeypatch):
    users = SimpleNamespace(
        find_one=AsyncMock(return_value=None),
        insert_one=AsyncMock(return_value=None),
        update_one=AsyncMock(return_value=None),
    )
    monkeypatch.setattr(auth_module, "db", SimpleNamespace(users=users))
    return users


@pytest.fixture
def patched_email(monkeypatch):
    """Stub the token issuer + emailer so no real token store / Resend send happens."""
    issue = AsyncMock(return_value="rawtok123")
    send = AsyncMock(return_value=None)
    monkeypatch.setattr(auth_module, "issue_token", issue)
    monkeypatch.setattr(auth_module, "send_email", send)
    return SimpleNamespace(issue=issue, send=send)


@pytest.fixture
def as_user():
    """Override the Bearer dependency to act as a given user dict; auto-cleans up."""
    def _set(user):
        app.dependency_overrides[get_current_user] = lambda: user
    yield _set
    app.dependency_overrides.pop(get_current_user, None)


# --------------------------------------------------------------------------- #
def test_register_creates_unverified_user_and_sends_email(client, fake_users, patched_email):
    r = client.post("/api/auth/register", json={
        "email": "newuser@gmail.com", "password": "password123", "pin": "1212", "name": "New User",
    })
    assert r.status_code == 200, r.text
    user = r.json()["user"]
    assert user["email_verified"] is False
    assert user["credentials_set"] is True
    # a verify-email token was issued and an email was sent
    patched_email.issue.assert_awaited_once()
    assert patched_email.issue.call_args.args[1] == VERIFY_EMAIL
    patched_email.send.assert_awaited_once()
    # the persisted doc is unverified too
    created = fake_users.insert_one.call_args.args[0]
    assert created["email_verified"] is False


def test_register_verify_token_has_24h_ttl(client, fake_users, patched_email):
    # The verification link must live for 24h (VERIFY_TTL) — asserted on the TTL handed to issue_token.
    r = client.post("/api/auth/register", json={
        "email": "ttl@gmail.com", "password": "password123", "pin": "1212", "name": "TTL",
    })
    assert r.status_code == 200, r.text
    ttl_arg = patched_email.issue.call_args.args[2]
    assert ttl_arg == auth_module.VERIFY_TTL == timedelta(hours=24)


def test_verify_email_valid_token_marks_verified(client, fake_users, monkeypatch):
    monkeypatch.setattr(auth_module, "consume_token", AsyncMock(return_value="u-1"))
    r = client.post("/api/auth/verify-email", json={"token": "good"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    fake_users.update_one.assert_awaited_once()
    flt, update = fake_users.update_one.call_args.args
    assert flt == {"id": "u-1"}
    assert update == {"$set": {"email_verified": True}}


def test_verify_email_invalid_token_400(client, fake_users, monkeypatch):
    monkeypatch.setattr(auth_module, "consume_token", AsyncMock(return_value=None))
    r = client.post("/api/auth/verify-email", json={"token": "bad"})
    assert r.status_code == 400
    fake_users.update_one.assert_not_called()


def test_verify_email_missing_token_422(client):
    assert client.post("/api/auth/verify-email", json={}).status_code == 422


def test_resend_without_auth_401(client):
    assert client.post("/api/auth/resend-verification").status_code == 401


def test_resend_when_already_verified_is_noop(client, as_user, patched_email):
    as_user({"id": "u-1", "email": "v@gmail.com", "name": "V", "email_verified": True})
    r = client.post("/api/auth/resend-verification")
    assert r.status_code == 200
    patched_email.send.assert_not_called()


def test_resend_rate_limited_429(client, as_user, patched_email, monkeypatch):
    as_user({"id": "u-1", "email": "u@gmail.com", "name": "U", "email_verified": False})
    monkeypatch.setattr(auth_module, "seconds_since_last", AsyncMock(return_value=5))
    r = client.post("/api/auth/resend-verification")
    assert r.status_code == 429
    patched_email.send.assert_not_called()


def test_resend_success_sends_email(client, as_user, patched_email, monkeypatch):
    as_user({"id": "u-1", "email": "u@gmail.com", "name": "U", "email_verified": False})
    monkeypatch.setattr(auth_module, "seconds_since_last", AsyncMock(return_value=None))
    r = client.post("/api/auth/resend-verification")
    assert r.status_code == 200, r.text
    patched_email.send.assert_awaited_once()


def test_resend_just_under_cooldown_429(client, as_user, patched_email, monkeypatch):
    # 59s < RESEND_COOLDOWN_SECONDS (60) -> still rate-limited, no email sent.
    assert auth_module.RESEND_COOLDOWN_SECONDS == 60
    as_user({"id": "u-1", "email": "u@gmail.com", "name": "U", "email_verified": False})
    monkeypatch.setattr(auth_module, "seconds_since_last", AsyncMock(return_value=59))
    r = client.post("/api/auth/resend-verification")
    assert r.status_code == 429
    patched_email.send.assert_not_called()


def test_resend_just_over_cooldown_ok(client, as_user, patched_email, monkeypatch):
    # 61s >= 60 -> cooldown cleared, a fresh verification email is sent.
    as_user({"id": "u-1", "email": "u@gmail.com", "name": "U", "email_verified": False})
    monkeypatch.setattr(auth_module, "seconds_since_last", AsyncMock(return_value=61))
    r = client.post("/api/auth/resend-verification")
    assert r.status_code == 200, r.text
    patched_email.send.assert_awaited_once()


def test_google_signup_is_auto_verified_and_needs_credentials(client, fake_users, patched_email, monkeypatch):
    monkeypatch.setattr(auth_module, "GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setattr(
        auth_module.google_id_token, "verify_oauth2_token",
        lambda *a, **k: {"email": "goog@gmail.com", "name": "Goog"},
    )
    fake_users.find_one.return_value = None
    r = client.post("/api/auth/google", json={"id_token": "good"})
    assert r.status_code == 200, r.text
    user = r.json()["user"]
    assert user["email_verified"] is True
    assert user["credentials_set"] is False
    created = fake_users.insert_one.call_args.args[0]
    assert created["email_verified"] is True and created["credentials_set"] is False
    # Google already verified the address — no verification email is sent
    patched_email.send.assert_not_called()
