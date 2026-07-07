"""BREAK-IT-ALL QA campaign — live-API Settle-Up / Payments probes (Phase 10 + 20).

Requires a running backend (mirrors test_payments.py: hits BASE_URL via requests). Run against a
LOCAL DISPOSABLE backend only — several probes are intentionally destructive (NaN ledger-poison,
concurrent overpayment race, legacy /settle abuse).

Convention for this file:
  * Plain tests assert CORRECT behavior and are expected to PASS.
  * ``@pytest.mark.xfail`` tests assert the SECURE / spec expectation for a SUSPECTED bug:
      - XFAIL  => the bug is CONFIRMED (secure assertion failed).
      - XPASS  => the hypothesis is REFUTED (the code is actually safe).
    This keeps the run non-red while precisely flagging each finding for the report.
"""
import json
import uuid
import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _register(api_client):
    email = f"hunt_{uuid.uuid4().hex[:8]}@gmail.com"
    resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
        "email": email, "password": "test12345", "pin": "4321", "name": "Hunt Tester",
    })
    if resp.status_code != 200:
        pytest.skip(f"registration failed: {resp.status_code}")
    data = resp.json()
    return {"token": data["access_token"], "id": data["user"]["id"], "email": email}


def _make_trip_two_members(api_client, owner_token):
    """Owner creates a trip; userB joins as an individual (a valid receiver, non-admin)."""
    trip = api_client.post(f"{BASE_URL}/api/trips", json={
        "name": "TEST_Hunt Trip", "start_date": "2026-01-10", "end_date": "2026-01-15",
        "currency": "INR",
    }, headers=_auth(owner_token)).json()
    owner_member_id = trip["members"][0]["id"]
    user_b = _register(api_client)
    joined = api_client.post(f"{BASE_URL}/api/trips/join", json={
        "code": trip["code"], "mode": "individual",
    }, headers=_auth(user_b["token"])).json()
    b_member_id = next(m["id"] for m in joined["members"] if m.get("user_id") == user_b["id"])
    return trip["id"], owner_member_id, b_member_id, user_b


def _add_expense(api_client, token, trip_id, paid_by, amount=200.0):
    return api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
        "kind": "expense", "amount": amount, "category": "Food", "description": "Dinner",
        "date": "11-03-27", "paid_by_member_id": paid_by, "split_member_ids": [],
    }, headers=_auth(token))


def _balances(api_client, token, trip_id):
    return api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=_auth(token)).json()


def _transfer(bal, from_id, to_id):
    for t in bal["transfers"]:
        if t["from_member_id"] == from_id and t["to_member_id"] == to_id:
            return t["amount"]
    return 0.0


def _b_owes_owner(api_client, owner_token):
    """m_b owes m_owner 100 (owner paid 200 split 2). Creditor = owner (admin)."""
    trip_id, m_owner, m_b, user_b = _make_trip_two_members(api_client, owner_token)
    _add_expense(api_client, owner_token, trip_id, paid_by=m_owner, amount=200.0)
    return trip_id, m_owner, m_b, user_b


def _owner_owes_b(api_client, owner_token):
    """m_owner owes m_b 100 (userB paid 200 split 2). Creditor = userB (non-admin receiver)."""
    trip_id, m_owner, m_b, user_b = _make_trip_two_members(api_client, owner_token)
    _add_expense(api_client, owner_token, trip_id, paid_by=m_b, amount=200.0)
    return trip_id, m_owner, m_b, user_b


