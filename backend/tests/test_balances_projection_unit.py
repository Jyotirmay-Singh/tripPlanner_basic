import asyncio

import pytest
from fastapi import HTTPException

from utils import balances


class _Cursor:
    def __init__(self, rows):
        self.rows = rows
        self.requested = []

    async def to_list(self, length):
        self.requested.append(length)
        return list(self.rows)


class _Collection:
    def __init__(self, rows=None, one=None):
        self.rows = rows if rows is not None else []
        self.one = one
        self.cursors = []

    async def find_one(self, *_args, **_kwargs):
        return self.one

    def find(self, *_args, **_kwargs):
        cursor = _Cursor(self.rows)
        self.cursors.append(cursor)
        return cursor


def _trip(currency="LKR"):
    return {
        "id": "t1", "currency": currency,
        "members": [
            {"id": "a", "name": "A", "kind": "individual"},
            {"id": "b", "name": "B", "kind": "individual"},
            {"id": "c", "name": "C", "kind": "individual"},
            {"id": "d", "name": "D", "kind": "individual"},
        ],
    }


def _install_db(monkeypatch, trip, expenses, settlements=None, payments=None):
    fake = type("FakeDb", (), {})()
    fake.trips = _Collection(one=trip)
    fake.expenses = _Collection(rows=expenses)
    fake.settlements = _Collection(rows=settlements or [])
    fake.payments = _Collection(rows=payments if payments is not None else [])
    monkeypatch.setattr(balances, "db", fake)
    return fake


def test_balance_response_exposes_conserving_whole_unit_projection_and_no_row_cap(monkeypatch):
    monkeypatch.setattr(balances, "WHOLE_UNIT_SETTLEMENTS_ENABLED", True)
    trip = _trip()
    # A fronted 10 for only B/C/D: precise debts are thirds and must jointly round to 10.
    expense = {"id": "e", "amount": 10, "currency": "LKR", "original_currency": "USD",
               "exchange_rate": "300", "paid_by_member_id": "a",
               "split_member_ids": ["b", "c", "d"], "split_mode": "PER_FAMILY"}
    fake = _install_db(monkeypatch, trip, [expense])
    result = asyncio.run(balances._compute_balances("t1"))
    projection = result["settlement_projection"]
    assert projection["enabled"] is True
    assert sum(projection["rounded_net"].values()) == 0
    assert sum(transfer["amount"] for transfer in result["transfers"]) == 10
    assert all(isinstance(transfer["amount"], int) for transfer in result["transfers"])
    assert sum(result["net"].values()) == pytest.approx(0)
    assert all(collection.cursors[0].requested == [None]
               for collection in (fake.expenses, fake.settlements, fake.payments))


def test_recording_one_and_then_all_suggestions_recomputes_validly(monkeypatch):
    monkeypatch.setattr(balances, "WHOLE_UNIT_SETTLEMENTS_ENABLED", True)
    payment_rows = []
    trip = _trip("NPR")
    expense = {"id": "e", "amount": 10, "paid_by_member_id": "a",
               "split_member_ids": ["b", "c", "d"], "split_mode": "PER_FAMILY"}
    _install_db(monkeypatch, trip, [expense], payments=payment_rows)
    initial = asyncio.run(balances._compute_balances("t1"))
    first = initial["transfers"][0]
    payment_rows.append({"id": "p1", **first})
    remaining = asyncio.run(balances._compute_balances("t1"))
    assert sum(remaining["settlement_projection"]["rounded_net"].values()) == 0
    assert all(isinstance(transfer["amount"], int) for transfer in remaining["transfers"])

    for index, transfer in enumerate(remaining["transfers"], 2):
        payment_rows.append({"id": f"p{index}", **transfer})
    closed = asyncio.run(balances._compute_balances("t1"))
    assert closed["transfers"] == []
    assert closed["settlement_projection"]["status"] == "settled_within_rounding"


def test_removed_but_exactly_settled_member_history_remains_replayable(monkeypatch):
    monkeypatch.setattr(balances, "WHOLE_UNIT_SETTLEMENTS_ENABLED", True)
    trip = {
        "id": "t1", "currency": "LKR",
        "members": [{"id": "a", "name": "A", "kind": "individual"}],
    }
    expense = {
        "id": "history", "amount": 100, "paid_by_member_id": "a",
        "split_member_ids": ["a", "removed"], "split_mode": "PER_CAPITA",
    }
    paid = {
        "id": "paid", "from_member_id": "removed", "to_member_id": "a",
        "amount": 50, "status": "paid",
    }
    _install_db(monkeypatch, trip, [expense], settlements=[paid])

    result = asyncio.run(balances._compute_balances("t1"))

    assert result["net"] == {"a": 0.0}
    assert result["transfers"] == []
    assert result["settlement_projection"]["precise_net"] == {
        "a": "0.000000000000"
    }


def test_ledger_problem_is_generic_for_members_and_diagnostic_for_admins(monkeypatch):
    trip = _trip()
    invalid = {"id": "bad", "amount": 10, "paid_by_member_id": "a",
               "split_member_ids": ["ghost"], "split_mode": "PER_FAMILY"}
    _install_db(monkeypatch, trip, [invalid])
    with pytest.raises(HTTPException) as member_error:
        asyncio.run(balances._compute_balances("t1"))
    assert member_error.value.status_code == 409
    assert "ghost" not in member_error.value.detail

    with pytest.raises(HTTPException) as admin_error:
        asyncio.run(balances._compute_balances("t1", diagnostic=True))
    assert admin_error.value.status_code == 409
    assert "orphaned_member_balance" in admin_error.value.detail
    assert "ghost" in admin_error.value.detail
