# Member name/email rules within a trip: duplicate NAMES are now allowed (disambiguated at display
# time via utils.display_names); only linked-email uniqueness is still enforced. Also covers
# self-exclusion on update and join-time duplicate-name handling.
import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


class TestMemberUniqueness:
    """Member name (duplicates allowed) + email (unique) rules within a trip"""

    def _create_trip(self, api_client, test_user, name="TEST_Uniqueness Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name,
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp.status_code == 200, resp.text
        return resp.json()["id"]

    def test_duplicate_individual_name_allowed(self, api_client, test_user):
        # Duplicate names are now accepted; both members are stored with the same name and
        # disambiguated only at display time.
        trip_id = self._create_trip(api_client, test_user)

        resp1 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Dup Name",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp1.status_code == 200, resp1.text

        resp2 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Dup Name",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp2.status_code == 200, resp2.text
        assert resp2.json()["name"] == "TEST_Dup Name"

        trip = api_client.get(f"{BASE_URL}/api/trips/{trip_id}",
                              headers={"Authorization": f"Bearer {test_user['token']}"}).json()
        dup = [m for m in trip["members"] if m["name"] == "TEST_Dup Name"]
        assert len(dup) == 2

    def test_duplicate_family_name_allowed(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user)

        resp1 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Dup Family",
            "kind": "family",
            "family_members": ["Alice", "Bob"]
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp1.status_code == 200, resp1.text

        resp2 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Dup Family",
            "kind": "family",
            "family_members": ["Carol"]
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp2.status_code == 200, resp2.text

    def test_cross_kind_name_collision_allowed(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user)

        resp1 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Cross Kind",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp1.status_code == 200, resp1.text

        resp2 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Cross Kind",
            "kind": "family",
            "family_members": ["Dave"]
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp2.status_code == 200, resp2.text

    def test_duplicate_linked_email_rejected(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user)

        resp1 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Email One",
            "kind": "individual",
            "email": "test_dup_email@gmail.com"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp1.status_code == 200, resp1.text

        resp2 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Email Two",
            "kind": "individual",
            "email": "TEST_DUP_EMAIL@gmail.com"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp2.status_code == 400

    def test_update_member_self_exclusion(self, api_client, test_user):
        """Renaming a member to its own (unchanged) name should not 400"""
        trip_id = self._create_trip(api_client, test_user)

        member_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Self Name",
            "kind": "individual",
            "email": "test_self_exclusion@gmail.com"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert member_resp.status_code == 200, member_resp.text
        member_id = member_resp.json()["id"]

        response = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}", json={
            "name": "TEST_Self Name",
            "email": "test_self_exclusion@gmail.com"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 200, response.text

    def test_update_member_name_collision_allowed(self, api_client, test_user):
        # Renaming a member onto an existing name is now accepted (display disambiguates).
        trip_id = self._create_trip(api_client, test_user)

        m1 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Existing Name",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"}).json()

        m2 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Other Name",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"}).json()

        response = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{m2['id']}", json={
            "name": "TEST_Existing Name"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 200, response.text
        assert response.json()["name"] == "TEST_Existing Name"

    def test_join_trip_allows_duplicate_name(self, api_client, test_user):
        """A joining user whose name collides with an existing member keeps their plain name
        (no stored-name mutation); disambiguation is derived at display time."""
        # User1 (test_user) creates a trip; its owner member name == test_user["name"]
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Join Disambiguation Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert trip_resp.status_code == 200, trip_resp.text
        trip = trip_resp.json()
        trip_code = trip["code"]
        owner_name = trip["members"][0]["name"]

        # Register a second user with the SAME name as the trip owner
        email2 = f"TEST_join_dup_{uuid.uuid4().hex[:8]}@gmail.com"
        reg_resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email2,
            "password": "test12345",
            "pin": "5678",
            "name": owner_name
        })
        assert reg_resp.status_code == 200, reg_resp.text
        token2 = reg_resp.json()["access_token"]

        # User2 joins the trip with the same name as the existing member
        join_resp = api_client.post(f"{BASE_URL}/api/trips/join", json={
            "code": trip_code
        }, headers={"Authorization": f"Bearer {token2}"})
        assert join_resp.status_code == 200, join_resp.text
        data = join_resp.json()
        assert len(data["members"]) == 2

        names = [m["name"] for m in data["members"]]
        # Both members now keep the SAME stored name (duplicate allowed); the join no longer
        # rewrites the joiner's name. The two members are distinguished by their member id.
        assert names == [owner_name, owner_name]
        assert len({m["id"] for m in data["members"]}) == 2
