# Google OAuth tests for POST /api/auth/google.
#
# Two complementary layers:
#   * TestGoogleAuthLive  - hits the running server using the same `requests`/BASE_URL
#     style as the rest of the suite. With GOOGLE_CLIENT_ID unset on the server every
#     deeper branch collapses into the "not configured" guard, so these cover only the
#     externally observable cases (validation + the fact that a bogus token never
#     authenticates).
#   * TestGoogleAuthUnit  - an in-process FastAPI TestClient with the Google verifier
#     and the Mongo layer mocked, so EVERY branch of the handler runs deterministically
#     without needing real Google credentials or a real signed id_token.
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import jwt
import pytest
from fastapi.testclient import TestClient

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')
GOOGLE_URL = f"{BASE_URL}/api/auth/google"

# Make backend/ importable and pull in the app + the module under test.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app  # noqa: E402
from config import JWT_SECRET, JWT_ALGORITHM  # noqa: E402
import routes.auth as auth_module  # noqa: E402


# --------------------------------------------------------------------------- #
# Live integration against the running server (matches the suite's convention)
# --------------------------------------------------------------------------- #
class TestGoogleAuthLive:
    def test_missing_id_token_is_422(self, api_client):
        """Body without id_token fails Pydantic validation."""
        r = api_client.post(GOOGLE_URL, json={})
        assert r.status_code == 422, r.text

    def test_garbage_token_never_authenticates(self, api_client):
        """A bogus token must never produce a session, whatever the server config."""
        r = api_client.post(GOOGLE_URL, json={"id_token": "not-a-real-token"})
        assert r.status_code != 200, r.text
        assert r.status_code in (400, 401, 500)

    def test_reports_not_configured_when_client_id_unset(self, api_client):
        """Current deployment has GOOGLE_CLIENT_ID empty -> explicit 500 guard."""
        r = api_client.post(GOOGLE_URL, json={"id_token": "anything"})
        if r.status_code == 500 and "not configured" in r.text.lower():
            return
        pytest.skip(f"Server appears to have GOOGLE_CLIENT_ID set (status {r.status_code})")


# --------------------------------------------------------------------------- #
# In-process unit tests (mocked verifier + DB) — exhaustive branch coverage
# --------------------------------------------------------------------------- #
@pytest.fixture
def client():
    """TestClient not entered as a context manager => lifespan startup (index
    creation + admin seeding) does not run and no real DB writes occur."""
    return TestClient(app)


@pytest.fixture
def fake_users(monkeypatch):
    """Swap routes.auth.db for an async fake; return the users namespace."""
    users = SimpleNamespace(
        find_one=AsyncMock(return_value=None),
        insert_one=AsyncMock(return_value=None),
    )
    monkeypatch.setattr(auth_module, "db", SimpleNamespace(users=users))
    return users


@pytest.fixture
def configured(monkeypatch):
    """Pretend a Google client ID is configured so the config guard passes."""
    cid = "unit-test-client.apps.googleusercontent.com"
    monkeypatch.setattr(auth_module, "GOOGLE_CLIENT_ID", cid)
    return cid


def _stub_verify(monkeypatch, idinfo=None, error=False):
    """Stub google_id_token.verify_oauth2_token (called synchronously by the route)."""
    if error:
        def boom(*a, **k):
            raise ValueError("bad token")
        monkeypatch.setattr(auth_module.google_id_token, "verify_oauth2_token", boom)
    else:
        monkeypatch.setattr(
            auth_module.google_id_token, "verify_oauth2_token",
            lambda *a, **k: idinfo,
        )


