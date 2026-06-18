# Auth endpoint tests: register, login (password + PIN), forgot/reset password, /me
import pytest
import requests
import os
import uuid
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')

# Load backend/.env so the reset-flow test can read the PIN-reset token straight from
# MongoDB. The token is delivered by email/log only (never in the API response), so an
# integration test retrieves it out-of-band from the same DB the server writes to.
load_dotenv(Path(__file__).resolve().parents[1] / '.env')


def _latest_reset_token(user_id: str):
    """Return the most recent unused PIN-reset token for a user, or None."""
    mongo_url = os.environ.get('MONGO_URL')
    db_name = os.environ.get('DB_NAME')
    if not mongo_url or not db_name:
        return None
    client = MongoClient(mongo_url)
    try:
        rec = client[db_name].password_reset_tokens.find_one(
            {"user_id": user_id, "used": False},
            sort=[("expires_at", -1)],
        )
        return rec["token"] if rec else None
    finally:
        client.close()

class TestAuth:
    """Authentication endpoint tests"""

    def test_register_success(self, api_client):
        """Test user registration with email, password, pin, name"""
        email = f"test_reg_{uuid.uuid4().hex[:8]}@gmail.com"
        response = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "test1234",
            "pin": "4321",
            "name": "Test User"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "access_token" in data
        assert "user" in data
        assert data["user"]["email"] == email.lower()
        assert data["user"]["name"] == "Test User"

    def test_register_duplicate_email(self, api_client):
        """Test registration with duplicate email fails"""
        response = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": "admin@gmail.com",
            "password": "test1234",
            "pin": "4321",
            "name": "Duplicate"
        })
        assert response.status_code == 400

    def test_register_invalid_pin(self, api_client):
        """Test registration with non-digit PIN fails"""
        response = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": f"TEST_{uuid.uuid4().hex[:8]}@gmail.com",
            "password": "test1234",
            "pin": "abcd",
            "name": "Test"
        })
        assert response.status_code == 400

    def test_login_with_password(self, api_client):
        """Test login with email + password"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@gmail.com",
            "password": "admin123"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "access_token" in data
        assert "user" in data
        assert data["user"]["email"] == "admin@gmail.com"

    def test_login_with_pin(self, api_client):
        """Test login with email + 4-digit PIN only"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@gmail.com",
            "pin": "1234"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "access_token" in data
        assert data["user"]["email"] == "admin@gmail.com"

    def test_login_wrong_password(self, api_client):
        """Test login with wrong password fails"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@gmail.com",
            "password": "wrongpass"
        })
        assert response.status_code == 401

    def test_login_wrong_pin(self, api_client):
        """Test login with wrong PIN fails"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@gmail.com",
            "pin": "9999"
        })
        assert response.status_code == 401

    def test_login_no_credentials(self, api_client):
        """Test login without password or PIN fails"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@gmail.com"
        })
        assert response.status_code == 400

    def test_me_with_token(self, api_client, admin_token):
        """Test GET /auth/me with valid Bearer token"""
        response = api_client.get(f"{BASE_URL}/api/auth/me", headers={
            "Authorization": f"Bearer {admin_token}"
        })
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert data["email"] == "admin@gmail.com"
        assert "password_hash" not in data
        assert "pin_hash" not in data

    def test_me_without_token(self, api_client):
        """Test GET /auth/me without token fails"""
        response = api_client.get(f"{BASE_URL}/api/auth/me")
        assert response.status_code == 401

    def test_forgot_password(self, api_client):
        """Test forgot password endpoint (token logged to backend)"""
        response = api_client.post(f"{BASE_URL}/api/auth/forgot-password", json={
            "email": "admin@gmail.com"
        })
        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is True

    def test_reset_password_flow(self, api_client):
        """Test the full forgot-PIN + reset-PIN flow."""
        # Create test user
        email = f"TEST_reset_{uuid.uuid4().hex[:8]}@gmail.com"
        reg_resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "oldpass123",
            "pin": "1111",
            "name": "Reset Test"
        })
        assert reg_resp.status_code == 200
        user_id = reg_resp.json()["user"]["id"]

        # Request a PIN reset
        forgot_resp = api_client.post(f"{BASE_URL}/api/auth/forgot-pin", json={
            "email": email
        })
        assert forgot_resp.status_code == 200

        # The token is delivered by email/log only; read it from the DB out-of-band.
        token = _latest_reset_token(user_id)
        if not token:
            pytest.skip("Could not read PIN-reset token from MongoDB")

        # Reset the PIN
        reset_resp = api_client.post(f"{BASE_URL}/api/auth/reset-pin", json={
            "token": token,
            "new_pin": "2222"
        })
        assert reset_resp.status_code == 200, f"Expected 200, got {reset_resp.status_code}: {reset_resp.text}"

        # New PIN works; old PIN no longer does
        login_resp = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": email,
            "pin": "2222"
        })
        assert login_resp.status_code == 200

        old_login = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": email,
            "pin": "1111"
        })
        assert old_login.status_code == 401

    def test_reset_password_invalid_token(self, api_client):
        """Test reset-PIN with an invalid token fails (valid 4-digit PIN, bad token)."""
        response = api_client.post(f"{BASE_URL}/api/auth/reset-pin", json={
            "token": "invalid_token_xyz",
            "new_pin": "5678"
        })
        assert response.status_code == 400
