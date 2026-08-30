"""Live API coverage for password-only registration, login, and session retrieval."""
import os
import uuid

import pytest


BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


class TestAuth:
    def test_register_success_without_pin(self, api_client):
        email = f"test_reg_{uuid.uuid4().hex[:8]}@gmail.com"
        response = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "test12345",
            "name": "Test User",
        })
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["access_token"]
        assert data["user"]["email"] == email
        assert data["user"]["credentials_set"] is True
        assert "password_hash" not in data["user"]
        assert "pin_hash" not in data["user"]

    def test_register_rejects_retired_pin_field(self, api_client):
        response = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": f"test_pin_{uuid.uuid4().hex[:8]}@gmail.com",
            "password": "test12345",
            "name": "Old Client",
            "pin": "4321",
        })
        assert response.status_code == 422

    def test_register_short_password_fails(self, api_client):
        response = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": f"test_short_{uuid.uuid4().hex[:8]}@gmail.com",
            "password": "short",
            "name": "Short Password",
        })
        assert response.status_code == 400

    def test_login_with_password(self, api_client, test_user):
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": test_user["email"],
            "password": test_user["password"],
        })
        assert response.status_code == 200, response.text
        assert response.json()["user"]["id"] == test_user["user"]["id"]

    def test_login_wrong_password_fails_generically(self, api_client, test_user):
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": test_user["email"],
            "password": "definitely-wrong",
        })
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid email or password"

    def test_login_pin_only_is_rejected(self, api_client, test_user):
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": test_user["email"],
            "pin": "4321",
        })
        assert response.status_code == 422

    def test_login_requires_password(self, api_client, test_user):
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": test_user["email"],
        })
        assert response.status_code == 422

    def test_me_returns_current_user(self, api_client, test_user):
        response = api_client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {test_user['token']}"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["email"] == test_user["email"]
        assert "password_hash" not in response.json()
        assert "pin_hash" not in response.json()

    @pytest.mark.parametrize("path", [
        "forgot-pin",
        "reset-pin",
        "reset-pin-by-password",
        "forgot-password",
    ])
    def test_retired_pin_endpoints_are_removed(self, api_client, path):
        response = api_client.post(f"{BASE_URL}/api/auth/{path}", json={})
        assert response.status_code == 404
