# Phase 25 — Live-API tests for per-member ACCOUNT LINKING (a joiner links to ONE family sub-member).
# Requires a running server + Mongo (same convention as the other *_api.py suites).
import os
import uuid

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _gmail():
    return f"test_link_{uuid.uuid4().hex[:8]}@gmail.com"


class _Helpers:
    def _create_trip(self, api_client, token, name="TEST_Linking Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name, "start_date": "2026-02-10", "end_date": "2026-02-15",
            "currency": "INR",
        }, headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["id"]

    def _get_trip(self, api_client, token, trip_id):
        return api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=_auth(token))

    def _add_family(self, api_client, token, trip_id, **body):
        return api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members",
                               json={"kind": "family", **body}, headers=_auth(token))

    def _register(self, api_client, email):
        reg = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email, "password": "test12345", "pin": "4321", "name": "Joiner"})
        assert reg.status_code == 200, reg.text
        return reg.json()["access_token"], reg.json()["user"]["id"]

    def _preview(self, api_client, token, code):
        return api_client.post(f"{BASE_URL}/api/trips/join/preview",
                               json={"code": code}, headers=_auth(token))

    def _claim_sub(self, api_client, token, code, family_id, sub_id):
        return api_client.post(f"{BASE_URL}/api/trips/join", json={
            "code": code, "action": "claim",
            "member_id": family_id, "family_member_id": sub_id,
        }, headers=_auth(token))


class TestSubMemberClaim(_Helpers):
    def test_preview_returns_family_member_claim_only(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"],
                               family_member_emails=[e, None]).json()
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        jtok, _ = self._register(api_client, e)
        pv = self._preview(api_client, jtok, code)
        assert pv.status_code == 200, pv.text
        match = pv.json()["match"]
        assert match is not None
        assert match["member_type"] == "family_member"
        assert match["member_id"] == fam["id"]
        assert match["family_member_id"] == fam["family_member_ids"][0]
        assert match["member_name"] == "Alice"
        assert match["has_financial_history"] is True  # claim-only signal

    def test_claim_links_account_and_grants_access(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"],
                               family_member_emails=[e, None]).json()
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        jtok, juid = self._register(api_client, e)
        # Before: joiner has no trip access.
        assert self._get_trip(api_client, jtok, trip_id).status_code in (403, 404)
        before = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=_auth(test_user["token"])).json()
        r = self._claim_sub(api_client, jtok, code, fam["id"], fam["family_member_ids"][0])
        assert r.status_code == 200, r.text
        # After: the sub-slot is linked, the joiner has access, is NOT an admin, and (crucially) the
        # family ENTITY user_id is untouched.
        trip = self._get_trip(api_client, jtok, trip_id)
        assert trip.status_code == 200, trip.text
        trip = trip.json()
        f = next(m for m in trip["members"] if m["id"] == fam["id"])
        assert f["family_member_user_ids"][0] == juid
        assert f["family_member_user_ids"][1] is None
        assert f.get("user_id") in (None, "")  # entity NOT claimed
        assert juid in trip["user_ids"]
        assert juid not in trip.get("admin_ids", [])
        after = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=_auth(test_user["token"])).json()
        assert before["net"] == after["net"] and before["transfers"] == after["transfers"]

    def test_two_members_claimed_independently(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e1, e2 = _gmail(), _gmail()
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"],
                               family_member_emails=[e1, e2]).json()
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        t1, u1 = self._register(api_client, e1)
        t2, u2 = self._register(api_client, e2)
        assert self._claim_sub(api_client, t1, code, fam["id"], fam["family_member_ids"][0]).status_code == 200
        assert self._claim_sub(api_client, t2, code, fam["id"], fam["family_member_ids"][1]).status_code == 200
        trip = self._get_trip(api_client, test_user["token"], trip_id).json()
        f = next(m for m in trip["members"] if m["id"] == fam["id"])
        assert f["family_member_user_ids"] == [u1, u2]
        assert u1 in trip["user_ids"] and u2 in trip["user_ids"]

    def test_claim_requires_own_email(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"],
                               family_member_emails=[e, None]).json()
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        # A different-email joiner tries to claim Alice's slot -> 403.
        jtok, _ = self._register(api_client, _gmail())
        r = self._claim_sub(api_client, jtok, code, fam["id"], fam["family_member_ids"][0])
        assert r.status_code == 403, r.text

    def test_claim_is_idempotent(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"],
                               family_member_emails=[e, None]).json()
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        jtok, juid = self._register(api_client, e)
        sid = fam["family_member_ids"][0]
        assert self._claim_sub(api_client, jtok, code, fam["id"], sid).status_code == 200
        assert self._claim_sub(api_client, jtok, code, fam["id"], sid).status_code == 200
        trip = self._get_trip(api_client, test_user["token"], trip_id).json()
        f = next(m for m in trip["members"] if m["id"] == fam["id"])
        assert f["family_member_user_ids"] == [juid, None]  # still exactly one link
        assert trip["user_ids"].count(juid) == 1

    def test_second_claimer_of_same_slot_conflicts(self, api_client, test_user):
        # Two accounts whose emails BOTH map to one slot can't happen under uniqueness; simulate the
        # race by clearing the slot's email after the first claim and pointing a new email at it is
        # not possible either — instead assert the taken-slot guard: a 2nd distinct user claiming an
        # already-linked slot (wrong email) is rejected (covered by own-email 403). Here we assert a
        # re-linked slot stays owned by the first claimer.
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"],
                               family_member_emails=[e, None]).json()
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        t1, u1 = self._register(api_client, e)
        assert self._claim_sub(api_client, t1, code, fam["id"], fam["family_member_ids"][0]).status_code == 200
        # A different user (different email) attempting the same slot is blocked (own-email gate).
        t2, _ = self._register(api_client, _gmail())
        r = self._claim_sub(api_client, t2, code, fam["id"], fam["family_member_ids"][0])
        assert r.status_code == 403, r.text
        trip = self._get_trip(api_client, test_user["token"], trip_id).json()
        f = next(m for m in trip["members"] if m["id"] == fam["id"])
        assert f["family_member_user_ids"][0] == u1

    def test_join_as_new_with_sub_member_email_blocked(self, api_client, test_user):
        # One-email guardrail: a joiner whose email sits on an unclaimed sub-member cannot spawn a
        # duplicate individual — the create path enforces uniqueness (steering them to claim).
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        self._add_family(api_client, test_user["token"], trip_id,
                         name="TEST_Fam", family_members=["Alice", "Bob"],
                         family_member_emails=[e, None])
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        jtok, _ = self._register(api_client, e)
        r = api_client.post(f"{BASE_URL}/api/trips/join", json={
            "code": code, "action": "join_new", "mode": "individual",
        }, headers=_auth(jtok))
        assert r.status_code == 400, r.text


