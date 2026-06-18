# Gmail-only domain enforcement tests: register/login/forgot-password and
# member linked-email validation, plus the email_rules helper unit tests and
# a black-box check of POST /auth/google with an invalid token.
import os
import sys
import uuid

import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')

# Allow importing backend modules (utils/email_rules.py) regardless of cwd.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from utils.email_rules import is_allowed_email, normalize_email, assert_gmail  # noqa: E402
from fastapi import HTTPException  # noqa: E402


class TestEmailRulesUnit:
    """Unit tests for utils/email_rules.py"""

    def test_is_allowed_email_gmail(self):
        assert is_allowed_email("someone@gmail.com") is True
        assert is_allowed_email("Someone@GMAIL.com") is True

    def test_is_allowed_email_non_gmail(self):
        assert is_allowed_email("someone@trip.app") is False
        assert is_allowed_email("someone@yahoo.com") is False

    def test_is_allowed_email_none_or_empty(self):
        assert is_allowed_email(None) is True
        assert is_allowed_email("") is True

    def test_normalize_email(self):
        assert normalize_email("  Foo@GMAIL.com ") == "foo@gmail.com"
        assert normalize_email(None) is None
        assert normalize_email("") is None

    def test_assert_gmail_raises_for_non_gmail(self):
        with pytest.raises(HTTPException) as exc:
            assert_gmail("someone@yahoo.com")
        assert exc.value.status_code == 400

    def test_assert_gmail_allows_gmail(self):
        assert_gmail("someone@gmail.com")  # should not raise
        assert_gmail(None)  # should not raise


class TestRegisterLoginDomain:
    """Gmail-only enforcement on register/login/forgot-password"""

    def test_register_non_gmail_rejected(self, api_client):
        response = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": f"TEST_{uuid.uuid4().hex[:8]}@yahoo.com",
            "password": "test1234",
            "pin": "4321",
            "name": "Non Gmail"
        })
        assert response.status_code == 400

    def test_register_gmail_accepted(self, api_client):
        email = f"TEST_{uuid.uuid4().hex[:8]}@gmail.com"
        response = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "test1234",
            "pin": "4321",
            "name": "Gmail User"
        })
        assert response.status_code == 200, response.text

    def test_login_non_gmail_rejected(self, api_client):
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": "someone@yahoo.com",
            "password": "whatever"
        })
        assert response.status_code == 400

    def test_forgot_password_non_gmail_rejected(self, api_client):
        response = api_client.post(f"{BASE_URL}/api/auth/forgot-password", json={
            "email": "someone@yahoo.com"
        })
        assert response.status_code == 400

    def test_forgot_password_gmail_accepted(self, api_client):
        response = api_client.post(f"{BASE_URL}/api/auth/forgot-password", json={
            "email": "admin@gmail.com"
        })
        assert response.status_code == 200


class TestMemberLinkedEmailDomain:
    """Gmail-only enforcement on member linked emails"""

    def _create_trip(self, api_client, test_user):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Email Domain Trip",
            "travel_date": "10-05-26",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp.status_code == 200, resp.text
        return resp.json()["id"]

    def test_add_member_non_gmail_email_rejected(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user)
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Bad Email",
            "kind": "individual",
            "email": "someone@yahoo.com"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 400

    def test_add_member_gmail_email_accepted(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user)
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Good Email",
            "kind": "individual",
            "email": f"test_{uuid.uuid4().hex[:8]}@gmail.com"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 200, response.text

    def test_update_member_non_gmail_email_rejected(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user)
        member_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Update Email",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member_id = member_resp.json()["id"]

        response = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}", json={
            "email": "someone@yahoo.com"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 400

    def test_update_member_clear_email_with_empty_string(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user)
        member_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Clear Email",
            "kind": "individual",
            "email": f"test_{uuid.uuid4().hex[:8]}@gmail.com"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member_id = member_resp.json()["id"]

        response = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}", json={
            "email": ""
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 200, response.text
        assert response.json()["email"] is None


class TestGoogleAuthEndpoint:
    """Black-box checks for POST /auth/google"""

    def test_google_auth_invalid_token_rejected(self, api_client):
        response = api_client.post(f"{BASE_URL}/api/auth/google", json={
            "id_token": "not-a-real-token"
        })
        assert response.status_code in (401, 500)
