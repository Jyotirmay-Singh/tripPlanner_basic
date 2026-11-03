import pytest
import requests
import os


@pytest.fixture
def email_env(monkeypatch):
    """Exercise real auth/routes against a transactional fake, with delivery fully mocked."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from fastapi.testclient import TestClient
    from server import app
    from email_fakes import FakeDB
    import routes.auth as auth
    import routes.meta as meta
    import utils.auth_tokens as tokens
    import utils.deps as deps
    import utils.email_limits as limits
    import utils.emailer as emailer

    db = FakeDB()
    for module in (auth, tokens, deps, limits):
        monkeypatch.setattr(module, "db", db)
    monkeypatch.setattr(tokens, "run_required_transaction", db.transaction)
    monkeypatch.setattr(auth, "EMAIL_FEATURES_ENABLED", True)
    monkeypatch.setattr(meta, "EMAIL_FEATURES_ENABLED", True)
    monkeypatch.setattr(emailer, "APP_URL", "https://app.example.com")
    send = AsyncMock()
    monkeypatch.setattr(auth, "send_auth_email", send)
    issued = []
    async def issue(user_id, purpose, ttl):
        raw = await tokens.issue_token(user_id, purpose, ttl)
        issued.append((purpose, raw))
        return raw
    monkeypatch.setattr(auth, "issue_token", issue)
    monkeypatch.setattr(auth.chat_connections, "revoke_user", AsyncMock())
    return SimpleNamespace(db=db, send=send, issued=issued, client=TestClient(app), auth=auth)

# Use backend URL from frontend env or fallback to local server
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')
SUPER_ADMIN_EMAIL = "jyotirmaysingh03@gmail.com"

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
        "email": SUPER_ADMIN_EMAIL,
        "password": os.environ.get("ADMIN_PASSWORD", "admin123")
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
    name = "Test User"
    
    response = api_client.post(f"{BASE_URL}/api/auth/register", json={
        "email": email,
        "password": password,
        "name": name
    })
    
    if response.status_code != 200:
        pytest.skip(f"Test user creation failed: {response.status_code}")
    
    data = response.json()
    return {
        "email": email,
        "password": password,
        "name": name,
        "token": data["access_token"],
        "user": data["user"]
    }
