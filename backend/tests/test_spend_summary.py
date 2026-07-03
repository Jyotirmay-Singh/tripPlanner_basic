# Phase 12: spend-ranking aggregation. Pure unit tests for services.spend_summary.aggregate_spend
# (plain dicts/lists — no server) PLUS live API tests for GET /trips/{id}/spend-summary (hit a
# running server via requests, mirroring test_settlements.py / test_balances_reports.py).
import os
import uuid

import pytest
import requests

from services.spend_summary import aggregate_spend

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8000").rstrip("/")


def _members():
    # Section 5(A) roster: 4 families (sizes 4, 4, 2, 1) + 2 individuals.
    return [
        {"id": "f1", "name": "Smiths", "kind": "family", "family_members": ["A", "B", "C", "D"]},
        {"id": "f2", "name": "Jones", "kind": "family", "family_members": ["A", "B", "C", "D"]},
        {"id": "f3", "name": "Lee", "kind": "family", "family_members": ["A", "B"]},
        {"id": "f4", "name": "Park", "kind": "family", "family_members": ["A"]},
        {"id": "i1", "name": "Ann", "kind": "individual", "family_members": []},
        {"id": "i2", "name": "Bob", "kind": "individual", "family_members": []},
    ]


def _exp(paid_by, amount, **over):
    e = {"id": uuid.uuid4().hex, "amount": amount, "category": "Food",
         "paid_by_member_id": paid_by, "split_member_ids": [], "split_mode": "PER_CAPITA"}
    e.update(over)
    return e


def _by_id(out):
    return {e["entity_id"]: e for e in out["entities"]}


class TestAggregateSpendPure:
    """The aggregation is gross, payer-grouped, and split/settlement-independent."""

    def test_gross_paid_grouped_by_payer_entity(self):
        members = _members()
        expenses = [
            _exp("f1", 100.0),
            _exp("f1", 50.0),   # a family payer rolls up to the family entity
            _exp("i1", 30.0),   # a standalone individual
            _exp("f3", 20.0),
        ]
        out = aggregate_spend(members, expenses)
        by_id = _by_id(out)
        assert by_id["f1"]["paid"] == 150.0
        assert by_id["f1"]["expense_count"] == 2
        assert by_id["f1"]["entity_type"] == "family"
        assert by_id["i1"]["paid"] == 30.0
        assert by_id["i1"]["entity_type"] == "individual"
        assert by_id["f3"]["paid"] == 20.0

    def test_zero_spend_entities_included(self):
        members = _members()
        out = aggregate_spend(members, [_exp("f1", 10.0)])
        # Full roster, in order — non-spenders present with paid 0.
        assert [e["entity_id"] for e in out["entities"]] == ["f1", "f2", "f3", "f4", "i1", "i2"]
        by_id = _by_id(out)
        assert by_id["i2"]["paid"] == 0.0
        assert by_id["i2"]["expense_count"] == 0

    def test_refunds_and_zero_excluded(self):
        members = _members()
        # -40 is money coming back (a refund row in the signed-amount model).
        out = aggregate_spend(members, [_exp("f1", 100.0), _exp("f1", -40.0)])
        by_id = _by_id(out)
        assert by_id["f1"]["paid"] == 100.0  # gross, NOT net 60 — refund ignored
        assert by_id["f1"]["expense_count"] == 1

    def test_ignores_split_mode_members_and_snapshots(self):
        members = _members()
        # A wildly different split config must not change WHO paid or how much they fronted.
        e = _exp("i2", 80.0, split_mode="PER_FAMILY",
                 split_member_ids=["f1", "f2"], weight_snapshots={"f1": 1})
        out = aggregate_spend(members, [e])
        by_id = _by_id(out)
        assert by_id["i2"]["paid"] == 80.0
        # Entities that merely participated in the split but did not pay -> 0.
        assert by_id["f1"]["paid"] == 0.0
        assert by_id["f2"]["paid"] == 0.0

    def test_payer_not_in_members_skipped(self):
        members = _members()
        out = aggregate_spend(members, [_exp("ghost", 99.0), _exp("i1", 11.0)])
        by_id = _by_id(out)
        assert by_id["i1"]["paid"] == 11.0
        assert out["total"] == 11.0  # the removed payer's 99 is excluded

    def test_total_equals_sum_of_bars_and_count_is_spenders(self):
        members = _members()
        out = aggregate_spend(members, [_exp("f1", 10.0), _exp("f2", 20.0), _exp("i1", 5.0)])
        assert out["total"] == 35.0
        assert out["total"] == round(sum(e["paid"] for e in out["entities"]), 2)
        assert out["count"] == 3  # f1, f2, i1 spent; f3, f4, i2 did not

    def test_rounding_two_dp(self):
        members = _members()
        out = aggregate_spend(members, [_exp("i1", 10.005), _exp("i1", 0.001)])
        assert _by_id(out)["i1"]["paid"] == 10.01

    def test_empty_expenses(self):
        out = aggregate_spend(_members(), [])
        assert out["total"] == 0.0
        assert out["count"] == 0
        assert all(e["paid"] == 0.0 for e in out["entities"])

    def test_no_members(self):
        assert aggregate_spend([], [_exp("x", 10.0)]) == {"total": 0.0, "count": 0, "entities": []}


