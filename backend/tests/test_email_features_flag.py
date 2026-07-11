# Tests for the EMAIL_FEATURES_ENABLED "ghost" switch: when the email flows are disabled, register
# auto-verifies + sends nothing, resend-verification/request-password-reset send nothing (but keep
# their generic responses), and GET /api/meta/config reports the flag. In-process FastAPI TestClient
# with the users collection + emailer + token issuer mocked, so every branch runs without Mongo or
# real email. The default-ON behavior is already covered by test_email_verification / test_password_reset.
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app  # noqa: E402
import routes.auth as auth_module  # noqa: E402
import routes.meta as meta_module  # noqa: E402
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
    issue = AsyncMock(return_value="rawtok123")
    send = AsyncMock(return_value=None)
    monkeypatch.setattr(auth_module, "issue_token", issue)
    monkeypatch.setattr(auth_module, "send_email", send)
    return SimpleNamespace(issue=issue, send=send)


@pytest.fixture
def disabled(monkeypatch):
    """Ghost the email features for the route logic."""
    monkeypatch.setattr(auth_module, "EMAIL_FEATURES_ENABLED", False)


@pytest.fixture
def as_user():
    def _set(user):
        app.dependency_overrides[get_current_user] = lambda: user
    yield _set
    app.dependency_overrides.pop(get_current_user, None)


# --------------------------------------------------------------------------- #
# GET /api/meta/config reflects the flag
# --------------------------------------------------------------------------- #
def test_meta_config_reports_enabled(client, monkeypatch):
    monkeypatch.setattr(meta_module, "EMAIL_FEATURES_ENABLED", True)
    r = client.get("/api/meta/config")
    assert r.status_code == 200
    assert r.json() == {"email_features_enabled": True}


def test_meta_config_reports_disabled(client, monkeypatch):
    monkeypatch.setattr(meta_module, "EMAIL_FEATURES_ENABLED", False)
    r = client.get("/api/meta/config")
    assert r.status_code == 200
    assert r.json() == {"email_features_enabled": False}


# --------------------------------------------------------------------------- #
# Disabled: register auto-verifies and sends no verification email
# --------------------------------------------------------------------------- #
def test_register_auto_verified_and_no_email_when_disabled(client, fake_users, patched_email, disabled):
    r = client.post("/api/auth/register", json={
        "email": "ghost@gmail.com", "password": "password123", "pin": "1212", "name": "Ghost",
    })
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email_verified"] is True     # auto-verified, no nag banner
    created = fake_users.insert_one.call_args.args[0]
    assert created["email_verified"] is True
    patched_email.issue.assert_not_called()               # no token issued
    patched_email.send.assert_not_called()                # no email sent (nothing to bounce)


# --------------------------------------------------------------------------- #
# Disabled: resend-verification is a no-op (guards a stale client)
# --------------------------------------------------------------------------- #
def test_resend_verification_noop_when_disabled(client, as_user, patched_email, disabled):
    as_user({"id": "u-1", "email": "u@gmail.com", "name": "U", "email_verified": False})
    r = client.post("/api/auth/resend-verification")
    assert r.status_code == 200
    patched_email.send.assert_not_called()


# --------------------------------------------------------------------------- #
# Disabled: request-password-reset keeps the same generic response, sends nothing
# --------------------------------------------------------------------------- #
def test_request_password_reset_no_send_when_disabled(client, fake_users, patched_email, disabled):
    r = client.post("/api/auth/request-password-reset", json={"email": "someone@gmail.com"})
    assert r.status_code == 200
    assert r.json()["message"] == "If this email exists, a reset link has been sent."
    patched_email.issue.assert_not_called()
    patched_email.send.assert_not_called()
    fake_users.find_one.assert_not_called()               # never even looks up the user