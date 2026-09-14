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
        assert isinstance(config["invite_links_enabled"], bool)
        assert isinstance(config["multi_currency_expenses_enabled"], bool)
        assert config["whole_unit_settlements_enabled"] is True
        assert config["money_policy"] == {
            "version": "whole_unit_v1",
            "increment": "1",
            "rounding": "ROUND_HALF_UP",
            "rounding_description": (
                "Round to the nearest whole major currency unit; "
                "midpoint values round away from zero."
            ),
            "midpoint_examples": {
                "positive": {"before": "400.50", "after": 401},
                "negative": {"before": "-400.50", "after": -401},
            },
        }

    def test_runtime_config_reports_multi_currency_rollout_flag(self, monkeypatch):
        monkeypatch.setattr(meta, "MULTI_CURRENCY_EXPENSES_ENABLED", True)
        assert asyncio.run(meta.get_config())["multi_currency_expenses_enabled"] is True

        monkeypatch.setattr(meta, "MULTI_CURRENCY_EXPENSES_ENABLED", False)
        assert asyncio.run(meta.get_config())["multi_currency_expenses_enabled"] is False

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
