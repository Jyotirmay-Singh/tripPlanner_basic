# Phase 10: settlement history + mark-as-paid (lifecycle, history, RBAC, offset semantics).
# Live API tests (mirror test_balances_reports.py — they hit a running server via requests),
# plus a pure unit test for the can_mark_settlement_paid gate.
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _register(api_client):
    """Register a fresh user; return {token, id, email}."""
    email = f"test_{uuid.uuid4().hex[:8]}@gmail.com"
    resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
        "email": email, "password": "test12345", "pin": "4321", "name": "Settle Tester",
    })
    if resp.status_code != 200:
        pytest.skip(f"User registration failed: {resp.status_code}")
    data = resp.json()
    return {"token": data["access_token"], "id": data["user"]["id"], "email": email}


def _make_trip_two_members(api_client, owner_token):
    """Owner creates a trip; a second user (userB) joins as an individual.

    Returns (trip_id, owner_member_id, b_member_id, userB). The owner's member is the trip root
    (admin); userB's member is a plain non-admin member linked to userB's account (a valid lender).
    """
    trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
        "name": "TEST_Settlement Trip",
        "start_date": "2026-01-10", "end_date": "2026-01-15",
        "currency": "INR",
    }, headers=_auth(owner_token))
    trip = trip_resp.json()
    trip_id = trip["id"]
    code = trip["code"]
    owner_member_id = trip["members"][0]["id"]

    user_b = _register(api_client)
    join_resp = api_client.post(f"{BASE_URL}/api/trips/join", json={
        "code": code, "mode": "individual",
    }, headers=_auth(user_b["token"]))
    assert join_resp.status_code == 200, join_resp.text
    joined = join_resp.json()
    b_member_id = next(m["id"] for m in joined["members"] if m.get("user_id") == user_b["id"])
    return trip_id, owner_member_id, b_member_id, user_b


def _add_expense(api_client, token, trip_id, paid_by, amount=200.0):
    api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
        "kind": "expense", "amount": amount, "category": "Food", "description": "Dinner",
        "date": "11-03-27", "paid_by_member_id": paid_by, "split_member_ids": [],
    }, headers=_auth(token))


def _balances(api_client, token, trip_id):
    return api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=_auth(token)).json()


class TestSettlementLifecycle:
    """Create (pending) → list → mark paid, and the offset semantics."""

    def test_create_pending_does_not_offset_balances(self, api_client, test_user):
        trip_id, m_owner, m_b, _user_b = _make_trip_two_members(api_client, test_user["token"])
        # Owner paid 200 split between the two members -> m_b owes m_owner 100.
        _add_expense(api_client, test_user["token"], trip_id, paid_by=m_owner, amount=200.0)
        before = _balances(api_client, test_user["token"], trip_id)
        assert abs(before["net"][m_owner] - 100.0) < 0.01
        assert abs(before["net"][m_b] - (-100.0)) < 0.01

        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 100.0,
        }, headers=_auth(test_user["token"]))
        assert resp.status_code == 200, resp.text
        doc = resp.json()
        assert doc["status"] == "pending"
        assert doc["paid_at"] is None
        assert doc["recorded_by"] == test_user["user"]["id"]

        # Pending must NOT change balances.
        after = _balances(api_client, test_user["token"], trip_id)
        assert abs(after["net"][m_owner] - 100.0) < 0.01
        assert abs(after["net"][m_b] - (-100.0)) < 0.01
        assert len(after["transfers"]) == 1  # still suggested

    def test_list_history_newest_first(self, api_client, test_user):
        trip_id, m_owner, m_b, _user_b = _make_trip_two_members(api_client, test_user["token"])
        first = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 10.0,
        }, headers=_auth(test_user["token"])).json()
        second = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_owner, "to_member_id": m_b, "amount": 20.0,
        }, headers=_auth(test_user["token"])).json()

        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/settlements", headers=_auth(test_user["token"]))
        assert resp.status_code == 200
        rows = resp.json()
        ids = [r["id"] for r in rows]
        assert first["id"] in ids and second["id"] in ids
        # newest-first by created_at
        assert rows[0]["created_at"] >= rows[-1]["created_at"]

    def test_mark_paid_offsets_balances(self, api_client, test_user):
        trip_id, m_owner, m_b, _user_b = _make_trip_two_members(api_client, test_user["token"])
        _add_expense(api_client, test_user["token"], trip_id, paid_by=m_owner, amount=200.0)
        sid = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 100.0,
        }, headers=_auth(test_user["token"])).json()["id"]

        # Owner is an admin -> may mark paid.
        resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/settlements/{sid}", json={
            "status": "paid",
        }, headers=_auth(test_user["token"]))
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "paid"
        assert resp.json()["paid_at"] is not None

        after = _balances(api_client, test_user["token"], trip_id)
        assert abs(after["net"][m_owner]) < 0.01
        assert abs(after["net"][m_b]) < 0.01
        assert len(after["transfers"]) == 0  # fully settled

    def test_mark_paid_is_idempotent(self, api_client, test_user):
        trip_id, m_owner, m_b, _user_b = _make_trip_two_members(api_client, test_user["token"])
        _add_expense(api_client, test_user["token"], trip_id, paid_by=m_owner, amount=200.0)
        sid = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 100.0,
        }, headers=_auth(test_user["token"])).json()["id"]
        h = _auth(test_user["token"])
        api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/settlements/{sid}", json={"status": "paid"}, headers=h)
        once = _balances(api_client, test_user["token"], trip_id)
        # Second mark-paid: still 200, no double offset.
        resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/settlements/{sid}", json={"status": "paid"}, headers=h)
        assert resp.status_code == 200
        assert resp.json()["status"] == "paid"
        twice = _balances(api_client, test_user["token"], trip_id)
        assert once["net"] == twice["net"]


