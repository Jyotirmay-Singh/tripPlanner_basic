# Trip CRUD tests: create, list, get, update, delete, join
import pytest
import requests
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://split-trips-1.preview.emergentagent.com').rstrip('/')

class TestTrips:
    """Trip CRUD endpoint tests"""

    def test_create_trip(self, api_client, test_user):
        """Test POST /trips creates trip with unique code and auto-adds owner as member"""
        response = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Beach Trip",
            "travel_date": "15-05-26",
            "budget": 5000.0,
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert data["name"] == "TEST_Beach Trip"
        assert data["travel_date"] == "15-05-26"
        assert data["budget"] == 5000.0
        assert data["currency"] == "USD"
        assert "code" in data
        assert len(data["code"]) == 6
        assert data["owner_id"] == test_user["user"]["id"]
        assert test_user["user"]["id"] in data["user_ids"]
        assert data["admin_ids"] == [data["owner_id"]]
        assert len(data["members"]) == 1
        assert data["members"][0]["name"] == test_user["name"]
        assert data["members"][0]["kind"] == "individual"

    def test_list_trips(self, api_client, test_user):
        """Test GET /trips lists user trips"""
        # Create a trip first
        create_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_List Trip",
            "travel_date": "20-06-26",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert create_resp.status_code == 200

        # List trips
        response = api_client.get(f"{BASE_URL}/api/trips", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        assert any(t["name"] == "TEST_List Trip" for t in data)

    def test_get_trip(self, api_client, test_user):
        """Test GET /trips/{id} returns trip details"""
        # Create trip
        create_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Get Trip",
            "travel_date": "25-07-26",
            "currency": "EUR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = create_resp.json()["id"]

        # Get trip
        response = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == trip_id
        assert data["name"] == "TEST_Get Trip"

    def test_update_trip(self, api_client, test_user):
        """Test PATCH /trips/{id} updates trip"""
        # Create trip
        create_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Old Name",
            "travel_date": "10-08-26",
            "currency": "GBP"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = create_resp.json()["id"]

        # Update trip
        response = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}", json={
            "name": "TEST_New Name",
            "budget": 3000.0
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "TEST_New Name"
        assert data["budget"] == 3000.0

        # Verify persistence
        get_resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert get_resp.json()["name"] == "TEST_New Name"

    def test_delete_trip(self, api_client, test_user):
        """Test DELETE /trips/{id} deletes trip (owner only)"""
        # Create trip
        create_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Delete Trip",
            "travel_date": "15-09-26",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = create_resp.json()["id"]

        # Delete trip
        response = api_client.delete(f"{BASE_URL}/api/trips/{trip_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200

        # Verify deletion
        get_resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert get_resp.status_code == 404

    def test_join_trip_with_code(self, api_client, test_user):
        """Test POST /trips/join with code from another user's trip"""
        # Create second test user
        import uuid
        user2_email = f"TEST_join_{uuid.uuid4().hex[:8]}@trip.app"
        user2_resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": user2_email,
            "password": "test1234",
            "pin": "5678",
            "name": "User Two"
        })
        user2_token = user2_resp.json()["access_token"]
        user2_id = user2_resp.json()["user"]["id"]

        # User 1 creates trip
        create_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Join Trip",
            "travel_date": "20-10-26",
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_code = create_resp.json()["code"]
        trip_id = create_resp.json()["id"]

        # User 2 joins with code
        response = api_client.post(f"{BASE_URL}/api/trips/join", json={
            "code": trip_code
        }, headers={"Authorization": f"Bearer {user2_token}"})
        assert response.status_code == 200
        data = response.json()
        assert user2_id in data["user_ids"]
        assert len(data["members"]) == 2
        assert any(m["name"] == "User Two" for m in data["members"])

    def test_join_trip_invalid_code(self, api_client, test_user):
        """Test join with invalid code fails"""
        response = api_client.post(f"{BASE_URL}/api/trips/join", json={
            "code": "INVALID"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 404

    def test_get_trip_not_member(self, api_client, test_user):
        """Test accessing trip user is not member of fails"""
        # Create second user and trip
        import uuid
        user2_resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": f"TEST_other_{uuid.uuid4().hex[:8]}@trip.app",
            "password": "test1234",
            "pin": "9999",
            "name": "Other User"
        })
        user2_token = user2_resp.json()["access_token"]
        
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Private Trip",
            "travel_date": "01-11-26",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {user2_token}"})
        trip_id = trip_resp.json()["id"]

        # test_user tries to access
        response = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 403
