# Phase 24 — Live-API tests for per-member (contact-only) emails on family sub-members.
# Requires a running server + Mongo (same convention as the other *_api.py suites).
import os
import uuid

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _gmail():
    return f"test_pm_{uuid.uuid4().hex[:8]}@gmail.com"


class TestPerMemberEmails:
    def _create_trip(self, api_client, token, name="TEST_PerMemberEmail Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name,
            "start_date": "2026-02-10", "end_date": "2026-02-15",
            "currency": "INR",
        }, headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["id"]

    def _add_family(self, api_client, token, trip_id, **body):
        return api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members",
                               json={"kind": "family", **body}, headers=_auth(token))

    def test_per_member_email_saved_and_read_back(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        resp = self._add_family(api_client, test_user["token"], trip_id,
                                name="TEST_Fam", family_members=["Alice", "Bob"],
                                family_member_emails=[e, None])
        assert resp.status_code == 200, resp.text
        mid = resp.json()["id"]
        trip = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=_auth(test_user["token"])).json()
        fam = next(m for m in trip["members"] if m["id"] == mid)
        assert fam["family_member_emails"] == [e, None]

    def test_non_gmail_sub_email_rejected(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        resp = self._add_family(api_client, test_user["token"], trip_id,
                                name="TEST_Fam", family_members=["Alice"],
                                family_member_emails=["alice@outlook.com"])
        assert resp.status_code == 400, resp.text

    def test_duplicate_within_same_family_rejected(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        resp = self._add_family(api_client, test_user["token"], trip_id,
                                name="TEST_Fam", family_members=["Alice", "Bob"],
                                family_member_emails=[e, e])
        assert resp.status_code == 400, resp.text

    def test_duplicate_across_families_rejected(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        r1 = self._add_family(api_client, test_user["token"], trip_id,
                              name="TEST_FamA", family_members=["Alice"],
                              family_member_emails=[e])
        assert r1.status_code == 200, r1.text
        r2 = self._add_family(api_client, test_user["token"], trip_id,
                              name="TEST_FamB", family_members=["Carl"],
                              family_member_emails=[e])
        assert r2.status_code == 400, r2.text

    def test_sub_email_vs_individual_entity_email_rejected(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        r1 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members",
                             json={"kind": "individual", "name": "TEST_Indiv", "email": e},
                             headers=_auth(test_user["token"]))
        assert r1.status_code == 200, r1.text
        r2 = self._add_family(api_client, test_user["token"], trip_id,
                              name="TEST_Fam", family_members=["Alice"],
                              family_member_emails=[e])
        assert r2.status_code == 400, r2.text

    def test_sub_email_vs_claimed_user_account_email_rejected(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        trip = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=_auth(test_user["token"])).json()
        code = trip["code"]
        # A second real app user joins the trip; their account email is now "claimed" in-trip.
        e2 = _gmail()
        reg = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": e2, "password": "test12345", "pin": "4321", "name": "Joiner"})
        assert reg.status_code == 200, reg.text
        t2 = reg.json()["access_token"]
        j = api_client.post(f"{BASE_URL}/api/trips/join", json={"code": code}, headers=_auth(t2))
        assert j.status_code == 200, j.text
        # Owner tries to reuse the joiner's account email as a family sub-member email.
        resp = self._add_family(api_client, test_user["token"], trip_id,
                                name="TEST_Fam", family_members=["Alice"],
                                family_member_emails=[e2])
        assert resp.status_code == 400, resp.text

    def test_self_exclusion_on_edit(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        e = _gmail()
        resp = self._add_family(api_client, test_user["token"], trip_id,
                                name="TEST_Fam", family_members=["Alice", "Bob"],
                                family_member_emails=[e, None])
        assert resp.status_code == 200, resp.text
        m = resp.json()
        # Re-save the SAME roster + emails -> must not 400 (its own emails are excluded).
        patch = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{m['id']}", json={
            "name": "TEST_Fam", "kind": "family",
            "family_members": ["Alice", "Bob"],
            "family_member_ids": m["family_member_ids"],
            "family_member_emails": [e, None],
        }, headers=_auth(test_user["token"]))
        assert patch.status_code == 200, patch.text
        assert patch.json()["family_member_emails"] == [e, None]

    def test_legacy_family_without_emails_ok(self, api_client, test_user):
        trip_id = self._create_trip(api_client, test_user["token"])
        # No family_member_emails at all (legacy contract) -> 200, stored as all-None parallel array.
        resp = self._add_family(api_client, test_user["token"], trip_id,
                                name="TEST_Legacy", family_members=["Alice", "Bob"])
        assert resp.status_code == 200, resp.text
        assert resp.json()["family_member_emails"] == [None, None]

    def test_edit_add_email_is_balance_neutral(self, api_client, test_user):
        # Adding a per-member email must not change any balance (email is contact-only).
        trip_id = self._create_trip(api_client, test_user["token"])
        fam = self._add_family(api_client, test_user["token"], trip_id,
                               name="TEST_Fam", family_members=["Alice", "Bob"]).json()
        indiv = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members",
                                json={"kind": "individual", "name": "TEST_Solo"},
                                headers=_auth(test_user["token"])).json()
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "description": "Dinner", "amount": 120, "category": "Food",
            "date": "10-02-26", "paid_by_member_id": fam["id"], "split_mode": "PER_CAPITA",
        }, headers=_auth(test_user["token"]))
        before = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=_auth(test_user["token"])).json()
        # Now stamp a per-member email and recheck balances.
        api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{fam['id']}", json={
            "name": "TEST_Fam", "kind": "family",
            "family_members": ["Alice", "Bob"],
            "family_member_ids": fam["family_member_ids"],
            "family_member_emails": [_gmail(), None],
        }, headers=_auth(test_user["token"]))
        after = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=_auth(test_user["token"])).json()
        assert before["net"] == after["net"]
        assert before["transfers"] == after["transfers"]
