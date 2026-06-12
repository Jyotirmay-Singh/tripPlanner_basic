# Meta endpoint tests
import pytest
import requests
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://split-trips-1.preview.emergentagent.com').rstrip('/')

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
