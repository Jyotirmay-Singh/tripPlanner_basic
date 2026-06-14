# Split mode tests: default value, explicit persistence, validation, and patch updates
import pytest
import requests
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://split-trips-1.preview.emergentagent.com').rstrip('/')


class TestSplitMode:
    """Expense split_mode enum tests"""

    def _create_trip_and_member(self, api_client, test_user, name):
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name,
            "travel_date": "10-05-26",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]
        return trip_id, member_id

    def test_default_split_mode_is_per_capita(self, api_client, test_user):
        """POST without split_mode defaults to PER_CAPITA"""
        trip_id, member_id = self._create_trip_and_member(api_client, test_user, "TEST_SplitMode Default Trip")

        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 100.0,
            "category": "Food",
            "description": "Lunch",
            "date": "11-05-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        assert response.status_code == 200
        exp = response.json()["expense"]
        assert exp["split_mode"] == "PER_CAPITA"

    def test_explicit_per_family_split_mode_persists(self, api_client, test_user):
        """POST with split_mode=PER_FAMILY persists and round-trips via GET"""
        trip_id, member_id = self._create_trip_and_member(api_client, test_user, "TEST_SplitMode PerFamily Trip")

        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 120.0,
            "category": "Food",
            "description": "Group dinner",
            "date": "12-05-26",
            "paid_by_member_id": member_id,
            "split_member_ids": [],
            "split_mode": "PER_FAMILY"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        assert response.status_code == 200
        exp = response.json()["expense"]
        assert exp["split_mode"] == "PER_FAMILY"
        expense_id = exp["id"]

        list_resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/expenses", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert list_resp.status_code == 200
        found = next(e for e in list_resp.json() if e["id"] == expense_id)
        assert found["split_mode"] == "PER_FAMILY"

    def test_invalid_split_mode_on_create_rejected(self, api_client, test_user):
        """POST with an invalid split_mode value returns 422"""
        trip_id, member_id = self._create_trip_and_member(api_client, test_user, "TEST_SplitMode Invalid Create Trip")

        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 50.0,
            "category": "Food",
            "description": "Snacks",
            "date": "13-05-26",
            "paid_by_member_id": member_id,
            "split_member_ids": [],
            "split_mode": "PER_HEAD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        assert response.status_code == 422

    def test_patch_flips_split_mode(self, api_client, test_user):
        """PATCH split_mode flips an existing expense from PER_CAPITA to PER_FAMILY"""
        trip_id, member_id = self._create_trip_and_member(api_client, test_user, "TEST_SplitMode Patch Trip")

        exp_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 80.0,
            "category": "Travel",
            "description": "Cab",
            "date": "14-05-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        expense_id = exp_resp.json()["expense"]["id"]
        assert exp_resp.json()["expense"]["split_mode"] == "PER_CAPITA"

        patch_resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/expenses/{expense_id}", json={
            "split_mode": "PER_FAMILY"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        assert patch_resp.status_code == 200
        assert patch_resp.json()["split_mode"] == "PER_FAMILY"

    def test_invalid_split_mode_on_patch_rejected(self, api_client, test_user):
        """PATCH with an invalid split_mode value returns 422"""
        trip_id, member_id = self._create_trip_and_member(api_client, test_user, "TEST_SplitMode Invalid Patch Trip")

        exp_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 30.0,
            "category": "Other",
            "description": "Misc",
            "date": "15-05-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        expense_id = exp_resp.json()["expense"]["id"]

        patch_resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/expenses/{expense_id}", json={
            "split_mode": "PER_HEAD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        assert patch_resp.status_code == 422

    def test_list_expenses_includes_split_mode(self, api_client, test_user):
        """GET /trips/{id}/expenses returns split_mode on every expense"""
        trip_id, member_id = self._create_trip_and_member(api_client, test_user, "TEST_SplitMode List Trip")

        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 60.0,
            "category": "Food",
            "description": "Breakfast",
            "date": "16-05-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        list_resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/expenses", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert list_resp.status_code == 200
        expenses = list_resp.json()
        assert len(expenses) >= 1
        for e in expenses:
            assert "split_mode" in e
            assert e["split_mode"] in ("PER_CAPITA", "PER_FAMILY")
