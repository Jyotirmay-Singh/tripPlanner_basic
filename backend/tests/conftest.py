import pytest
import requests
import os

# Use backend URL from frontend env or fallback to local server
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')

@pytest.fixture
def api_client():
    """Shared requests session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session

@pytest.fixture
def admin_token(api_client):
    """Get admin token for tests"""
    response = api_client.post(f"{BASE_URL}/api/auth/login", json={
        "email": "admin@gmail.com",
        "password": "admin123"
    })
    if response.status_code != 200:
        pytest.skip(f"Admin login failed: {response.status_code}")
    return response.json()["access_token"]

@pytest.fixture
def test_user(api_client):
    """Create a test user and return credentials + token"""
    import uuid
    email = f"test_{uuid.uuid4().hex[:8]}@gmail.com"
    password = "test12345"
    pin = "4321"
    name = "Test User"
    
    response = api_client.post(f"{BASE_URL}/api/auth/register", json={
        "email": email,
        "password": password,
        "pin": pin,
        "name": name
    })
    
    if response.status_code != 200:
        pytest.skip(f"Test user creation failed: {response.status_code}")
    
    data = response.json()
    return {
        "email": email,
        "password": password,
        "pin": pin,
        "name": name,
        "token": data["access_token"],
        "user": data["user"]
    }