# --------------------------------------------------------------------------------------------------
class TestRbacLeaks:
    def test_payer_cannot_record_their_own_debt(self, api_client, test_user):
        # userB is the DEBTOR (payer). They must not self-record their debt as paid.
        trip_id, m_owner, m_b, user_b = _b_owes_owner(api_client, test_user["token"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 50.0,
        }, headers=_auth(user_b["token"]))
        assert resp.status_code == 403, resp.text

    def test_receiver_nonadmin_can_record(self, api_client, test_user):
        # userB is the CREDITOR/receiver (non-admin) -> allowed.
        trip_id, m_owner, m_b, user_b = _owner_owes_b(api_client, test_user["token"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_owner, "to_member_id": m_b, "amount": 50.0,
        }, headers=_auth(user_b["token"]))
        assert resp.status_code == 200, resp.text

    def test_admin_owner_can_record(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 50.0,
        }, headers=_auth(test_user["token"]))
        assert resp.status_code == 200, resp.text

    def test_unrelated_member_cannot_record(self, api_client, test_user):
        # A third member who is neither the receiver nor an admin must be blocked.
        trip_id, m_owner, m_b, _b = _owner_owes_b(api_client, test_user["token"])
        user_c = _register(api_client)
        trip = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=_auth(test_user["token"])).json()
        api_client.post(f"{BASE_URL}/api/trips/join", json={"code": trip["code"], "mode": "individual"},
                        headers=_auth(user_c["token"]))
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_owner, "to_member_id": m_b, "amount": 10.0,
        }, headers=_auth(user_c["token"]))
        assert resp.status_code == 403, resp.text

    def test_non_member_blocked_on_all_verbs(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        pid = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 20.0,
        }, headers=_auth(test_user["token"])).json()["id"]
        outsider = _register(api_client)
        h = _auth(outsider["token"])
        assert api_client.get(f"{BASE_URL}/api/trips/{trip_id}/payments", headers=h).status_code == 403
        assert api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 5.0}, headers=h).status_code == 403
        assert api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/payments/{pid}",
                                json={"amount": 5.0}, headers=h).status_code == 403
        assert api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/payments/{pid}",
                                 headers=h).status_code == 403

    def test_legacy_settle_should_not_let_debtor_self_settle(self, api_client, test_user):
        trip_id, m_owner, m_b, user_b = _b_owes_owner(api_client, test_user["token"])
        # userB is the DEBTOR. They hit the LEGACY endpoint to stamp their own debt paid.
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settle", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 100.0,
        }, headers=_auth(user_b["token"]))
        # SECURE expectation: a debtor cannot clear their own debt -> should be forbidden.
        assert resp.status_code == 403, (
            f"legacy /settle returned {resp.status_code}; debtor self-settled their own debt")

    def test_legacy_settle_should_validate_amount(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settle", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": -500.0,
        }, headers=_auth(test_user["token"]))
        assert resp.status_code >= 400, f"legacy /settle accepted a negative amount ({resp.status_code})"


# --------------------------------------------------------------------------------------------------
class TestEditCaps:
    def test_edit_cap_is_residual_plus_own_amount(self, api_client, test_user):
        # debt 100; record 60 -> residual 40; edit cap = 40 + 60 = 100.
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        pid = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 60.0,
        }, headers=_auth(test_user["token"])).json()["id"]
        # Editing up to exactly the cap (100) succeeds.
        ok = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/payments/{pid}",
                              json={"amount": 100.0}, headers=_auth(test_user["token"]))
        assert ok.status_code == 200, ok.text
        # After that edit the residual is 0; the cap is now exactly 100 again (residual 0 + own 100).
        over = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/payments/{pid}",
                                json={"amount": 100.05}, headers=_auth(test_user["token"]))
        assert over.status_code == 400, over.text

    def test_edit_over_original_cap_rejected(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        pid = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 40.0,
        }, headers=_auth(test_user["token"])).json()["id"]
        # cap = residual(60) + own(40) = 100; 120 must be rejected.
        resp = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/payments/{pid}",
                                json={"amount": 120.0}, headers=_auth(test_user["token"]))
        assert resp.status_code == 400, resp.text


# --------------------------------------------------------------------------------------------------
class TestValidation:
    def test_zero_amount_is_rejected(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 0.0,
        }, headers=_auth(test_user["token"]))
        assert resp.status_code in (400, 422), resp.text

    def test_negative_amount_is_rejected(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": -50.0,
        }, headers=_auth(test_user["token"]))
        assert resp.status_code in (400, 422), resp.text

    def test_zero_amount_should_be_422(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 0.0,
        }, headers=_auth(test_user["token"]))
        assert resp.status_code == 422, resp.text

    def test_negative_amount_should_be_422(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": -50.0,
        }, headers=_auth(test_user["token"]))
        assert resp.status_code == 422, resp.text

    def test_overpayment_single_rejected(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 150.0,  # payable is 100
        }, headers=_auth(test_user["token"]))
        assert resp.status_code == 400, resp.text

    def test_cumulative_overpay_capped_by_residual(self, api_client, test_user):
        # Two sequential payments cannot together exceed the debt (residual is re-read each time).
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        first = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 60.0,
        }, headers=_auth(test_user["token"]))
        assert first.status_code == 200, first.text
        second = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 60.0,  # residual is only 40
        }, headers=_auth(test_user["token"]))
        assert second.status_code == 400, second.text


