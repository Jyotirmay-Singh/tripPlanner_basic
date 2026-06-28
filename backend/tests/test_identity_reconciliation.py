# Phase 11 — Identity reconciliation (one gmail == at most one person per trip).
# Live-server integration tests (requests/BASE_URL style, like test_join.py). Cover the
# preview `match` extension (Step 44), claim/join_new actions + every-path enforcement
# (Step 45), and creation-time uniqueness hardening (Step 46).
import os
import uuid

import pytest

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


class _Base:
    def _register(self, api_client, name="Joiner"):
        email = f"test_recon_{uuid.uuid4().hex[:10]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email, "password": "test12345", "pin": "4321", "name": name,
        })
        if resp.status_code != 200:
            pytest.skip(f"register failed: {resp.status_code} {resp.text}")
        d = resp.json()
        return {"email": email, "name": name, "token": d["access_token"], "id": d["user"]["id"]}

    def _create_trip(self, api_client, token, name="TEST_Recon Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name, "start_date": "2026-01-10", "end_date": "2026-01-15", "currency": "INR",
        }, headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _add_member(self, api_client, token, trip_id, name, kind="individual",
                    family_members=None, email=None):
        body = {"name": name, "kind": kind, "family_members": family_members or []}
        if email is not None:
            body["email"] = email
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json=body,
                               headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _add_expense(self, api_client, token, trip_id, paid_by, split):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense", "amount": 60.0, "category": "Food", "description": "TEST_recon",
            "date": "20-10-26", "paid_by_member_id": paid_by, "split_member_ids": split,
            "split_mode": "PER_CAPITA",
        }, headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["expense"]

    def _add_settlement(self, api_client, token, trip_id, frm, to, amount=10.0):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": frm, "to_member_id": to, "amount": amount,
        }, headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _preview(self, api_client, token, code):
        return api_client.post(f"{BASE_URL}/api/trips/join/preview", json={"code": code},
                               headers=_auth(token))

    def _join(self, api_client, token, payload):
        return api_client.post(f"{BASE_URL}/api/trips/join", json=payload, headers=_auth(token))

    def _get_trip(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _balances(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()


# ============================ Step 44 — PREVIEW match ============================
class TestPreviewMatch(_Base):
    def test_match_individual_stub(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Stub Solo", kind="individual", email=joiner["email"])
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        assert data["match"] is not None
        m = data["match"]
        assert m["member_id"] == stub["id"]
        assert m["member_type"] == "individual"
        assert m["family_id"] is None
        assert m["has_financial_history"] is False
        # individual stub does NOT populate the legacy family-only field
        assert data["matched_family"] is None

    def test_match_family_stub_backcompat(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        fam = self._add_member(api_client, test_user["token"], trip["id"],
                               "TEST_Stub Fam", kind="family", family_members=["Kid"],
                               email=joiner["email"])
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        m = data["match"]
        assert m["member_type"] == "family"
        assert m["member_id"] == fam["id"]
        assert m["family_id"] == fam["id"]
        assert m["family_name"] == "TEST_Stub Fam"
        # legacy field still populated for a family match
        assert data["matched_family"] == {"id": fam["id"], "name": "TEST_Stub Fam"}

    def test_match_history_via_expense(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Hist Solo", kind="individual", email=joiner["email"])
        owner_id = trip["members"][0]["id"]
        self._add_expense(api_client, test_user["token"], trip["id"],
                          paid_by=stub["id"], split=[owner_id, stub["id"]])
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        assert data["match"]["has_financial_history"] is True

    def test_match_history_via_settlement(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Hist Sett", kind="individual", email=joiner["email"])
        owner_id = trip["members"][0]["id"]
        # a PENDING settlement still counts as financial history
        self._add_settlement(api_client, test_user["token"], trip["id"],
                             frm=stub["id"], to=owner_id, amount=5.0)
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        assert data["match"]["has_financial_history"] is True

    def test_no_match_returns_null(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        assert data["match"] is None
        assert data.get("match_conflicts") in (None, [])
