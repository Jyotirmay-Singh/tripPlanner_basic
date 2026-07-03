# Self-service password change (POST /auth/change-password) endpoint tests. In-process
# TestClient; the Bearer dependency is overridden to act as a given user and the users
# collection is mocked. The mocked user doc's password_hash is a REAL hash so verify_secret
# runs genuinely.
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
from utils.security import hash_secret  # noqa: E402


OLD_PASSWORD = "oldpass123"
CURRENT_USER = {"id": "u-1", "email": "u@gmail.com", "name": "U",
                "email_verified": True, "credentials_set": True}


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def fake_users(monkeypatch):
    # find_one returns the FULL doc (incl. password_hash) — the route re-fetches it to verify
    # the current password, since get_current_user strips password_hash.
    users = SimpleNamespace(
        update_one=AsyncMock(return_value=None),
        find_one=AsyncMock(return_value={
            "id": "u-1", "email": "u@gmail.com", "name": "U", "role": "user",
            "password_hash": hash_secret(OLD_PASSWORD),
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


# --------------------------------------------------------------------------- #
def test_change_password_without_auth_401(client):
    r = client.post("/api/auth/change-password",
                    json={"current_password": OLD_PASSWORD, "new_password": "brandnew123"})
    assert r.status_code == 401


def test_change_password_valid(client, fake_users, as_user):
    as_user(CURRENT_USER)
    r = client.post("/api/auth/change-password",
                    json={"current_password": OLD_PASSWORD, "new_password": "brandnew123"})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}
    fake_users.update_one.assert_awaited_once()
    _, update = fake_users.update_one.call_args.args
    assert set(update["$set"].keys()) == {"password_hash"}


def test_change_password_wrong_current_401(client, fake_users, as_user):
    as_user(CURRENT_USER)
    r = client.post("/api/auth/change-password",
                    json={"current_password": "wrongpass99", "new_password": "brandnew123"})
    assert r.status_code == 401
    fake_users.update_one.assert_not_called()


def test_change_password_short_new_400(client, fake_users, as_user):
    as_user(CURRENT_USER)
    r = client.post("/api/auth/change-password",
                    json={"current_password": OLD_PASSWORD, "new_password": "short"})
    assert r.status_code == 400
    fake_users.update_one.assert_not_called()


def test_change_password_same_as_current_400(client, fake_users, as_user):
    as_user(CURRENT_USER)
    r = client.post("/api/auth/change-password",
                    json={"current_password": OLD_PASSWORD, "new_password": OLD_PASSWORD})
    assert r.status_code == 400
    fake_users.update_one.assert_not_called()