# --------------------------------------------------------------------------------------------------
class TestDestructiveInjection:
    def test_nan_amount_does_not_poison_ledger(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        # Send raw JSON with a literal NaN token (stdlib json.loads on the server accepts it).
        body = json.dumps({"from_member_id": m_b, "to_member_id": m_owner}) [:-1] + ', "amount": NaN}'
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments",
                               data=body, headers=_auth(test_user["token"]))
        bal = _balances(api_client, test_user["token"], trip_id)
        finite = all(v == v and abs(v) != float("inf") for v in bal.get("net", {}).values())
        # SECURE expectation: NaN is rejected up front OR the ledger stays finite.
        assert resp.status_code >= 400 or finite, (
            f"NaN accepted ({resp.status_code}); ledger net = {bal.get('net')}")

    def test_infinity_amount_is_rejected(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        body = json.dumps({"from_member_id": m_b, "to_member_id": m_owner})[:-1] + ', "amount": Infinity}'
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments",
                               data=body, headers=_auth(test_user["token"]))
        # Infinity > payable is True, so the existing over-payment guard should reject it.
        assert resp.status_code >= 400, resp.text
        bal = _balances(api_client, test_user["token"], trip_id)
        assert all(abs(v) != float("inf") and v == v for v in bal.get("net", {}).values())


# --------------------------------------------------------------------------------------------------
class TestConcurrencyRace:
    def test_concurrent_duplicate_payments_cannot_overpay(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])  # debt 100
        token = test_user["token"]
        url = f"{BASE_URL}/api/trips/{trip_id}/payments"
        payload = {"from_member_id": m_b, "to_member_id": m_owner, "amount": 100.0}

        def _fire(_):
            return requests.post(url, json=payload, headers=_auth(token), timeout=30).status_code

        with ThreadPoolExecutor(max_workers=8) as ex:
            codes = list(ex.map(_fire, range(8)))

        ok = sum(1 for c in codes if c == 200)
        payments = api_client.get(url, headers=_auth(token)).json()
        total_recorded = round(sum(p["amount"] for p in payments), 2)
        # SECURE expectation: at most one 100 payment is accepted and the debt is never over-settled.
        assert ok == 1 and total_recorded <= 100.0 + 0.01, (
            f"{ok} concurrent payments accepted; total recorded={total_recorded} on a 100 debt")


# --------------------------------------------------------------------------------------------------
class TestLegacyCoexistence:
    def test_paid_settlement_offsets_balance(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        before = _balances(api_client, test_user["token"], trip_id)
        assert abs(_transfer(before, m_b, m_owner) - 100.0) < 0.01
        r = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settle", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 100.0,
        }, headers=_auth(test_user["token"]))
        assert r.status_code == 200, r.text
        after = _balances(api_client, test_user["token"], trip_id)
        assert abs(after["net"].get(m_b, 0.0)) < 0.01
        assert abs(after["net"].get(m_owner, 0.0)) < 0.01

    def test_pending_settlement_does_not_offset(self, api_client, test_user):
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        r = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 100.0,
        }, headers=_auth(test_user["token"]))
        assert r.status_code == 200, r.text
        after = _balances(api_client, test_user["token"], trip_id)
        # A PENDING settlement is a to-do, not a real payment -> the debt still stands.
        assert abs(_transfer(after, m_b, m_owner) - 100.0) < 0.01

    def test_paid_settlement_then_payment_cannot_double_offset(self, api_client, test_user):
        # After a legacy paid settlement clears the debt, the payments API refuses to record more
        # (residual is 0), so the two mechanisms cannot stack into an over-offset via the API.
        trip_id, m_owner, m_b, _b = _b_owes_owner(api_client, test_user["token"])
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settle", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 100.0,
        }, headers=_auth(test_user["token"]))
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m_b, "to_member_id": m_owner, "amount": 10.0,
        }, headers=_auth(test_user["token"]))
        assert resp.status_code == 400, resp.text
