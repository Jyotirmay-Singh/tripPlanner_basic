# Meta endpoint tests
import asyncio
import pytest
import requests
import os

from routes import meta

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')

class TestMeta:
    """Meta endpoint tests"""

    def test_get_categories(self, api_client):
        """Test GET /meta/categories returns 7 categories"""
        response = api_client.get(f"{BASE_URL}/api/meta/categories")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 7
        expected = ["Travel", "Accommodation", "Local Transportation",
                    "Local Sightseeing", "Food", "Shopping", "Other"]
        assert data == expected

    def test_runtime_config_reports_chat_protocol(self):
        config = asyncio.run(meta.get_config())
        assert config["chat_protocol_version"] == meta.CHAT_PROTOCOL_VERSION == 1
        assert isinstance(config["email_features_enabled"], bool)

    def test_health_reports_redacted_deployment_revision(self, monkeypatch):
        monkeypatch.setenv("GIT_COMMIT", "fallback-commit")
        monkeypatch.setenv("RENDER_GIT_COMMIT", "1234567890abcdef-secret-tail")

        health = asyncio.run(meta.health())

        assert health == {
            "status": "ok",
            "revision": "1234567890ab",
            "chat_protocol_version": 1,
        }
        assert "secret-tail" not in health["revision"]
