# Auth endpoint tests: register, login (password + PIN), forgot/reset password, /me
import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://split-trips-1.preview.emergentagent.com').rstrip('/')

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
        """Test full forgot + reset password flow"""
        # Create test user
        email = f"TEST_reset_{uuid.uuid4().hex[:8]}@gmail.com"
        reg_resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "oldpass123",
            "pin": "1111",
            "name": "Reset Test"
        })
        assert reg_resp.status_code == 200

        # Request password reset
        forgot_resp = api_client.post(f"{BASE_URL}/api/auth/forgot-password", json={
            "email": email
        })
        assert forgot_resp.status_code == 200

        # Parse token from backend logs
        import subprocess
        logs = subprocess.check_output(["tail", "-n", "50", "/var/log/supervisor/backend.err.log"]).decode()
        token = None
        for line in logs.splitlines():
            if "[PASSWORD RESET]" in line and email in line:
                parts = line.split("Token=")
                if len(parts) > 1:
                    token = parts[1].split()[0]
                    break

        if not token:
            pytest.skip("Could not parse reset token from logs")

        # Reset password
        reset_resp = api_client.post(f"{BASE_URL}/api/auth/reset-password", json={
            "token": token,
            "new_password": "newpass456"
        })
        assert reset_resp.status_code == 200

        # Verify new password works
        login_resp = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": email,
            "password": "newpass456"
        })
        assert login_resp.status_code == 200

    def test_reset_password_invalid_token(self, api_client):
        """Test reset with invalid token fails"""
        response = api_client.post(f"{BASE_URL}/api/auth/reset-password", json={
            "token": "invalid_token_xyz",
            "new_password": "newpass123"
        })
        assert response.status_code == 400
