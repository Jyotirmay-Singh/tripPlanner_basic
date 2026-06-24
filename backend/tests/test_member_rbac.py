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
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "USD",
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _register_user(self, api_client, name="Second User"):
        email = f"TEST_memrbac_{uuid.uuid4().hex[:8]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "test12345",
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

    # ---------- the owner's member row cannot be removed ----------
    def test_admin_cannot_remove_owner_member(self, api_client, test_user):
        # The owner's member row is the trip root: neither a promoted admin nor the owner
        # themselves can delete it (mirrors remove_admin's root-admin protection). The owner
        # stays on the roster either way.
        owner_token = test_user["token"]
        owner_uid = test_user["user"]["id"]
        trip = self._create_trip(api_client, owner_token)
        tid = trip["id"]
        owner_member = next(m for m in trip["members"] if m.get("user_id") == owner_uid)

        admin_token, admin_uid = self._register_user(api_client, "Owner-Remover Admin")
        self._join_trip(api_client, admin_token, trip["code"])
        self._promote_admin(api_client, owner_token, tid, admin_uid)

        # promoted admin -> 403
        resp = self._delete_member(api_client, admin_token, tid, owner_member["id"])
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "Cannot remove the trip owner"

        # the owner cannot delete their own root member row either -> 403
        resp = self._delete_member(api_client, owner_token, tid, owner_member["id"])
        assert resp.status_code == 403, resp.text

        # owner still on the roster
        members = self._get_members(api_client, owner_token, tid)
        assert any(m["id"] == owner_member["id"] for m in members)

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

    # ---------- gap 1: unauthenticated / invalid token -> 401 ----------
    def test_unauthenticated_member_mutations_rejected(self, api_client, test_user):
        # get_current_user runs before the admin guard: a missing OR malformed bearer
        # token is rejected with 401 on all three mutation endpoints.
        trip = self._create_trip(api_client, test_user["token"])
        m = self._add_member(api_client, test_user["token"], trip["id"], "TEST_Auth Target").json()
        tid, mid = trip["id"], m["id"]

        no_auth = {"Content-Type": "application/json"}  # no Authorization header
        bad_auth = {"Content-Type": "application/json", "Authorization": "Bearer not-a-real-token"}
        for headers in (no_auth, bad_auth):
            add = api_client.post(f"{BASE_URL}/api/trips/{tid}/members",
                                  json={"name": "TEST_NoAuth", "kind": "individual"}, headers=headers)
            assert add.status_code == 401, add.text
            upd = api_client.patch(f"{BASE_URL}/api/trips/{tid}/members/{mid}",
                                   json={"name": "TEST_NoAuth"}, headers=headers)
            assert upd.status_code == 401, upd.text
            dele = api_client.delete(f"{BASE_URL}/api/trips/{tid}/members/{mid}", headers=headers)
            assert dele.status_code == 401, dele.text

    # ---------- gap 2: non-admin cannot trigger family-resize reallocation ----------
    def test_non_admin_cannot_trigger_family_reallocation(self, api_client, test_user):
        # A family resize re-allocates past PER_CAPITA expenses (Step 8). A non-admin must be
        # blocked (403) BEFORE the reweight runs — proven by unchanged family size AND balances.
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Realloc Fam",
                               kind="family", family_members=["a", "b"]).json()
        ind = self._add_member(api_client, token, tid, "TEST_Realloc Ind").json()

        exp = api_client.post(f"{BASE_URL}/api/trips/{tid}/expenses", json={
            "kind": "expense", "amount": 120.0, "category": "Food", "description": "x",
            "date": "11-05-26", "paid_by_member_id": ind["id"],
            "split_member_ids": [fam["id"], ind["id"]], "split_mode": "PER_CAPITA",
        }, headers=self._auth(token))
        assert exp.status_code == 200, exp.text

        def net():
            r = api_client.get(f"{BASE_URL}/api/trips/{tid}/balances", headers=self._auth(token))
            assert r.status_code == 200, r.text
            return r.json()["net"]
        before = net()

        member_token, _ = self._register_user(api_client, "Realloc Attacker")
        self._join_trip(api_client, member_token, trip["code"])
        resp = self._update_member(api_client, member_token, tid, fam["id"],
                                   {"family_members": ["a", "b", "c", "d"], "reweight_past": True})
        assert resp.status_code == 403, resp.text

        fam_now = next(x for x in self._get_members(api_client, token, tid) if x["id"] == fam["id"])
        assert fam_now["family_members"] == ["a", "b"]  # size unchanged
        # reallocation never fired: the fam/ind nets are untouched (a new net-0 entry for the
        # joined attacker is expected and irrelevant, so compare the affected members only).
        after = net()
        assert after[fam["id"]] == before[fam["id"]]
        assert after[ind["id"]] == before[ind["id"]]

    # ---------- gap 3: distinct 403 messages (non-member vs non-admin) ----------
    def test_403_messages_distinguish_non_member_vs_non_admin(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        m = self._add_member(api_client, token, tid, "TEST_Msg Target").json()

        outsider_token, _ = self._register_user(api_client, "Msg Outsider")  # never joins
        r_out = self._update_member(api_client, outsider_token, tid, m["id"], {"name": "TEST_X"})
        assert r_out.status_code == 403, r_out.text
        assert r_out.json()["detail"] == "Not a member of this trip"

        member_token, _ = self._register_user(api_client, "Msg Member")
        self._join_trip(api_client, member_token, trip["code"])
        r_mem = self._update_member(api_client, member_token, tid, m["id"], {"name": "TEST_X"})
        assert r_mem.status_code == 403, r_mem.text
        assert r_mem.json()["detail"] == "Admin privileges required"

    # ---------- gap 5: admin can still perform individual->family in-place merge ----------
    def test_admin_can_merge_individual_into_family_in_place(self, api_client, test_user):
        # The lock must not break the legit merge path: an admin adding a family whose email
        # matches an existing individual app-user converts that member IN-PLACE (same id).
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]

        joiner_email = f"TEST_merge_{uuid.uuid4().hex[:8]}@gmail.com"
        reg = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": joiner_email, "password": "test12345", "pin": "5678", "name": "Merge Joiner",
        })
        assert reg.status_code == 200, reg.text
        self._join_trip(api_client, reg.json()["access_token"], trip["code"])
        joined = next(x for x in self._get_members(api_client, token, tid)
                      if (x.get("email") or "").lower() == joiner_email.lower())
        assert joined["kind"] == "individual"

        resp = api_client.post(f"{BASE_URL}/api/trips/{tid}/members", json={
            "name": "TEST_Merged Family", "kind": "family",
            "family_members": ["x", "y"], "email": joiner_email,
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        merged = resp.json()
        assert merged["id"] == joined["id"]  # merged in place, member id preserved
        assert merged["kind"] == "family"
        assert merged["family_members"] == ["x", "y"]
