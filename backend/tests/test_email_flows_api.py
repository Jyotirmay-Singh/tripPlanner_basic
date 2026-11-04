# API contract tests with real auth logic, isolated storage, and fully mocked delivery.
import uuid

import pytest

BASE_URL = ''


@pytest.fixture
def api_client(email_env):
    return email_env.client

GENERIC_RESET_MSG = "If this email exists, recovery instructions have been sent."


def _gmail():
    return f"test_ef_{uuid.uuid4().hex[:8]}@gmail.com"


def _register(api_client, email, password="verifypass1", name="EF User"):
    return api_client.post(f"{BASE_URL}/api/auth/register", json={
        "email": email, "password": password, "name": name,
    })


# --------------------------------------------------------------------------- #
# Register -> unverified; soft gate lets the user log in anyway.
# --------------------------------------------------------------------------- #
def test_register_starts_unverified(api_client):
    email = _gmail()
    r = _register(api_client, email)
    assert r.status_code == 200, r.text
    user = r.json()["user"]
    assert user["email_verified"] is False
    assert user["credentials_set"] is True


def test_unverified_user_can_still_log_in_soft_gate(api_client):
    email = _gmail()
    assert _register(api_client, email, password="verifypass1").status_code == 200
    # Password login works even though the email is unverified.
    by_pw = api_client.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": "verifypass1"})
    assert by_pw.status_code == 200, by_pw.text
    assert by_pw.json()["user"]["email_verified"] is False


# --------------------------------------------------------------------------- #
# resend-verification: auth required; rate-limited by the registration email.
# --------------------------------------------------------------------------- #
def test_resend_verification_requires_auth(api_client):
    r = api_client.post(f"{BASE_URL}/api/auth/resend-verification")
    assert r.status_code == 401


def test_resend_verification_rate_limited_after_register(api_client):
    # Registration already sent a verification email (<60s ago), so an immediate resend is
    # rate-limited (429) — proving the per-user 60s cooldown is enforced live.
    email = _gmail()
    reg = _register(api_client, email)
    assert reg.status_code == 200, reg.text
    token = reg.json()["access_token"]
    r = api_client.post(f"{BASE_URL}/api/auth/resend-verification",
                        headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 429, r.text


# --------------------------------------------------------------------------- #
# request-password-reset: identical generic response for known vs unknown email
# (no account enumeration).
# --------------------------------------------------------------------------- #
def test_request_password_reset_no_enumeration(api_client):
    known = _gmail()
    assert _register(api_client, known).status_code == 200
    unknown = _gmail()  # never registered

    r_known = api_client.post(f"{BASE_URL}/api/auth/request-password-reset", json={"email": known})
    r_unknown = api_client.post(f"{BASE_URL}/api/auth/request-password-reset", json={"email": unknown})

    assert r_known.status_code == 200 and r_unknown.status_code == 200
    # byte-identical bodies — the response cannot be used to tell whether the account exists
    assert r_known.json() == r_unknown.json()
    assert r_known.json()["message"] == GENERIC_RESET_MSG


# --------------------------------------------------------------------------- #
# Gmail-only rule (assert_gmail) across every email entry point of these flows.
# --------------------------------------------------------------------------- #
def test_non_gmail_rejected_on_register(api_client):
    r = _register(api_client, f"test_ef_{uuid.uuid4().hex[:8]}@yahoo.com")
    assert r.status_code == 400


def test_non_gmail_rejected_on_login(api_client):
    r = api_client.post(f"{BASE_URL}/api/auth/login",
                        json={"email": "someone@yahoo.com", "password": "verifypass1"})
    assert r.status_code == 400


def test_non_gmail_rejected_on_request_password_reset(api_client):
    r = api_client.post(f"{BASE_URL}/api/auth/request-password-reset",
                        json={"email": "someone@yahoo.com"})
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Bad tokens are rejected cleanly (400/422), never a 500.
# --------------------------------------------------------------------------- #
def test_verify_email_bad_tokens_rejected(api_client):
    empty = api_client.post(f"{BASE_URL}/api/auth/verify-email", json={"token": ""})
    unknown = api_client.post(f"{BASE_URL}/api/auth/verify-email", json={"token": "never-issued-xyz"})
    missing = api_client.post(f"{BASE_URL}/api/auth/verify-email", json={})
    assert empty.status_code == 400
    assert unknown.status_code == 400
    assert missing.status_code == 422  # required field
    for resp in (empty, unknown, missing):
        assert resp.status_code != 500


def test_reset_password_bad_tokens_rejected(api_client):
    # valid-length password so we reach the token check (isolates the token rejection)
    empty = api_client.post(f"{BASE_URL}/api/auth/reset-password",
                            json={"token": "", "new_password": "brandnewpw1"})
    unknown = api_client.post(f"{BASE_URL}/api/auth/reset-password",
                              json={"token": "never-issued", "new_password": "brandnewpw1"})
    missing = api_client.post(f"{BASE_URL}/api/auth/reset-password", json={"token": "x"})
    assert empty.status_code == 400
    assert unknown.status_code == 400
    assert missing.status_code == 422  # missing new_password
    for resp in (empty, unknown, missing):
        assert resp.status_code != 500


def test_retired_authentication_surfaces_stay_removed(api_client):
    schema = api_client.get("/openapi.json").json()
    for path in ["/api/auth/forgot-pin", "/api/auth/reset-pin", "/api/auth/reset-pin-by-password"]:
        assert path not in schema["paths"]
    assert "pin" not in schema["components"]["schemas"]["RegisterIn"]["properties"]
    assert "pin" not in schema["components"]["schemas"]["LoginIn"]["properties"]