class TestGoogleAuthUnit:
    def test_not_configured_returns_500(self, client, monkeypatch):
        monkeypatch.setattr(auth_module, "GOOGLE_CLIENT_ID", "")
        r = client.post("/api/auth/google", json={"id_token": "x"})
        assert r.status_code == 500
        assert "not configured" in r.json()["detail"].lower()

    def test_missing_id_token_returns_422(self, client):
        r = client.post("/api/auth/google", json={})
        assert r.status_code == 422

    def test_invalid_token_returns_401(self, client, configured, fake_users, monkeypatch):
        _stub_verify(monkeypatch, error=True)
        r = client.post("/api/auth/google", json={"id_token": "bad"})
        assert r.status_code == 401
        assert r.json()["detail"] == "Invalid Google token"
        fake_users.find_one.assert_not_called()  # rejected before any DB lookup

    def test_new_gmail_user_is_created(self, client, configured, fake_users, monkeypatch):
        fake_users.find_one.return_value = None
        _stub_verify(monkeypatch, {"email": "newbie@gmail.com", "name": "New Bie"})
        r = client.post("/api/auth/google", json={"id_token": "good"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["user"]["email"] == "newbie@gmail.com"
        assert body["user"]["name"] == "New Bie"
        assert body["user"]["role"] == "user"
        assert body["access_token"]
        fake_users.insert_one.assert_awaited_once()
        created = fake_users.insert_one.call_args.args[0]
        assert created["auth_provider"] == "google"
        assert created["email"] == "newbie@gmail.com"
        assert "pin_hash" in created and "password_hash" in created  # random secrets set

    def test_existing_user_not_duplicated(self, client, configured, fake_users, monkeypatch):
        existing = {"id": "u-123", "email": "back@gmail.com",
                    "name": "Back Again", "role": "user"}
        fake_users.find_one.return_value = existing
        _stub_verify(monkeypatch, {"email": "back@gmail.com", "name": "Ignored"})
        r = client.post("/api/auth/google", json={"id_token": "good"})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["id"] == "u-123"
        assert r.json()["user"]["name"] == "Back Again"  # existing record wins
        fake_users.insert_one.assert_not_called()

    def test_non_gmail_email_rejected(self, client, configured, fake_users, monkeypatch):
        _stub_verify(monkeypatch, {"email": "person@yahoo.com", "name": "Y"})
        r = client.post("/api/auth/google", json={"id_token": "good"})
        assert r.status_code == 400
        assert "gmail.com" in r.json()["detail"]
        fake_users.find_one.assert_not_called()

    def test_missing_email_in_token_returns_401(self, client, configured, fake_users, monkeypatch):
        _stub_verify(monkeypatch, {"name": "No Email"})  # no email claim
        r = client.post("/api/auth/google", json={"id_token": "good"})
        assert r.status_code == 401
        assert r.json()["detail"] == "Invalid Google token"

    def test_email_is_normalized(self, client, configured, fake_users, monkeypatch):
        fake_users.find_one.return_value = None
        _stub_verify(monkeypatch, {"email": "  MixedCase@Gmail.COM ", "name": "M"})
        r = client.post("/api/auth/google", json={"id_token": "good"})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["email"] == "mixedcase@gmail.com"
        fake_users.find_one.assert_awaited_once()
        assert fake_users.find_one.call_args.args[0] == {"email": "mixedcase@gmail.com"}

    def test_name_falls_back_to_email_local_part(self, client, configured, fake_users, monkeypatch):
        fake_users.find_one.return_value = None
        _stub_verify(monkeypatch, {"email": "justme@gmail.com"})  # no name claim
        r = client.post("/api/auth/google", json={"id_token": "good"})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["name"] == "justme"

    def test_returned_jwt_is_valid(self, client, configured, fake_users, monkeypatch):
        fake_users.find_one.return_value = None
        _stub_verify(monkeypatch, {"email": "tokencheck@gmail.com", "name": "T"})
        r = client.post("/api/auth/google", json={"id_token": "good"})
        assert r.status_code == 200, r.text
        decoded = jwt.decode(r.json()["access_token"], JWT_SECRET, algorithms=[JWT_ALGORITHM])
        assert decoded["email"] == "tokencheck@gmail.com"
        assert decoded["sub"] == r.json()["user"]["id"]
        assert decoded["type"] == "access"

    def test_comma_separated_audiences_passed_through(self, client, fake_users, monkeypatch):
        """A comma-separated GOOGLE_CLIENT_ID (web,ios,android) is parsed into a list
        and forwarded as the audience, so a token minted for any platform's client ID
        still verifies. Without this, native (iOS/Android) logins would 401."""
        monkeypatch.setattr(
            auth_module, "GOOGLE_CLIENT_ID",
            " web.apps.googleusercontent.com , ios.apps.googleusercontent.com ,android.apps.googleusercontent.com ",
        )
        fake_users.find_one.return_value = None
        captured = {}

        def capture(token, request, audience, *a, **k):
            captured["audience"] = audience
            return {"email": "crossplatform@gmail.com", "name": "X Plat"}

        monkeypatch.setattr(auth_module.google_id_token, "verify_oauth2_token", capture)
        r = client.post("/api/auth/google", json={"id_token": "good"})
        assert r.status_code == 200, r.text
        assert captured["audience"] == [
            "web.apps.googleusercontent.com",
            "ios.apps.googleusercontent.com",
            "android.apps.googleusercontent.com",
        ]

    def test_real_verifier_rejects_malformed_token(self, client, configured, fake_users):
        """No stubbing here: exercises the REAL google-auth library. A structurally
        invalid token must be rejected (ValueError -> 401). Skips gracefully if the
        Google certs endpoint is unreachable (offline)."""
        r = client.post("/api/auth/google", json={"id_token": "this.is.not.a.jwt"})
        if r.status_code == 500:
            pytest.skip("Google certs endpoint unreachable (offline); skipping real-verifier check")
        assert r.status_code == 401, r.text
        assert r.json()["detail"] == "Invalid Google token"
