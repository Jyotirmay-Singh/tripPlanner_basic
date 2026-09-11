from datetime import datetime, timedelta
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app  # noqa: E402
from models.auth import UpiProfileUpdate  # noqa: E402
import routes.auth as auth_module  # noqa: E402
from utils.deps import get_current_user  # noqa: E402
from utils.upi_rules import normalize_upi_id  # noqa: E402


CURRENT_USER = {
    "id": "u-1",
    "email": "owner@gmail.com",
    "name": "Owner",
    "role": "user",
    "email_verified": True,
    "credentials_set": True,
}


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def fake_users(monkeypatch):
    users = SimpleNamespace(
        update_one=AsyncMock(return_value=None),
        find_one=AsyncMock(return_value=dict(CURRENT_USER)),
    )
    monkeypatch.setattr(auth_module, "db", SimpleNamespace(users=users))
    return users


@pytest.fixture
def as_user():
    def _set(user):
        app.dependency_overrides[get_current_user] = lambda: dict(user)

    yield _set
    app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.parametrize("value, expected", [
    ("ab@upi", "ab@upi"),
    ("  Ab.C_2-X@OkSbi  ", "Ab.C_2-X@OkSbi"),
    (f"{'a' * 256}@{'B' * 64}", f"{'a' * 256}@{'B' * 64}"),
])
def test_upi_normalization_accepts_common_vpa_shape(value, expected):
    assert normalize_upi_id(value) == expected


@pytest.mark.parametrize("value", [
    "",
    "   ",
    "a@upi",
    "ab@u",
    "abupi",
    "ab@@upi",
    "a b@upi",
    "ab@up i",
    "ab+tag@upi",
    "नमस्ते@upi",
    "ab@upi\n",
    "\tab@upi",
    f"{'a' * 257}@upi",
    f"ab@{'b' * 65}",
])
def test_upi_normalization_rejects_malformed_values(value):
    with pytest.raises(ValueError, match="valid UPI ID"):
        normalize_upi_id(value)


def test_update_model_requires_field_but_allows_explicit_null():
    with pytest.raises(ValidationError):
        UpiProfileUpdate()
    assert UpiProfileUpdate(upi_id=None).upi_id is None


def test_update_upi_requires_authentication(client):
    response = client.patch("/api/auth/me", json={"upi_id": "owner@upi"})
    assert response.status_code == 401


def test_me_stabilizes_missing_upi_fields_as_null(client, as_user):
    as_user(CURRENT_USER)
    response = client.get("/api/auth/me")
    assert response.status_code == 200
    assert response.json()["upi_id"] is None
    assert response.json()["upi_updated_at"] is None


def test_auth_payload_stabilizes_missing_upi_fields_as_null():
    payload = auth_module._user_payload(CURRENT_USER)
    assert payload["upi_id"] is None
    assert payload["upi_updated_at"] is None


def test_update_upi_trims_preserves_case_and_sets_utc_timestamp(
    client, fake_users, as_user,
):
    as_user(CURRENT_USER)
    fake_users.find_one.return_value = {
        **CURRENT_USER,
        "upi_id": "Owner.Pay_2-X@OkSbi",
        "upi_updated_at": "2026-09-11T10:00:00+00:00",
    }

    response = client.patch(
        "/api/auth/me", json={"upi_id": "  Owner.Pay_2-X@OkSbi  "},
    )

    assert response.status_code == 200, response.text
    assert response.json()["upi_id"] == "Owner.Pay_2-X@OkSbi"
    fake_users.update_one.assert_awaited_once()
    update_filter, update = fake_users.update_one.await_args.args
    assert update_filter == {"id": CURRENT_USER["id"]}
    assert update["$set"]["upi_id"] == "Owner.Pay_2-X@OkSbi"
    timestamp = datetime.fromisoformat(update["$set"]["upi_updated_at"])
    assert timestamp.utcoffset() == timedelta(0)


def test_exact_normalized_value_is_an_idempotent_noop(client, fake_users, as_user):
    existing = {
        **CURRENT_USER,
        "upi_id": "Owner@OkSbi",
        "upi_updated_at": "2026-09-10T09:00:00+00:00",
    }
    as_user(existing)

    response = client.patch("/api/auth/me", json={"upi_id": " Owner@OkSbi "})

    assert response.status_code == 200
    assert response.json()["upi_updated_at"] == existing["upi_updated_at"]
    fake_users.update_one.assert_not_awaited()
    fake_users.find_one.assert_not_awaited()


def test_case_only_change_is_persisted(client, fake_users, as_user):
    as_user({**CURRENT_USER, "upi_id": "owner@oksbi"})
    fake_users.find_one.return_value = {**CURRENT_USER, "upi_id": "Owner@OkSbi"}

    response = client.patch("/api/auth/me", json={"upi_id": "Owner@OkSbi"})

    assert response.status_code == 200
    assert fake_users.update_one.await_args.args[1]["$set"]["upi_id"] == "Owner@OkSbi"


def test_explicit_null_clears_both_fields(client, fake_users, as_user):
    as_user({
        **CURRENT_USER,
        "upi_id": "owner@upi",
        "upi_updated_at": "2026-09-10T09:00:00+00:00",
    })
    fake_users.find_one.return_value = dict(CURRENT_USER)

    response = client.patch("/api/auth/me", json={"upi_id": None})

    assert response.status_code == 200
    assert response.json()["upi_id"] is None
    assert response.json()["upi_updated_at"] is None
    assert fake_users.update_one.await_args.args == (
        {"id": CURRENT_USER["id"]},
        {"$unset": {"upi_id": "", "upi_updated_at": ""}},
    )


def test_clearing_missing_value_is_an_idempotent_noop(client, fake_users, as_user):
    as_user(CURRENT_USER)
    response = client.patch("/api/auth/me", json={"upi_id": None})
    assert response.status_code == 200
    fake_users.update_one.assert_not_awaited()
    fake_users.find_one.assert_not_awaited()


@pytest.mark.parametrize("body", [
    {},
    {"upi_id": "bad value@upi"},
    {"upi_id": "valid@upi", "user_id": "u-2"},
])
def test_invalid_or_expanded_payload_does_not_write(client, fake_users, as_user, body):
    as_user(CURRENT_USER)
    response = client.patch("/api/auth/me", json=body)
    assert response.status_code == 422
    fake_users.update_one.assert_not_awaited()


def test_concurrent_user_removal_returns_401(client, fake_users, as_user):
    as_user(CURRENT_USER)
    fake_users.find_one.return_value = None
    response = client.patch("/api/auth/me", json={"upi_id": "owner@upi"})
    assert response.status_code == 401
    assert response.json()["detail"] == "User not found"
