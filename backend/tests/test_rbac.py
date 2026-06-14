# Trip RBAC tests: admin_ids seeding, admin list/promote/demote
import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://split-trips-1.preview.emergentagent.com').rstrip('/')


class TestTripRBAC:
    """Trip admin management endpoint tests"""

    def _create_trip(self, api_client, token, name="TEST_RBAC Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name,
            "travel_date": "15-05-26",
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _register_user(self, api_client, name="Second User"):
        email = f"TEST_rbac_{uuid.uuid4().hex[:8]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "test1234",
            "pin": "5678",
            "name": name
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        return data["access_token"], data["user"]["id"]

    def _join_trip(self, api_client, token, code):
        resp = api_client.post(f"{BASE_URL}/api/trips/join", json={
            "code": code
        }, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200, resp.text
        return resp.json()

    def test_create_trip_seeds_root_admin(self, api_client, test_user):
        """Trip creation seeds admin_ids with the owner as root admin"""
        trip = self._create_trip(api_client, test_user["token"])
        assert trip["admin_ids"] == [trip["owner_id"]]
        assert trip["owner_id"] == test_user["user"]["id"]

    def test_get_admins_owner_and_non_member(self, api_client, test_user):
        """GET /admins works for a member and returns the owner; 403 for non-member"""
        trip = self._create_trip(api_client, test_user["token"])
        trip_id = trip["id"]

        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/admins", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["owner_id"] == trip["owner_id"]
        assert data["admin_ids"] == [trip["owner_id"]]
        assert any(a["user_id"] == trip["owner_id"] for a in data["admins"])

        # non-member
        other_token, _ = self._register_user(api_client, "Outsider")
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/admins", headers={
            "Authorization": f"Bearer {other_token}"
        })
        assert resp.status_code == 403

    def test_promote_member_to_admin(self, api_client, test_user):
        """Owner can promote an existing member to admin"""
        trip = self._create_trip(api_client, test_user["token"])
        trip_id = trip["id"]

        member_token, member_id = self._register_user(api_client, "Member Two")
        self._join_trip(api_client, member_token, trip["code"])

        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/admins", json={
            "user_id": member_id
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert member_id in data["admin_ids"]
        assert trip["owner_id"] in data["admin_ids"]

    def test_promote_non_member_fails(self, api_client, test_user):
        """Promoting a user who hasn't joined the trip returns 400"""
        trip = self._create_trip(api_client, test_user["token"])
        trip_id = trip["id"]

        _, non_member_id = self._register_user(api_client, "Not Joined")

        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/admins", json={
            "user_id": non_member_id
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert resp.status_code == 400

    def test_promote_by_non_admin_fails(self, api_client, test_user):
        """A non-admin member cannot promote anyone"""
        trip = self._create_trip(api_client, test_user["token"])
        trip_id = trip["id"]

        member_token, member_id = self._register_user(api_client, "Member Two")
        self._join_trip(api_client, member_token, trip["code"])

        # member (not admin) tries to promote themselves
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/admins", json={
            "user_id": member_id
        }, headers={"Authorization": f"Bearer {member_token}"})
        assert resp.status_code == 403

    def test_demote_admin(self, api_client, test_user):
        """Owner can demote a promoted (non-root) admin"""
        trip = self._create_trip(api_client, test_user["token"])
        trip_id = trip["id"]

        member_token, member_id = self._register_user(api_client, "Member Two")
        self._join_trip(api_client, member_token, trip["code"])

        # promote then demote
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/admins", json={
            "user_id": member_id
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        resp = api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/admins/{member_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert member_id not in data["admin_ids"]

    def test_cannot_demote_root_admin(self, api_client, test_user):
        """Demoting the trip owner (root admin) is rejected"""
        trip = self._create_trip(api_client, test_user["token"])
        trip_id = trip["id"]

        resp = api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/admins/{trip['owner_id']}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert resp.status_code == 400

    def test_demote_by_non_admin_fails(self, api_client, test_user):
        """A non-admin member cannot demote anyone"""
        trip = self._create_trip(api_client, test_user["token"])
        trip_id = trip["id"]

        member_token, member_id = self._register_user(api_client, "Member Two")
        self._join_trip(api_client, member_token, trip["code"])

        resp = api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/admins/{trip['owner_id']}", headers={
            "Authorization": f"Bearer {member_token}"
        })
        assert resp.status_code == 403
