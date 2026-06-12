# AI and meta endpoint tests
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


class TestAI:
    """AI endpoint tests using Emergent LLM key"""

    def test_ai_categorize(self, api_client, test_user):
        """Test POST /ai/categorize returns a valid category"""
        response = api_client.post(f"{BASE_URL}/api/ai/categorize", json={
            "description": "Dinner at Italian restaurant with pizza and pasta"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        data = response.json()
        assert "category" in data
        # Should return "Food" for restaurant description
        valid_categories = ["Travel", "Accommodation", "Local Transportation",
                           "Local Sightseeing", "Food", "Shopping", "Other"]
        assert data["category"] in valid_categories
        # Most likely "Food"
        assert data["category"] == "Food"

    def test_ai_categorize_empty_description(self, api_client, test_user):
        """Test AI categorize with empty description returns Other"""
        response = api_client.post(f"{BASE_URL}/api/ai/categorize", json={
            "description": ""
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        data = response.json()
        assert data["category"] == "Other"

    def test_ai_insights(self, api_client, test_user):
        """Test GET /trips/{id}/ai/insights returns insights list"""
        # Create trip with expenses
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_AI Insights Trip",
            "travel_date": "30-07-27",
            "budget": 3000.0,
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        # Add expenses in different categories
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 1200.0,
            "category": "Food",
            "description": "Restaurants",
            "date": "31-07-27",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 500.0,
            "category": "Shopping",
            "description": "Gifts",
            "date": "01-08-27",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # Get AI insights
        response = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/ai/insights", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200
        data = response.json()
        assert "insights" in data
        assert "top_category" in data
        assert isinstance(data["insights"], list)
        assert len(data["insights"]) >= 1
        assert data["top_category"] == "Food"

    def test_ai_insights_no_expenses(self, api_client, test_user):
        """Test AI insights with no expenses returns default message"""
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Empty Trip",
            "travel_date": "05-08-27",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]

        response = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/ai/insights", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200
        data = response.json()
        assert "insights" in data
        assert len(data["insights"]) >= 1
        assert "No expenses yet" in data["insights"][0]
        assert data["top_category"] is None