class TestDrilldownReconcilesToBar:
    """Phase 17: the per-member spend drill-down sums the SAME positive fronted amounts the bar does,
    so its total equals aggregate_spend's ``paid`` for every entity — across BOTH split modes and
    family vs individual payers. Guards the invariant the client screen (src/memberSpend) relies on;
    no production code is exercised beyond the shared aggregate_spend the bar already uses.
    """

    def _drilldown_total(self, expenses, eid):
        # Mirror of frontend src/memberSpend.memberSpendHistory: positive fronted amounts by THIS payer,
        # summed in cents to 2dp — refunds (negative) and zero excluded, exactly like the gross bar.
        cents = sum(round(e["amount"] * 100) for e in expenses
                    if e["amount"] > 0 and e["paid_by_member_id"] == eid)
        return cents / 100

    def test_reconciles_across_modes_and_entity_kinds(self):
        members = _members()
        expenses = [
            _exp("f1", 100.00),                                            # PER_CAPITA, family payer
            _exp("f1", 50.50),
            _exp("f1", -25.00),                                            # refund — excluded both sides
            _exp("f3", 20.00, split_mode="PER_FAMILY"),                    # PER_FAMILY, family payer
            _exp("i1", 30.25),                                             # individual payer
            _exp("i2", 80.00, split_mode="PER_FAMILY", split_member_ids=["f1", "f2"]),
            _exp("i2", 0.0),                                               # zero — excluded both sides
        ]
        out = aggregate_spend(members, expenses)
        by_id = _by_id(out)
        for m in members:
            eid = m["id"]
            # Per entity: the drill-down running total == that entity's gross-spend bar value.
            assert self._drilldown_total(expenses, eid) == by_id[eid]["paid"], eid
        # And every drill-down total foots to the same trip total as the bars.
        assert round(sum(self._drilldown_total(expenses, m["id"]) for m in members), 2) == out["total"]


# ---------- Live API tests (Step 51) ----------

def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _register(api_client):
    email = f"test_{uuid.uuid4().hex[:8]}@gmail.com"
    resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
        "email": email, "password": "test12345", "pin": "4321", "name": "Spend Tester",
    })
    if resp.status_code != 200:
        pytest.skip(f"User registration failed: {resp.status_code}")
    data = resp.json()
    return {"token": data["access_token"], "id": data["user"]["id"], "email": email}


def _make_trip(api_client, owner_token):
    """Owner creates a trip and adds a family member; returns (trip_id, owner_member_id, fam_member_id)."""
    trip = api_client.post(f"{BASE_URL}/api/trips", json={
        "name": "TEST_Spend Trip", "start_date": "2026-01-10", "end_date": "2026-01-15",
        "currency": "INR",
    }, headers=_auth(owner_token)).json()
    trip_id = trip["id"]
    owner_member_id = trip["members"][0]["id"]
    fam = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
        "name": "The Family", "kind": "family", "family_members": ["X", "Y", "Z"],
    }, headers=_auth(owner_token)).json()  # add_member returns the created member doc
    return trip_id, owner_member_id, fam["id"]


def _add_expense(api_client, token, trip_id, paid_by, amount):
    api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
        "amount": amount, "category": "Food", "description": "Dinner",
        "date": "11-03-27", "paid_by_member_id": paid_by, "split_member_ids": [],
    }, headers=_auth(token))


class TestSpendSummaryAPI:
    def test_shape_and_gross_values(self, api_client, test_user):
        trip_id, m_owner, m_fam = _make_trip(api_client, test_user["token"])
        _add_expense(api_client, test_user["token"], trip_id, m_owner, 120.0)
        _add_expense(api_client, test_user["token"], trip_id, m_fam, 80.0)
        _add_expense(api_client, test_user["token"], trip_id, m_fam, -30.0)  # refund — ignored

        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/spend-summary",
                              headers=_auth(test_user["token"]))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["currency"] == "INR"
        assert set(body.keys()) == {"total", "count", "entities", "currency"}
        by_id = {e["entity_id"]: e for e in body["entities"]}
        assert by_id[m_owner]["paid"] == 120.0
        assert by_id[m_owner]["entity_type"] == "individual"
        assert by_id[m_fam]["paid"] == 80.0           # gross — the -30 refund excluded
        assert by_id[m_fam]["entity_type"] == "family"
        assert body["total"] == 200.0
        assert body["count"] == 2

    def test_empty_trip(self, api_client, test_user):
        trip_id, _m_owner, _m_fam = _make_trip(api_client, test_user["token"])
        body = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/spend-summary",
                              headers=_auth(test_user["token"])).json()
        assert body["total"] == 0.0
        assert body["count"] == 0
        assert all(e["paid"] == 0.0 for e in body["entities"])  # roster still listed

    def test_rbac_non_member_forbidden(self, api_client, test_user):
        trip_id, _m_owner, _m_fam = _make_trip(api_client, test_user["token"])
        outsider = _register(api_client)
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/spend-summary",
                              headers=_auth(outsider["token"]))
        assert resp.status_code == 403

    def test_unauthenticated_rejected(self, api_client, test_user):
        trip_id, _m_owner, _m_fam = _make_trip(api_client, test_user["token"])
        assert api_client.get(f"{BASE_URL}/api/trips/{trip_id}/spend-summary").status_code == 401

    def test_unknown_trip_404(self, api_client, test_user):
        resp = api_client.get(f"{BASE_URL}/api/trips/no-such-trip/spend-summary",
                              headers=_auth(test_user["token"]))
        assert resp.status_code == 404
