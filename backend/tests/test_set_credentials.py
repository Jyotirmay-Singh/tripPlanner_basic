# OAuth one-time credential setup (POST /auth/set-credentials) endpoint tests. In-process
# TestClient; the Bearer dependency is overridden to act as a given user and the users
# collection is mocked.
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app  # noqa: E402
import routes.auth as auth_module  # noqa: E402
from utils.deps import get_current_user  # noqa: E402


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def fake_users(monkeypatch):
    # find_one is called AFTER the update to build the response payload.
    users = SimpleNamespace(
        update_one=AsyncMock(return_value=None),
        find_one=AsyncMock(return_value={
            "id": "u-1", "email": "g@gmail.com", "name": "G",
            "role": "user", "email_verified": True, "credentials_set": True,
        }),
    )
    monkeypatch.setattr(auth_module, "db", SimpleNamespace(users=users))
    return users


@pytest.fixture
def as_user():
    def _set(user):
        app.dependency_overrides[get_current_user] = lambda: user
    yield _set
    app.dependency_overrides.pop(get_current_user, None)


GOOGLE_USER = {"id": "u-1", "email": "g@gmail.com", "name": "G",
               "email_verified": True, "credentials_set": False}


# --------------------------------------------------------------------------- #
def test_set_credentials_without_auth_401(client):
    r = client.post("/api/auth/set-credentials", json={"pin": "1234", "password": "password123"})
    assert r.status_code == 401


def test_set_credentials_valid(client, fake_users, as_user):
    as_user(GOOGLE_USER)
    r = client.post("/api/auth/set-credentials", json={"pin": "1234", "password": "password123"})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["credentials_set"] is True
    fake_users.update_one.assert_awaited_once()
    _, update = fake_users.update_one.call_args.args
    assert set(update["$set"].keys()) == {"pin_hash", "password_hash", "credentials_set"}
    assert update["$set"]["credentials_set"] is True


def test_set_credentials_non_digit_pin_422(client, fake_users, as_user):
    # PIN must be exactly 4 chars (Pydantic) — a non-4-length value fails validation (422).
    as_user(GOOGLE_USER)
    r = client.post("/api/auth/set-credentials", json={"pin": "12", "password": "password123"})
    assert r.status_code == 422
    fake_users.update_one.assert_not_called()


def test_set_credentials_non_numeric_pin_400(client, fake_users, as_user):
    # A 4-char but non-numeric PIN passes Pydantic length but fails the isdigit() route check.
    as_user(GOOGLE_USER)
    r = client.post("/api/auth/set-credentials", json={"pin": "abcd", "password": "password123"})
    assert r.status_code == 400
    fake_users.update_one.assert_not_called()


def test_set_credentials_short_password_400(client, fake_users, as_user):
    as_user(GOOGLE_USER)
    r = client.post("/api/auth/set-credentials", json={"pin": "1234", "password": "short"})
    assert r.status_code == 400
    fake_users.update_one.assert_not_called()
