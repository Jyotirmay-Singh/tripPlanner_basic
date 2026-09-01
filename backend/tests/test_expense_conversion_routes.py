import asyncio
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from bson.decimal128 import Decimal128
from fastapi import HTTPException

from models.expense import ExpenseUpdate
from models.exchange_rate import ReconvertIn
from routes import expenses


TRIP = {
    "id": "t1",
    "currency": "LKR",
    "members": [
        {"id": "a", "name": "A", "kind": "individual"},
        {"id": "b", "name": "B", "kind": "individual"},
    ],
}


def foreign_expense(**overrides):
    base = {
        "id": "e1", "trip_id": "t1", "amount": 3520.4, "currency": "LKR",
        "original_amount": Decimal128("1000.00"), "original_currency": "INR",
        "exchange_rate": Decimal128("3.5204"),
        "exchange_rate_requested_date": "2026-08-28",
        "exchange_rate_date": "2026-08-28",
        "exchange_rate_provider": "frankfurter_v2_blended",
        "exchange_rate_mode": "automatic", "conversion_version": 1,
        "date": "28-08-26", "category": "Food", "description": "Dinner",
        "paid_by_member_id": "a", "split_member_ids": ["a", "b"],
        "split_mode": "PER_CAPITA", "created_by": "u1",
    }
    return {**base, **overrides}


def run(awaitable):
    return asyncio.run(awaitable)


class MemoryExpenses:
    def __init__(self, document):
        self.document = dict(document)
        self.mutations = []

    async def update_one(self, query, mutation):
        self.mutations.append((query, mutation))
        if "conversion_version" in query \
                and self.document.get("conversion_version") != query["conversion_version"]:
            return SimpleNamespace(matched_count=0)
        self.document.update(mutation.get("$set", {}))
        if "$push" in mutation:
            self.document.setdefault("conversion_history", []).append(
                mutation["$push"]["conversion_history"]
            )
        return SimpleNamespace(matched_count=1)

    async def find_one(self, *_args, **_kwargs):
        return dict(self.document)


def setup_route(monkeypatch, document):
    collection = MemoryExpenses(document)
    monkeypatch.setattr(expenses, "db", SimpleNamespace(expenses=collection))
    monkeypatch.setattr(
        expenses, "_expense_modify_or_403", AsyncMock(return_value=(TRIP, document))
    )
    monkeypatch.setattr(expenses, "MULTI_CURRENCY_EXPENSES_ENABLED", True)
    return collection


def test_description_only_edit_does_not_reconvert_or_change_version(monkeypatch):
    document = foreign_expense()
    collection = setup_route(monkeypatch, document)
    converter = AsyncMock()
    monkeypatch.setattr(expenses, "convert_expense", converter)

    result = run(expenses.update_expense(
        "t1", "e1", ExpenseUpdate(description="Updated"), user={"id": "u1"},
    ))

    assert result["description"] == "Updated"
    assert result["conversion_version"] == 1
    converter.assert_not_awaited()
    query, mutation = collection.mutations[0]
    assert "conversion_version" not in query
    assert mutation == {"$set": {"description": "Updated"}}


def test_legacy_description_edit_does_not_add_conversion_metadata(monkeypatch):
    document = foreign_expense(
        amount=125.50,
        currency="LKR",
        original_amount=None,
        original_currency=None,
        exchange_rate=None,
        exchange_rate_requested_date=None,
        exchange_rate_date=None,
        exchange_rate_provider=None,
        exchange_rate_mode=None,
        conversion_version=None,
    )
    document = {key: value for key, value in document.items() if value is not None}
    collection = setup_route(monkeypatch, document)
    converter = AsyncMock()
    monkeypatch.setattr(expenses, "convert_expense", converter)

    result = run(expenses.update_expense(
        "t1", "e1", ExpenseUpdate(description="Legacy updated"), user={"id": "u1"},
    ))

    assert result["amount"] == 125.50
    assert result["currency"] == "LKR"
    assert "conversion_version" not in result
    assert "original_amount" not in result
    converter.assert_not_awaited()
    assert collection.mutations[0][1] == {"$set": {"description": "Legacy updated"}}


def test_old_client_cannot_overwrite_foreign_canonical_amount(monkeypatch):
    setup_route(monkeypatch, foreign_expense())

    with pytest.raises(HTTPException) as caught:
        run(expenses.update_expense(
            "t1", "e1", ExpenseUpdate(amount=4000), user={"id": "u1"},
        ))

    assert caught.value.status_code == 428
    assert caught.value.detail["code"] == "conversion_confirmation_required"


def test_foreign_date_change_requires_conversion_version(monkeypatch):
    setup_route(monkeypatch, foreign_expense())

    with pytest.raises(HTTPException) as caught:
        run(expenses.update_expense(
            "t1", "e1", ExpenseUpdate(date="29-08-26"), user={"id": "u1"},
        ))

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "conversion_conflict"


def test_exact_allocation_edit_reuses_locked_rate_and_increments_version(monkeypatch):
    document = foreign_expense(
        amount=100.0,
        original_amount=Decimal128("30.00"),
        exchange_rate=Decimal128("3.333333333333"),
        split_mode="EXACT",
        custom_amounts={"a": 50.0, "b": 50.0},
        original_custom_amounts={"a": Decimal128("15.00"), "b": Decimal128("15.00")},
    )
    collection = setup_route(monkeypatch, document)
    converter = AsyncMock()
    monkeypatch.setattr(expenses, "convert_expense", converter)

    result = run(expenses.update_expense(
        "t1", "e1",
        ExpenseUpdate(
            original_custom_amounts={"a": "10", "b": "20"},
            expected_conversion_version=1,
        ),
        user={"id": "u1"},
    ))

    assert result["conversion_version"] == 2
    assert result["exchange_rate"] == "3.333333333333"
    assert round(sum(result["custom_amounts"].values()), 2) == 100.0
    converter.assert_not_awaited()
    assert collection.mutations[0][0]["conversion_version"] == 1


def test_conversion_write_is_atomic_against_stale_version(monkeypatch):
    document = foreign_expense()
    collection = setup_route(monkeypatch, document)
    collection.document["conversion_version"] = 2
    converted = {
        "amount": 3600.0,
        "custom_amounts": None,
        "metadata": {"conversion_version": 2},
        "history": {"version": 2},
    }
    monkeypatch.setattr(expenses, "convert_expense", AsyncMock(return_value=converted))

    with pytest.raises(HTTPException) as caught:
        run(expenses.update_expense(
            "t1", "e1",
            ExpenseUpdate(
                original_amount="1100", expected_conversion_version=1,
                conversion={"mode": "automatic", "quote_id": "q2", "approved": True},
            ),
            user={"id": "u1"},
        ))

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "conversion_conflict"


def test_reconvert_rejects_stale_expected_version_before_quote(monkeypatch):
    setup_route(monkeypatch, foreign_expense(conversion_version=3))
    converter = AsyncMock()
    monkeypatch.setattr(expenses, "convert_expense", converter)

    with pytest.raises(HTTPException) as caught:
        run(expenses.reconvert_expense(
            "t1", "e1",
            ReconvertIn(quote_id="q2", expected_conversion_version=2, approved=True),
            user={"id": "u1"},
        ))

    assert caught.value.status_code == 409
    converter.assert_not_awaited()