class TestSettlementRBAC:
    def test_lender_can_mark_paid(self, api_client, test_user):
        # to_member = m_b (userB, a non-admin member) -> userB is the lender and may mark paid.
        trip_id, m_owner, m_b, user_b = _make_trip_two_members(api_client, test_user["token"])
        sid = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_owner, "to_member_id": m_b, "amount": 50.0,
        }, headers=_auth(test_user["token"])).json()["id"]
        resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/settlements/{sid}", json={
            "status": "paid",
        }, headers=_auth(user_b["token"]))
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "paid"

    def test_unrelated_member_cannot_mark_paid(self, api_client, test_user):
        trip_id, m_owner, m_b, user_b = _make_trip_two_members(api_client, test_user["token"])
        # A third member (userC): neither admin nor the lender of this settlement.
        user_c = _register(api_client)
        trip = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=_auth(test_user["token"])).json()
        api_client.post(f"{BASE_URL}/api/trips/join", json={"code": trip["code"], "mode": "individual"},
                        headers=_auth(user_c["token"]))
        sid = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_owner, "to_member_id": m_b, "amount": 50.0,
        }, headers=_auth(test_user["token"])).json()["id"]
        resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/settlements/{sid}", json={
            "status": "paid",
        }, headers=_auth(user_c["token"]))
        assert resp.status_code == 403

    def test_non_member_blocked_everywhere(self, api_client, test_user):
        trip_id, m_owner, m_b, _user_b = _make_trip_two_members(api_client, test_user["token"])
        sid = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 50.0,
        }, headers=_auth(test_user["token"])).json()["id"]
        outsider = _register(api_client)
        h = _auth(outsider["token"])
        assert api_client.get(f"{BASE_URL}/api/trips/{trip_id}/settlements", headers=h).status_code == 403
        assert api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 5.0,
        }, headers=h).status_code == 403
        assert api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/settlements/{sid}", json={
            "status": "paid",
        }, headers=h).status_code == 403


class TestSettlementValidation:
    def test_rejects_bad_input(self, api_client, test_user):
        trip_id, m_owner, m_b, _user_b = _make_trip_two_members(api_client, test_user["token"])
        h = _auth(test_user["token"])
        # amount <= 0
        assert api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 0.0,
        }, headers=h).status_code == 400
        # from == to
        assert api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_owner, "to_member_id": m_owner, "amount": 10.0,
        }, headers=h).status_code == 400
        # unknown member id
        assert api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_b, "to_member_id": "no-such-member", "amount": 10.0,
        }, headers=h).status_code == 400

    def test_mark_paid_unknown_settlement_404(self, api_client, test_user):
        trip_id, *_ = _make_trip_two_members(api_client, test_user["token"])
        resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/settlements/ghost", json={
            "status": "paid",
        }, headers=_auth(test_user["token"]))
        assert resp.status_code == 404


class TestLegacySettleBackCompat:
    def test_legacy_settle_stamps_paid_and_offsets(self, api_client, test_user):
        trip_id, m_owner, m_b, _user_b = _make_trip_two_members(api_client, test_user["token"])
        _add_expense(api_client, test_user["token"], trip_id, paid_by=m_owner, amount=200.0)
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settle", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 100.0,
        }, headers=_auth(test_user["token"]))
        assert resp.status_code == 200
        assert resp.json()["status"] == "paid"
        after = _balances(api_client, test_user["token"], trip_id)
        assert abs(after["net"][m_owner]) < 0.01
        assert abs(after["net"][m_b]) < 0.01


class TestCanMarkSettlementPaidPure:
    """Pure unit test for the RBAC predicate (no server/DB)."""

    def _trip(self):
        return {
            "owner_id": "owner-u", "admin_ids": ["owner-u", "admin-u"],
            "user_ids": ["owner-u", "admin-u", "lender-u", "other-u"],
            "members": [
                {"id": "m-owner", "user_id": "owner-u"},
                {"id": "m-lender", "user_id": "lender-u"},
                {"id": "m-other", "user_id": "other-u"},
            ],
        }

    def test_admin_allowed(self):
        from utils.deps import can_mark_settlement_paid
        s = {"to_member_id": "m-lender"}
        assert can_mark_settlement_paid(self._trip(), s, "admin-u") is True
        assert can_mark_settlement_paid(self._trip(), s, "owner-u") is True

    def test_lender_allowed(self):
        from utils.deps import can_mark_settlement_paid
        s = {"to_member_id": "m-lender"}
        assert can_mark_settlement_paid(self._trip(), s, "lender-u") is True

    def test_other_member_denied(self):
        from utils.deps import can_mark_settlement_paid
        s = {"to_member_id": "m-lender"}
        assert can_mark_settlement_paid(self._trip(), s, "other-u") is False

    def test_unknown_to_member_denied(self):
        from utils.deps import can_mark_settlement_paid
        s = {"to_member_id": "ghost"}
        assert can_mark_settlement_paid(self._trip(), s, "lender-u") is False
