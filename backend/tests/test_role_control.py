# Step 23 tests: Owner / Admin / Member control differences.
#
# TestRoleMatrix  -> pure unit tests for utils.permissions (no server, no fixtures).
# TestRoleControlAPI -> integration tests for the enforced matrix (needs a running API).
import os
import uuid

import pytest
import requests

from utils.permissions import (
    role_of,
    can_view,
    can_manage_members,
    can_edit_trip_settings,
    can_modify_any_expense,
    can_manage_admins,
    can_transfer_ownership,
    can_delete_trip,
)

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8000").rstrip("/")


# ---------------------------------------------------------------------------
# Pure unit tests — no HTTP
# ---------------------------------------------------------------------------
class TestRoleMatrix:
    OWNER = "u-owner"
    ADMIN = "u-admin"
    MEMBER = "u-member"

    def _trip(self):
        # owner is also present in admin_ids (as seeded in production)
        return {
            "owner_id": self.OWNER,
            "admin_ids": [self.OWNER, self.ADMIN],
            "user_ids": [self.OWNER, self.ADMIN, self.MEMBER],
        }

    def test_role_of_owner_supersedes_admin(self):
        # owner is in admin_ids too, but must report as "owner"
        assert role_of(self._trip(), self.OWNER) == "owner"

    def test_role_of_admin(self):
        assert role_of(self._trip(), self.ADMIN) == "admin"

    def test_role_of_member(self):
        assert role_of(self._trip(), self.MEMBER) == "member"

    def test_role_of_non_member_is_none(self):
        assert role_of(self._trip(), "stranger") is None

    def test_role_of_falsy_user_is_none(self):
        assert role_of(self._trip(), None) is None
        assert role_of(self._trip(), "") is None

    def test_role_of_legacy_doc_missing_keys(self):
        # Documents missing owner_id/admin_ids/user_ids must not raise.
        assert role_of({}, "anyone") is None
        assert role_of({"owner_id": "x"}, "x") == "owner"
        assert role_of({"user_ids": ["m"]}, "m") == "member"

    def test_owner_or_admin_capabilities(self):
        t = self._trip()
        for cap in (can_manage_members, can_edit_trip_settings, can_modify_any_expense):
            assert cap(t, self.OWNER) is True
            assert cap(t, self.ADMIN) is True
            assert cap(t, self.MEMBER) is False
            assert cap(t, "stranger") is False

    def test_owner_only_capabilities(self):
        t = self._trip()
        for cap in (can_manage_admins, can_transfer_ownership, can_delete_trip):
            assert cap(t, self.OWNER) is True
            assert cap(t, self.ADMIN) is False
            assert cap(t, self.MEMBER) is False
            assert cap(t, "stranger") is False

    def test_can_view(self):
        t = self._trip()
        assert can_view(t, self.OWNER) is True
        assert can_view(t, self.ADMIN) is True
        assert can_view(t, self.MEMBER) is True
        assert can_view(t, "stranger") is False


