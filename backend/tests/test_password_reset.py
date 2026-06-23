# Forgot-PASSWORD (email link) endpoint tests: request-password-reset (no enumeration) and
# reset-password (token validation, password rules, PIN untouched). In-process TestClient with
# the users collection + token helpers + emailer mocked.
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app  # noqa: E402
import routes.auth as auth_module  # noqa: E402
from utils.auth_tokens import RESET_PASSWORD  # noqa: E402


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def fake_users(monkeypatch):
    users = SimpleNamespace(
        find_one=AsyncMock(return_value=None),
        update_one=AsyncMock(return_value=None),
    )
    monkeypatch.setattr(auth_module, "db", SimpleNamespace(users=users))
    return users


@pytest.fixture
def patched_email(monkeypatch):
    issue = AsyncMock(return_value="rawreset123")
    send = AsyncMock(return_value=None)
    monkeypatch.setattr(auth_module, "issue_token", issue)
    monkeypatch.setattr(auth_module, "send_email", send)
    return SimpleNamespace(issue=issue, send=send)


GENERIC = "If this email exists, a reset link has been sent."


# --------------------------------------------------------------------------- #
def test_request_known_email_issues_reset_and_emails(client, fake_users, patched_email):
    fake_users.find_one.return_value = {"id": "u-1", "email": "real@gmail.com", "name": "Real"}
    r = client.post("/api/auth/request-password-reset", json={"email": "real@gmail.com"})
    assert r.status_code == 200
    assert r.json()["message"] == GENERIC
    assert patched_email.issue.call_args.args[1] == RESET_PASSWORD
    patched_email.send.assert_awaited_once()


def test_request_unknown_email_same_generic_response_no_send(client, fake_users, patched_email):
    fake_users.find_one.return_value = None
    r = client.post("/api/auth/request-password-reset", json={"email": "ghost@gmail.com"})
    assert r.status_code == 200
    assert r.json()["message"] == GENERIC  # identical to the known-email case (no enumeration)
    patched_email.issue.assert_not_called()
    patched_email.send.assert_not_called()


def test_request_non_gmail_rejected(client, fake_users):
    r = client.post("/api/auth/request-password-reset", json={"email": "real@yahoo.com"})
    assert r.status_code == 400
    fake_users.find_one.assert_not_called()


def test_reset_too_short_password_400_and_token_not_consumed(client, fake_users, monkeypatch):
    consume = AsyncMock(return_value="u-1")
    monkeypatch.setattr(auth_module, "consume_token", consume)
    r = client.post("/api/auth/reset-password", json={"token": "t", "new_password": "short"})
    assert r.status_code == 400
    consume.assert_not_called()  # validation happens BEFORE the token is spent
    fake_users.update_one.assert_not_called()


def test_reset_valid_updates_password_only(client, fake_users, monkeypatch):
    monkeypatch.setattr(auth_module, "consume_token", AsyncMock(return_value="u-1"))
    r = client.post("/api/auth/reset-password", json={"token": "good", "new_password": "brandnewpw1"})
    assert r.status_code == 200, r.text
    fake_users.update_one.assert_awaited_once()
    flt, update = fake_users.update_one.call_args.args
    assert flt == {"id": "u-1"}
    assert set(update["$set"].keys()) == {"password_hash"}  # PIN untouched


def test_reset_invalid_token_400(client, fake_users, monkeypatch):
    monkeypatch.setattr(auth_module, "consume_token", AsyncMock(return_value=None))
    r = client.post("/api/auth/reset-password", json={"token": "bad", "new_password": "brandnewpw1"})
    assert r.status_code == 400
    fake_users.update_one.assert_not_called()
