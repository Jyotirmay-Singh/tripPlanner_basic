# Member management tests: add individual/family members, update, delete
import pytest
import requests
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://split-trips-1.preview.emergentagent.com').rstrip('/')

class TestMembers:
    """Member management endpoint tests"""

    def test_add_individual_member(self, api_client, test_user):
        """Test POST /trips/{id}/members with kind=individual"""
        # Create trip
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Member Trip",
            "travel_date": "10-05-26",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]

        # Add individual member
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_John Doe",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "TEST_John Doe"
        assert data["kind"] == "individual"
        assert data["family_members"] == []
        assert "id" in data

    def test_add_family_member(self, api_client, test_user):
        """Test POST /trips/{id}/members with kind=family and family_members list"""
        # Create trip
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Family Trip",
            "travel_date": "15-06-26",
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]

        # Add family member
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Smith Family",
            "kind": "family",
            "family_members": ["Alice", "Bob", "Charlie"]
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "TEST_Smith Family"
        assert data["kind"] == "family"
        assert data["family_members"] == ["Alice", "Bob", "Charlie"]

    def test_update_member(self, api_client, test_user):
        """Test PATCH /trips/{id}/members/{member_id}"""
        # Create trip and member
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Update Member Trip",
            "travel_date": "20-07-26",
            "currency": "EUR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]

        member_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Old Name",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member_id = member_resp.json()["id"]

        # Update member
        response = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}", json={
            "name": "TEST_New Name",
            "kind": "family",
            "family_members": ["Dave", "Eve"]
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "TEST_New Name"
        assert data["kind"] == "family"
        assert data["family_members"] == ["Dave", "Eve"]

    def test_delete_member_no_expenses(self, api_client, test_user):
        """Test DELETE /trips/{id}/members/{member_id} when member has no expenses"""
        # Create trip and member
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Delete Member Trip",
            "travel_date": "25-08-26",
            "currency": "GBP"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]

        member_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_To Delete",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member_id = member_resp.json()["id"]

        # Delete member
        response = api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200

    def test_delete_member_with_expenses_fails(self, api_client, test_user):
        """Test DELETE member with expenses fails"""
        # Create trip
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Expense Member Trip",
            "travel_date": "30-09-26",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        owner_member_id = trip_resp.json()["members"][0]["id"]

        # Add member
        member_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_With Expense",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member_id = member_resp.json()["id"]

        # Add expense paid by this member
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 100.0,
            "category": "Food",
            "description": "Lunch",
            "date": "01-10-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # Try to delete member
        response = api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 400
