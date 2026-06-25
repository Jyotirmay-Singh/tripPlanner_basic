# Settled-only member / family removal (live-server integration tests).
#
# Covers: settled individual removed (incl. expense history), unsettled individual blocked, settled
# family-member removed (>=1 remains), freeze-neutrality of family-member removal, the no-empty-family
# invariant (last member -> remove-family), whole-family all-settled removed, whole-family with an
# unsettled member blocked, admin cannot remove the owner (admin CAN remove a settled plain member),
# and the hard requirement that NO successful removal changes any other balance.
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


class TestMemberRemoval:
    # ---------- helpers ----------
    def _auth(self, token):
        return {"Authorization": f"Bearer {token}"}

    def _create_trip(self, api_client, token, name="TEST_Removal Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name, "start_date": "2026-01-10", "end_date": "2026-01-15", "currency": "USD",
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _register_user(self, api_client, name="Second User"):
        email = f"TEST_rm_{uuid.uuid4().hex[:8]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email, "password": "test12345", "pin": "5678", "name": name,
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        return data["access_token"], data["user"]["id"]

    def _join_trip(self, api_client, token, code):
        resp = api_client.post(f"{BASE_URL}/api/trips/join", json={"code": code},
                               headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _promote_admin(self, api_client, token, trip_id, user_id):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/admins", json={"user_id": user_id},
                               headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _add_member(self, api_client, token, trip_id, name, kind="individual", family_members=None):
        body = {"name": name, "kind": kind}
        if family_members is not None:
            body["family_members"] = family_members
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json=body,
                               headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _add_expense(self, api_client, token, trip_id, amount, paid_by, split_ids,
                     mode="PER_CAPITA"):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense", "amount": amount, "category": "Food", "description": "x",
            "date": "11-05-26", "paid_by_member_id": paid_by, "split_member_ids": split_ids,
            "split_mode": mode,
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _settle(self, api_client, token, trip_id, from_id, to_id, amount):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settle", json={
            "from_member_id": from_id, "to_member_id": to_id, "amount": amount,
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _net(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["net"]

    def _members(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["members"]

    def _delete_member(self, api_client, token, trip_id, member_id):
        return api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/members/{member_id}",
                                 headers=self._auth(token))

    def _delete_family_member(self, api_client, token, trip_id, family_id, fm_id):
        return api_client.delete(
            f"{BASE_URL}/api/trips/{trip_id}/members/{family_id}/family-members/{fm_id}",
            headers=self._auth(token))

    def _assert_unchanged(self, before, after, ids):
        for mid in ids:
            assert after.get(mid) == before.get(mid), f"net changed for {mid}: {before.get(mid)} -> {after.get(mid)}"

    def _get_trip_resp(self, api_client, token, trip_id):
        return api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=self._auth(token))

    def _admin_ids(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/admins", headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["admin_ids"]

    def _patch_expense(self, api_client, token, trip_id, eid, body):
        return api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/expenses/{eid}", json=body,
                                headers=self._auth(token))

    # ---------- (a) individual ----------
    def test_settled_individual_with_history_removed(self, api_client, test_user):
        """Settled member that HAS expense history is removable (200); history kept; A/owner net unchanged."""
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        owner_mid = trip["members"][0]["id"]
        a = self._add_member(api_client, token, tid, "TEST_A")
        b = self._add_member(api_client, token, tid, "TEST_B")
        # A pays 100 split A,B -> A +50, B -50; settle B->A 50 -> both 0.
        self._add_expense(api_client, token, tid, 100.0, a["id"], [a["id"], b["id"]])
        self._settle(api_client, token, tid, b["id"], a["id"], 50.0)
        before = self._net(api_client, token, tid)
        assert before[a["id"]] == 0.0 and before[b["id"]] == 0.0

        resp = self._delete_member(api_client, token, tid, b["id"])
        assert resp.status_code == 200, resp.text
        members = self._members(api_client, token, tid)
        assert all(m["id"] != b["id"] for m in members)
        after = self._net(api_client, token, tid)
        self._assert_unchanged(before, after, [a["id"], owner_mid])

    def test_unsettled_individual_blocked(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        a = self._add_member(api_client, token, tid, "TEST_A")
        b = self._add_member(api_client, token, tid, "TEST_B")
        self._add_expense(api_client, token, tid, 100.0, a["id"], [a["id"], b["id"]])  # B -50
        before = self._net(api_client, token, tid)

        resp = self._delete_member(api_client, token, tid, b["id"])
        assert resp.status_code == 409, resp.text
        assert any(m["id"] == b["id"] for m in self._members(api_client, token, tid))
        self._assert_unchanged(before, self._net(api_client, token, tid), [a["id"], b["id"]])

    # ---------- (b) one member inside a family ----------
    def test_settled_family_member_removed_one_remains(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b"])
        a_id = fam["family_member_ids"][0]

        resp = self._delete_family_member(api_client, token, tid, fam["id"], a_id)
        assert resp.status_code == 200, resp.text
        # P5: consistent shape with delete_member — {"ok": True, "member": <surviving family>}.
        body = resp.json()
        assert body["ok"] is True
        assert body["member"]["family_members"] == ["b"]
        fam_now = next(m for m in self._members(api_client, token, tid) if m["id"] == fam["id"])
        assert fam_now["family_members"] == ["b"]

    def test_family_member_removal_is_balance_neutral(self, api_client, test_user):
        """Removing a settled family member freezes the family's old weight onto past per-capita
        expenses, so the family's net AND the individual's net stay byte-identical."""
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b"])
        ind = self._add_member(api_client, token, tid, "TEST_Ind")
        # I pays 120 split F(2),I -> H=3, F owes 80, I owes 40, I net +80, F net -80; settle F->I 80.
        self._add_expense(api_client, token, tid, 120.0, ind["id"], [fam["id"], ind["id"]])
        self._settle(api_client, token, tid, fam["id"], ind["id"], 80.0)
        before = self._net(api_client, token, tid)
        assert before[fam["id"]] == 0.0 and before[ind["id"]] == 0.0

        resp = self._delete_family_member(api_client, token, tid, fam["id"],
                                          fam["family_member_ids"][0])
        assert resp.status_code == 200, resp.text
        after = self._net(api_client, token, tid)
        self._assert_unchanged(before, after, [fam["id"], ind["id"]])

    def test_unsettled_family_member_blocked(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b"])
        ind = self._add_member(api_client, token, tid, "TEST_Ind")
        self._add_expense(api_client, token, tid, 90.0, ind["id"], [fam["id"], ind["id"]])  # F -60
        resp = self._delete_family_member(api_client, token, tid, fam["id"],
                                          fam["family_member_ids"][0])
        assert resp.status_code == 409, resp.text
        fam_now = next(m for m in self._members(api_client, token, tid) if m["id"] == fam["id"])
        assert fam_now["family_members"] == ["a", "b"]  # untouched

    def test_remove_last_family_member_blocked_then_family_removed(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Solo Fam", kind="family",
                               family_members=["only"])
        # last member cannot be removed as a family-member
        resp = self._delete_family_member(api_client, token, tid, fam["id"],
                                          fam["family_member_ids"][0])
        assert resp.status_code == 409, resp.text
        assert "family" in resp.json()["detail"].lower()
        assert any(m["id"] == fam["id"] for m in self._members(api_client, token, tid))
        # but the whole (settled) family removes cleanly
        resp2 = self._delete_member(api_client, token, tid, fam["id"])
        assert resp2.status_code == 200, resp2.text
        assert all(m["id"] != fam["id"] for m in self._members(api_client, token, tid))

    # ---------- (c) whole family ----------
    def test_settled_whole_family_removed(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        owner_mid = trip["members"][0]["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b", "c"])
        keep = self._add_member(api_client, token, tid, "TEST_Keep")
        before = self._net(api_client, token, tid)

        resp = self._delete_member(api_client, token, tid, fam["id"])
        assert resp.status_code == 200, resp.text
        assert all(m["id"] != fam["id"] for m in self._members(api_client, token, tid))
        self._assert_unchanged(before, self._net(api_client, token, tid), [keep["id"], owner_mid])

    def test_whole_family_removed_keeps_balances_with_history(self, api_client, test_user):
        """A settled family with per-capita history is removable; the other members' nets are
        unchanged because the family's weight is pinned onto its past expenses before the pull."""
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b"])
        ind = self._add_member(api_client, token, tid, "TEST_Ind")
        self._add_expense(api_client, token, tid, 120.0, ind["id"], [fam["id"], ind["id"]])
        self._settle(api_client, token, tid, fam["id"], ind["id"], 80.0)  # F,I -> 0
        before = self._net(api_client, token, tid)
        assert before[fam["id"]] == 0.0 and before[ind["id"]] == 0.0

        resp = self._delete_member(api_client, token, tid, fam["id"])
        assert resp.status_code == 200, resp.text
        after = self._net(api_client, token, tid)
        assert after[ind["id"]] == before[ind["id"]]  # I unchanged after the family is gone

    def test_whole_family_with_unsettled_member_blocked(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b"])
        ind = self._add_member(api_client, token, tid, "TEST_Ind")
        self._add_expense(api_client, token, tid, 90.0, ind["id"], [fam["id"], ind["id"]])  # F -60
        before = self._net(api_client, token, tid)
        resp = self._delete_member(api_client, token, tid, fam["id"])
        assert resp.status_code == 409, resp.text
        assert any(m["id"] == fam["id"] for m in self._members(api_client, token, tid))
        self._assert_unchanged(before, self._net(api_client, token, tid), [fam["id"], ind["id"]])

    # ---------- RBAC composition ----------
    def test_admin_cannot_remove_owner_but_can_remove_settled_member(self, api_client, test_user):
        owner_token = test_user["token"]
        owner_uid = test_user["user"]["id"]
        trip = self._create_trip(api_client, owner_token)
        tid = trip["id"]
        owner_member = next(m for m in trip["members"] if m.get("user_id") == owner_uid)

        admin_token, admin_uid = self._register_user(api_client, "Remover Admin")
        self._join_trip(api_client, admin_token, trip["code"])
        self._promote_admin(api_client, owner_token, tid, admin_uid)

        # admin -> owner member row -> 403
        resp = self._delete_member(api_client, admin_token, tid, owner_member["id"])
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "Cannot remove the trip owner"

        # admin -> a settled plain member -> 200 (admin-on-admin/plain removal allowed)
        plain = self._add_member(api_client, owner_token, tid, "TEST_Plain")
        resp2 = self._delete_member(api_client, admin_token, tid, plain["id"])
        assert resp2.status_code == 200, resp2.text

    def test_non_admin_and_non_member_blocked(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b"])

        member_token, _ = self._register_user(api_client, "Plain Member")
        self._join_trip(api_client, member_token, trip["code"])
        outsider_token, _ = self._register_user(api_client, "Outsider")  # never joins

        assert self._delete_member(api_client, member_token, tid, fam["id"]).status_code == 403
        assert self._delete_member(api_client, outsider_token, tid, fam["id"]).status_code == 403
        fmid = fam["family_member_ids"][0]
        assert self._delete_family_member(api_client, member_token, tid, fam["id"], fmid).status_code == 403
        assert self._delete_family_member(api_client, outsider_token, tid, fam["id"], fmid).status_code == 403
        # untouched
        assert any(m["id"] == fam["id"] for m in self._members(api_client, token, tid))

    def test_unauthenticated_blocked(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b"])
        no_auth = {"Content-Type": "application/json"}
        d1 = api_client.delete(f"{BASE_URL}/api/trips/{tid}/members/{fam['id']}", headers=no_auth)
        assert d1.status_code == 401, d1.text
        d2 = api_client.delete(
            f"{BASE_URL}/api/trips/{tid}/members/{fam['id']}/family-members/{fam['family_member_ids'][0]}",
            headers=no_auth)
        assert d2.status_code == 401, d2.text

    # ---------- P2: app-user eviction + rejoin ----------
    def test_removing_app_user_member_revokes_access_and_allows_rejoin(self, api_client, test_user):
        """Removing an app-user member evicts them from user_ids (access) + admin_ids (rights), and
        they can rejoin to get a FRESH member row instead of being left a ghost with lingering access."""
        owner_token = test_user["token"]
        trip = self._create_trip(api_client, owner_token)
        tid = trip["id"]
        u2_token, u2_uid = self._register_user(api_client, "Evicted User")
        self._join_trip(api_client, u2_token, trip["code"])
        self._promote_admin(api_client, owner_token, tid, u2_uid)

        u2_member = next(m for m in self._members(api_client, owner_token, tid)
                         if m.get("user_id") == u2_uid)
        # before: U2 is an admin who can read the trip
        assert self._get_trip_resp(api_client, u2_token, tid).status_code == 200
        assert u2_uid in self._admin_ids(api_client, owner_token, tid)

        resp = self._delete_member(api_client, owner_token, tid, u2_member["id"])
        assert resp.status_code == 200, resp.text

        # after: gone from roster, access revoked (403), admin rights revoked
        assert all(m.get("user_id") != u2_uid for m in self._members(api_client, owner_token, tid))
        assert self._get_trip_resp(api_client, u2_token, tid).status_code == 403
        assert u2_uid not in self._admin_ids(api_client, owner_token, tid)

        # U2 can rejoin and receives a brand-new member row (different id)
        self._join_trip(api_client, u2_token, trip["code"])
        u2_rows = [m for m in self._members(api_client, owner_token, tid) if m.get("user_id") == u2_uid]
        assert len(u2_rows) == 1
        assert u2_rows[0]["id"] != u2_member["id"]

    # ---------- P4: freeze pin survives a later expense edit ----------
    def test_freeze_pin_survives_expense_edit_after_family_removal(self, api_client, test_user):
        """After a whole-family removal pins the family's weight onto a past per-capita expense,
        editing that expense (client resends weight_snapshots rebuilt from the live roster, which no
        longer contains the family) must NOT drop the pin — the surviving member's net stays neutral."""
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b"])
        ind = self._add_member(api_client, token, tid, "TEST_Ind")
        exp = self._add_expense(api_client, token, tid, 120.0, ind["id"], [fam["id"], ind["id"]])
        eid = exp["expense"]["id"]
        self._settle(api_client, token, tid, fam["id"], ind["id"], 80.0)  # F,I -> 0
        before = self._net(api_client, token, tid)
        assert before[fam["id"]] == 0.0 and before[ind["id"]] == 0.0

        assert self._delete_member(api_client, token, tid, fam["id"]).status_code == 200
        assert self._net(api_client, token, tid)[ind["id"]] == before[ind["id"]]

        # Simulate the edit screen: drop weight_snapshots (rebuilt from a roster without the family).
        # Without the P4 pin-merge, the dead family would default to weight 1 -> I's net shifts to -20.
        r = self._patch_expense(api_client, token, tid, eid, {"amount": 120.0, "weight_snapshots": None})
        assert r.status_code == 200, r.text
        assert self._net(api_client, token, tid)[ind["id"]] == before[ind["id"]]

    # ---------- family-member endpoint validation ----------
    def test_family_member_endpoint_rejects_individual(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        ind = self._add_member(api_client, token, tid, "TEST_Ind")
        resp = self._delete_family_member(api_client, token, tid, ind["id"], "whatever")
        assert resp.status_code == 404, resp.text

    def test_family_member_endpoint_unknown_member_id(self, api_client, test_user):
        token = test_user["token"]
        trip = self._create_trip(api_client, token)
        tid = trip["id"]
        fam = self._add_member(api_client, token, tid, "TEST_Fam", kind="family",
                               family_members=["a", "b"])
        resp = self._delete_family_member(api_client, token, tid, fam["id"], str(uuid.uuid4()))
        assert resp.status_code == 404, resp.text