# ---------------------------------------------------------------------------
# Integration tests — exercise the enforced matrix end to end
# ---------------------------------------------------------------------------
class TestRoleControlAPI:
    def _create_trip(self, api_client, token, name="TEST_ROLE Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name, "start_date": "2026-01-10", "end_date": "2026-01-15", "currency": "USD",
        }, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _register_user(self, api_client, name="Role User"):
        email = f"TEST_role_{uuid.uuid4().hex[:8]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email, "password": "test12345", "pin": "5678", "name": name,
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        return data["access_token"], data["user"]["id"]

    def _join(self, api_client, token, code):
        resp = api_client.post(f"{BASE_URL}/api/trips/join", json={"code": code},
                               headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _promote(self, api_client, owner_token, trip_id, uid):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/admins",
                               json={"user_id": uid},
                               headers={"Authorization": f"Bearer {owner_token}"})
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _patch(self, api_client, token, trip_id, body):
        return api_client.patch(f"{BASE_URL}/api/trips/{trip_id}", json=body,
                                headers={"Authorization": f"Bearer {token}"})

    # -- Trip settings (PATCH) ------------------------------------------------
    def test_settings_owner_and_admin_allowed_member_blocked(self, api_client, test_user):
        owner_token = test_user["token"]
        trip = self._create_trip(api_client, owner_token)
        tid = trip["id"]

        admin_token, admin_id = self._register_user(api_client, "Admin User")
        self._join(api_client, admin_token, trip["code"])
        self._promote(api_client, owner_token, tid, admin_id)

        member_token, _ = self._register_user(api_client, "Plain Member")
        self._join(api_client, member_token, trip["code"])

        # owner -> 200
        assert self._patch(api_client, owner_token, tid, {"name": "By Owner"}).status_code == 200
        # admin -> 200
        assert self._patch(api_client, admin_token, tid, {"name": "By Admin"}).status_code == 200
        # plain member -> 403
        assert self._patch(api_client, member_token, tid, {"name": "By Member"}).status_code == 403

    # -- Admin management is owner-only --------------------------------------
    def test_admin_management_is_owner_only(self, api_client, test_user):
        owner_token = test_user["token"]
        trip = self._create_trip(api_client, owner_token)
        tid = trip["id"]

        admin_token, admin_id = self._register_user(api_client, "Admin User")
        self._join(api_client, admin_token, trip["code"])
        self._promote(api_client, owner_token, tid, admin_id)

        member_token, member_id = self._register_user(api_client, "Third Member")
        self._join(api_client, member_token, trip["code"])

        # a non-owner admin cannot promote
        resp = api_client.post(f"{BASE_URL}/api/trips/{tid}/admins", json={"user_id": member_id},
                               headers={"Authorization": f"Bearer {admin_token}"})
        assert resp.status_code == 403, resp.text

        # a non-owner admin cannot demote
        resp = api_client.delete(f"{BASE_URL}/api/trips/{tid}/admins/{admin_id}",
                                 headers={"Authorization": f"Bearer {admin_token}"})
        assert resp.status_code == 403, resp.text

        # the owner can promote and demote
        assert self._promote(api_client, owner_token, tid, member_id)["admin_ids"].count(member_id) == 1
        resp = api_client.delete(f"{BASE_URL}/api/trips/{tid}/admins/{member_id}",
                                 headers={"Authorization": f"Bearer {owner_token}"})
        assert resp.status_code == 200, resp.text
        assert member_id not in resp.json()["admin_ids"]

    # -- Ownership transfer ---------------------------------------------------
    def test_transfer_ownership_happy_path(self, api_client, test_user):
        owner_token = test_user["token"]
        old_owner_id = test_user["user"]["id"]
        trip = self._create_trip(api_client, owner_token)
        tid = trip["id"]

        new_token, new_id = self._register_user(api_client, "New Owner")
        self._join(api_client, new_token, trip["code"])

        resp = api_client.post(f"{BASE_URL}/api/trips/{tid}/transfer-ownership",
                               json={"user_id": new_id},
                               headers={"Authorization": f"Bearer {owner_token}"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["owner_id"] == new_id
        assert new_id in data["admin_ids"]            # new owner promoted to admin
        assert old_owner_id in data["admin_ids"]      # previous owner kept as admin

        # new owner can now manage admins
        third_token, third_id = self._register_user(api_client, "Third")
        self._join(api_client, third_token, trip["code"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{tid}/admins", json={"user_id": third_id},
                               headers={"Authorization": f"Bearer {new_token}"})
        assert resp.status_code == 200, resp.text

        # previous owner is now a plain admin: cannot manage admins or transfer
        resp = api_client.post(f"{BASE_URL}/api/trips/{tid}/admins", json={"user_id": third_id},
                               headers={"Authorization": f"Bearer {owner_token}"})
        assert resp.status_code == 403, resp.text
        resp = api_client.post(f"{BASE_URL}/api/trips/{tid}/transfer-ownership",
                               json={"user_id": third_id},
                               headers={"Authorization": f"Bearer {owner_token}"})
        assert resp.status_code == 403, resp.text

    def test_transfer_to_non_member_400(self, api_client, test_user):
        owner_token = test_user["token"]
        trip = self._create_trip(api_client, owner_token)
        _, stranger_id = self._register_user(api_client, "Stranger")
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip['id']}/transfer-ownership",
                               json={"user_id": stranger_id},
                               headers={"Authorization": f"Bearer {owner_token}"})
        assert resp.status_code == 400, resp.text

    def test_transfer_to_self_400(self, api_client, test_user):
        owner_token = test_user["token"]
        owner_id = test_user["user"]["id"]
        trip = self._create_trip(api_client, owner_token)
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip['id']}/transfer-ownership",
                               json={"user_id": owner_id},
                               headers={"Authorization": f"Bearer {owner_token}"})
        assert resp.status_code == 400, resp.text

    def test_transfer_by_non_owner_403(self, api_client, test_user):
        owner_token = test_user["token"]
        trip = self._create_trip(api_client, owner_token)
        tid = trip["id"]
        member_token, member_id = self._register_user(api_client, "Joiner")
        self._join(api_client, member_token, trip["code"])
        # member tries to transfer ownership to themselves
        resp = api_client.post(f"{BASE_URL}/api/trips/{tid}/transfer-ownership",
                               json={"user_id": member_id},
                               headers={"Authorization": f"Bearer {member_token}"})
        assert resp.status_code == 403, resp.text
