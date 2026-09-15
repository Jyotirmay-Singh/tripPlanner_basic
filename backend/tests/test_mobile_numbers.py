from pathlib import Path
from types import SimpleNamespace
import sys
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models.auth import MobileProfileUpdate  # noqa: E402
from routes import auth as auth_routes  # noqa: E402
from server import app  # noqa: E402
from utils.deps import get_current_user  # noqa: E402
from utils.mobile_numbers import normalize_mobile_number  # noqa: E402


CURRENT_USER = {
    "id": "u-1",
    "email": "owner@gmail.com",
    "name": "Owner",
    "role": "user",
    "email_verified": True,
    "credentials_set": True,
}


@pytest.mark.parametrize(("value", "country", "expected", "stored_country"), [
    ("98765 43210", "in", "+919876543210", "IN"),
    ("+44 7911 123456", "IN", "+447911123456", "GG"),
    ("(415) 555-2671", "US", "+14155552671", "US"),
])
def test_normalizes_international_mobile_and_ambiguous_mobile_types(
    value, country, expected, stored_country,
):
    assert normalize_mobile_number(value, country) == (expected, stored_country)


def test_rejects_known_fixed_line_number():
    with pytest.raises(ValueError, match="fixed-line"):
        normalize_mobile_number("+44 20 7946 0018", "GB")


@pytest.mark.parametrize(("value", "country"), [
    ("123", "IN"),
    ("not a phone", "US"),
    ("+91 98765 43210 ext 9", "IN"),
    ("9876543210", "ZZ"),
])
def test_rejects_invalid_numbers_and_regions(value, country):
    with pytest.raises(ValueError):
        normalize_mobile_number(value, country)


def test_mobile_patch_model_requires_both_fields_and_allows_removal():
    with pytest.raises(ValidationError):
        MobileProfileUpdate()
    with pytest.raises(ValidationError):
        MobileProfileUpdate(mobile_number="9876543210", mobile_country_code=None)
    removed = MobileProfileUpdate(mobile_number=None, mobile_country_code=None)
    assert removed.mobile_number is None
    assert removed.mobile_country_code is None


def test_auth_payloads_stabilize_legacy_mobile_nulls():
    payload = auth_routes._user_payload(CURRENT_USER)
    profile = auth_routes._self_profile_payload(CURRENT_USER)
    for result in (payload, profile):
        assert result["mobile_number"] is None
        assert result["mobile_country_code"] is None
        assert result["mobile_verified_at"] is None


def test_mobile_patch_normalizes_and_delegates(monkeypatch):
    updated = {
        **CURRENT_USER,
        "mobile_number": "+919876543210",
        "mobile_country_code": "IN",
        "mobile_verified_at": None,
    }
    update = AsyncMock(return_value=updated)
    monkeypatch.setattr(auth_routes, "update_account_mobile", update)
    app.dependency_overrides[get_current_user] = lambda: dict(CURRENT_USER)
    try:
        response = TestClient(app).patch("/api/auth/me/mobile", json={
            "mobile_number": "98765 43210",
            "mobile_country_code": "in",
        })
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert response.status_code == 200, response.text
    update.assert_awaited_once_with(CURRENT_USER, "+919876543210", "IN")
    assert response.json()["mobile_verified_at"] is None


def test_mobile_patch_allows_explicit_removal(monkeypatch):
    current = {
        **CURRENT_USER,
        "mobile_number": "+919876543210",
        "mobile_country_code": "IN",
    }
    update = AsyncMock(return_value={
        **current,
        "mobile_number": None,
        "mobile_country_code": None,
        "mobile_verified_at": None,
    })
    monkeypatch.setattr(auth_routes, "update_account_mobile", update)
    app.dependency_overrides[get_current_user] = lambda: current
    try:
        response = TestClient(app).patch("/api/auth/me/mobile", json={
            "mobile_number": None,
            "mobile_country_code": None,
        })
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert response.status_code == 200
    update.assert_awaited_once_with(current, None, None)


def test_mobile_patch_rejects_expanded_payload_before_write(monkeypatch):
    update = AsyncMock()
    monkeypatch.setattr(auth_routes, "update_account_mobile", update)
    app.dependency_overrides[get_current_user] = lambda: dict(CURRENT_USER)
    try:
        response = TestClient(app).patch("/api/auth/me/mobile", json={
            "mobile_number": "+919876543210",
            "mobile_country_code": "IN",
            "mobile_verified_at": "2026-01-01T00:00:00Z",
        })
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert response.status_code == 422
    update.assert_not_awaited()
