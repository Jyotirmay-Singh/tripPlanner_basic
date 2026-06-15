# Step 11: Member Administration Locks
# Member mutation endpoints (POST/PATCH/DELETE /trips/{id}/members) are admin-only.
# Owner (root admin) and promoted admins may mutate; non-admin members and
# non-members get 403. The admin check runs BEFORE resource lookups, so a non-admin
# targeting a missing member id still gets 403 (not 404) — no roster info leak.
# Self-service POST /trips/join stays open to non-admins (regression guard).
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


class TestMemberRBAC:
    """Member add/update/delete access control: trip-admin only."""

    # ---------- helpers ----------
    def _auth(self, token):
        return {"Authorization": f"Bearer {token}"}

    def _create_trip(self, api_client, token, name="TEST_MemRBAC Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name,
            "travel_date": "15-05-26",
            "currency": "USD",
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _register_user(self, api_client, name="Second User"):
        email = f"TEST_memrbac_{uuid.uuid4().hex[:8]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "test1234",
            "pin": "5678",
            "name": name,
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        return data["access_token"], data["user"]["id"]

    def _join_trip(self, api_client, token, code):
        resp = api_client.post(f"{BASE_URL}/api/trips/join", json={
            "code": code,
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _promote_admin(self, api_client, token, trip_id, user_id):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/admins", json={
            "user_id": user_id,
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _add_member(self, api_client, token, trip_id, name, kind="individual",
                    family_members=None):
        body = {"name": name, "kind": kind}
        if family_members is not None:
            body["family_members"] = family_members
        return api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members",
                               json=body, headers=self._auth(token))

    def _update_member(self, api_client, token, trip_id, member_id, body):
        return api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}",
                                json=body, headers=self._auth(token))

    def _delete_member(self, api_client, token, trip_id, member_id):
        return api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}",
                                 headers=self._auth(token))

    def _get_members(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}",
                              headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["members"]

    # ---------- owner (root admin) can mutate ----------
    def test_owner_can_add_member(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        resp = self._add_member(api_client, test_user["token"], trip["id"], "TEST_Owner Added")
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "TEST_Owner Added"

    def test_owner_can_update_member(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        m = self._add_member(api_client, test_user["token"], trip["id"], "TEST_Before").json()
        resp = self._update_member(api_client, test_user["token"], trip["id"], m["id"],
                                   {"name": "TEST_After"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "TEST_After"

    def test_owner_can_delete_member_no_expenses(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        m = self._add_member(api_client, test_user["token"], trip["id"], "TEST_Deletable").json()
        resp = self._delete_member(api_client, test_user["token"], trip["id"], m["id"])
        assert resp.status_code == 200, resp.text
        members = self._get_members(api_client, test_user["token"], trip["id"])
        assert all(x["id"] != m["id"] for x in members)

    # ---------- promoted admin can mutate ----------
    def test_promoted_admin_can_add_update_delete_member(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        admin_token, admin_uid = self._register_user(api_client, "Promotable Admin")
        self._join_trip(api_client, admin_token, trip["code"])
        self._promote_admin(api_client, test_user["token"], trip["id"], admin_uid)

        # add
        add_resp = self._add_member(api_client, admin_token, trip["id"], "TEST_By Promoted")
        assert add_resp.status_code == 200, add_resp.text
        new_id = add_resp.json()["id"]
        # update
        upd_resp = self._update_member(api_client, admin_token, trip["id"], new_id,
                                       {"name": "TEST_By Promoted Edited"})
        assert upd_resp.status_code == 200, upd_resp.text
        # delete
        del_resp = self._delete_member(api_client, admin_token, trip["id"], new_id)
        assert del_resp.status_code == 200, del_resp.text

    # ---------- non-admin member is blocked ----------
    def test_non_admin_member_add_forbidden(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_token, _ = self._register_user(api_client, "Plain Member")
        self._join_trip(api_client, member_token, trip["code"])

        before = len(self._get_members(api_client, test_user["token"], trip["id"]))
        resp = self._add_member(api_client, member_token, trip["id"], "TEST_Sneaky Add")
        assert resp.status_code == 403, resp.text
        after = len(self._get_members(api_client, test_user["token"], trip["id"]))
        assert after == before  # roster unchanged

    def test_non_admin_member_update_forbidden(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        m = self._add_member(api_client, test_user["token"], trip["id"], "TEST_Protected").json()
        member_token, _ = self._register_user(api_client, "Plain Member")
        self._join_trip(api_client, member_token, trip["code"])

        resp = self._update_member(api_client, member_token, trip["id"], m["id"],
                                   {"name": "TEST_Hacked Name"})
        assert resp.status_code == 403, resp.text
        members = self._get_members(api_client, test_user["token"], trip["id"])
        target = next(x for x in members if x["id"] == m["id"])
        assert target["name"] == "TEST_Protected"  # unchanged

    def test_non_admin_member_delete_forbidden(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        m = self._add_member(api_client, test_user["token"], trip["id"], "TEST_Keep Me").json()
        member_token, _ = self._register_user(api_client, "Plain Member")
        self._join_trip(api_client, member_token, trip["code"])

        resp = self._delete_member(api_client, member_token, trip["id"], m["id"])
        assert resp.status_code == 403, resp.text
        members = self._get_members(api_client, test_user["token"], trip["id"])
        assert any(x["id"] == m["id"] for x in members)  # still present

    # ---------- non-member is blocked ----------
    def test_non_member_add_update_delete_forbidden(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        m = self._add_member(api_client, test_user["token"], trip["id"], "TEST_Owned").json()
        outsider_token, _ = self._register_user(api_client, "Outsider")  # never joins

        add_resp = self._add_member(api_client, outsider_token, trip["id"], "TEST_Outsider Add")
        assert add_resp.status_code == 403, add_resp.text
        upd_resp = self._update_member(api_client, outsider_token, trip["id"], m["id"],
                                       {"name": "TEST_Outsider Edit"})
        assert upd_resp.status_code == 403, upd_resp.text
        del_resp = self._delete_member(api_client, outsider_token, trip["id"], m["id"])
        assert del_resp.status_code == 403, del_resp.text

    # ---------- admin check precedes resource check (no info leak) ----------
    def test_admin_check_precedes_resource_check(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_token, _ = self._register_user(api_client, "Plain Member")
        self._join_trip(api_client, member_token, trip["code"])
        bogus_id = str(uuid.uuid4())

        # non-admin targeting a non-existent member -> 403 (NOT 404)
        upd_resp = self._update_member(api_client, member_token, trip["id"], bogus_id,
                                       {"name": "TEST_Nope"})
        assert upd_resp.status_code == 403, upd_resp.text
        del_resp = self._delete_member(api_client, member_token, trip["id"], bogus_id)
        assert del_resp.status_code == 403, del_resp.text

    def test_admin_resource_contract_for_missing_member(self, api_client, test_user):
        # Confirms the admin check does not swallow the route's own resource handling:
        # PATCH 404s on a missing member, while DELETE is idempotent (no existence check,
        # pre-existing behavior) and returns 200. Either way an authorized admin reaches
        # the route body — the asymmetry is the existing contract, not changed by Step 11.
        trip = self._create_trip(api_client, test_user["token"])
        bogus_id = str(uuid.uuid4())

        upd_resp = self._update_member(api_client, test_user["token"], trip["id"], bogus_id,
                                       {"name": "TEST_Nope"})
        assert upd_resp.status_code == 404, upd_resp.text
        del_resp = self._delete_member(api_client, test_user["token"], trip["id"], bogus_id)
        assert del_resp.status_code == 200, del_resp.text  # idempotent no-op

    # ---------- regression: join is NOT locked ----------
    def test_join_still_open_to_non_admin(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner_token, joiner_uid = self._register_user(api_client, "Fresh Joiner")

        joined = self._join_trip(api_client, joiner_token, trip["code"])  # asserts 200 inside
        assert any(m.get("user_id") == joiner_uid for m in joined["members"])
