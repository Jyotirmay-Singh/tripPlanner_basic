"""Tests for mandatory local-password setup after first-time Google authentication."""
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


GOOGLE_USER = {
    "id": "u-1", "email": "g@gmail.com", "name": "G",
    "email_verified": True, "credentials_set": False,
}


def test_set_credentials_without_auth_401(client):
    response = client.post("/api/auth/set-credentials", json={"password": "password123"})
    assert response.status_code == 401


def test_set_credentials_valid(client, fake_users, as_user):
    as_user(GOOGLE_USER)
    response = client.post("/api/auth/set-credentials", json={"password": "password123"})
    assert response.status_code == 200, response.text
    assert response.json()["user"]["credentials_set"] is True
    fake_users.update_one.assert_awaited_once()
    _, update = fake_users.update_one.call_args.args
    assert set(update["$set"].keys()) == {"password_hash", "credentials_set"}
    assert update["$set"]["credentials_set"] is True


def test_set_credentials_rejects_retired_pin_field(client, fake_users, as_user):
    as_user(GOOGLE_USER)
    response = client.post(
        "/api/auth/set-credentials",
        json={"password": "password123", "pin": "1234"},
    )
    assert response.status_code == 422
    fake_users.update_one.assert_not_called()


def test_set_credentials_missing_password_422(client, fake_users, as_user):
    as_user(GOOGLE_USER)
    response = client.post("/api/auth/set-credentials", json={})
    assert response.status_code == 422
    fake_users.update_one.assert_not_called()


def test_set_credentials_short_password_400(client, fake_users, as_user):
    as_user(GOOGLE_USER)
    response = client.post("/api/auth/set-credentials", json={"password": "short"})
    assert response.status_code == 400
    fake_users.update_one.assert_not_called()
