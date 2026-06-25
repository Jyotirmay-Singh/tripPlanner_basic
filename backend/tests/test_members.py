# Member management tests: add individual/family members, update, delete
import pytest
import requests
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')

class TestMembers:
    """Member management endpoint tests"""

    def test_add_individual_member(self, api_client, test_user):
        """Test POST /trips/{id}/members with kind=individual"""
        # Create trip
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Member Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
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
            "start_date": "2026-01-10", "end_date": "2026-01-15",
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
            "start_date": "2026-01-10", "end_date": "2026-01-15",
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
            "start_date": "2026-01-10", "end_date": "2026-01-15",
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

    def test_delete_unsettled_member_with_expenses_blocked(self, api_client, test_user):
        """An UNSETTLED member is blocked (409). The old "has any expense" brake (400) was replaced
        by the net-zero settlement gate: this member pays 100 split among 2 -> net +50 (creditor),
        so removal is refused with 409 (not 400) until they are settled."""
        # Create trip
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Expense Member Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]

        # Add member
        member_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_With Expense",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member_id = member_resp.json()["id"]

        # Add expense paid by this member (split among all -> member is a +50 creditor)
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 100.0,
            "category": "Food",
            "description": "Lunch",
            "date": "01-10-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # Try to delete the unsettled member -> 409 (net-zero gate), member stays.
        response = api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 409, response.text
        members = api_client.get(f"{BASE_URL}/api/trips/{trip_id}",
                                 headers={"Authorization": f"Bearer {test_user['token']}"}).json()["members"]
        assert any(m["id"] == member_id for m in members)

    # ---------- P3: server-side no-empty-family invariant ----------
    def test_update_member_cannot_empty_a_family(self, api_client, test_user):
        """PATCH that would leave a family with zero members is rejected (400) and the roster is
        untouched — the HARD INVARIANT (a family always has >=1 member) is now enforced server-side,
        not just client-side in the edit screen."""
        auth = {"Authorization": f"Bearer {test_user['token']}"}
        trip_id = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Empty Family Trip", "start_date": "2026-01-10",
            "end_date": "2026-01-15", "currency": "INR",
        }, headers=auth).json()["id"]
        fam = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Fam", "kind": "family", "family_members": ["Alice", "Bob"],
        }, headers=auth).json()

        resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{fam['id']}", json={
            "kind": "family", "family_members": [],
        }, headers=auth)
        assert resp.status_code == 400, resp.text

        fam_now = next(m for m in api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=auth)
                       .json()["members"] if m["id"] == fam["id"])
        assert fam_now["family_members"] == ["Alice", "Bob"]  # untouched

    def test_convert_individual_to_family_requires_members(self, api_client, test_user):
        """Converting an individual to a family with no members is rejected (400)."""
        auth = {"Authorization": f"Bearer {test_user['token']}"}
        trip_id = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Convert Trip", "start_date": "2026-01-10",
            "end_date": "2026-01-15", "currency": "INR",
        }, headers=auth).json()["id"]
        ind = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Solo", "kind": "individual",
        }, headers=auth).json()

        resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{ind['id']}", json={
            "kind": "family",
        }, headers=auth)
        assert resp.status_code == 400, resp.text
        # still an individual
        ind_now = next(m for m in api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=auth)
                       .json()["members"] if m["id"] == ind["id"])
        assert ind_now["kind"] == "individual"