class TestLinkedSubMemberLifecycle(_Helpers):
    def test_edit_round_trip_preserves_link(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"],
                               family_member_emails=[e, None]).json()
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        jtok, juid = self._register(api_client, e)
        assert self._claim_sub(api_client, jtok, code, fam["id"], fam["family_member_ids"][0]).status_code == 200
        # Owner re-saves the SAME roster (client never sends user-ids) -> link + access preserved,
        # and the family's own sub-email doesn't collide with its own linked account (excluded-uids).
        patch = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{fam['id']}", json={
            "name": "TEST_Fam", "kind": "family",
            "family_members": ["Alice", "Bob"],
            "family_member_ids": fam["family_member_ids"],
            "family_member_emails": [e, None],
        }, headers=_auth(test_user["token"]))
        assert patch.status_code == 200, patch.text
        assert patch.json()["family_member_user_ids"] == [juid, None]
        assert self._get_trip(api_client, jtok, trip_id).status_code == 200  # still has access

    def test_delete_family_member_evicts_linked_account(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"],
                               family_member_emails=[e, None]).json()
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        jtok, juid = self._register(api_client, e)
        assert self._claim_sub(api_client, jtok, code, fam["id"], fam["family_member_ids"][0]).status_code == 200
        # Remove Alice (settled: no expenses) -> her linked account loses trip access.
        d = api_client.delete(
            f"{BASE_URL}/api/trips/{trip_id}/members/{fam['id']}/family-members/{fam['family_member_ids'][0]}",
            headers=_auth(test_user["token"]))
        assert d.status_code == 200, d.text
        trip = self._get_trip(api_client, test_user["token"], trip_id).json()
        assert juid not in trip["user_ids"]
        assert self._get_trip(api_client, jtok, trip_id).status_code in (403, 404)

    def test_remove_whole_family_evicts_all_sub_accounts(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e1, e2 = _gmail(), _gmail()
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"],
                               family_member_emails=[e1, e2]).json()
        code = self._get_trip(api_client, test_user["token"], trip_id).json()["code"]
        t1, u1 = self._register(api_client, e1)
        t2, u2 = self._register(api_client, e2)
        assert self._claim_sub(api_client, t1, code, fam["id"], fam["family_member_ids"][0]).status_code == 200
        assert self._claim_sub(api_client, t2, code, fam["id"], fam["family_member_ids"][1]).status_code == 200
        d = api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/members/{fam['id']}",
                              headers=_auth(test_user["token"]))
        assert d.status_code == 200, d.text
        trip = self._get_trip(api_client, test_user["token"], trip_id).json()
        assert u1 not in trip["user_ids"] and u2 not in trip["user_ids"]
