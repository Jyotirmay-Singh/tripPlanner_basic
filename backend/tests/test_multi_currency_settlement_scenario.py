"""Auditable ten-currency conversion-to-settlement regression scenario.

The expected values in this module are frozen test-oracle constants.  They are deliberately not
derived with the production currency or settlement helpers that the tests exercise.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest

from models.exchange_rate import ConversionRequest
from services import exchange_rates, expense_conversion
from services.settlement_engine import SCALE, build_precise_net, build_settlement_projection


REQUESTED_DATE = "2026-08-28"
RELATIVE_ERROR_LIMIT_PERCENT = Decimal("0.1")
ZERO_BALANCE_LIMIT = Decimal("0.01")

MEMBERS = [
    {"id": "a", "name": "A", "kind": "individual"},
    {"id": "b", "name": "B", "kind": "individual"},
    {"id": "c", "name": "C", "kind": "individual"},
    {"id": "d", "name": "D", "kind": "individual"},
    {
        "id": "f",
        "name": "Family F",
        "kind": "family",
        "family_members": ["F1", "F2"],
        "family_member_ids": ["f1", "f2"],
    },
]

EXPENSE_CASES = [
    {
        "id": "inr",
        "original_currency": "INR",
        "original_amount": "1234.56",
        "rate": "1",
        "expected_canonical": "1234.56",
        "payer": "a",
        "split_mode": "PER_FAMILY",
        "split_ids": ["a", "b", "c", "d", "f"],
    },
    {
        "id": "usd",
        "original_currency": "USD",
        "original_amount": "45.67",
        "rate": "83.25",
        "expected_canonical": "3802.03",
        "payer": "b",
        "split_mode": "PER_CAPITA",
        "split_ids": ["a", "b", "c", "d", "f"],
        "family_participants": {"f": ["f1", "f2"]},
    },
    {
        "id": "eur",
        "original_currency": "EUR",
        "original_amount": "32.10",
        "rate": "90.50",
        "expected_canonical": "2905.05",
        "payer": "c",
        "split_mode": "PER_FAMILY",
        "split_ids": ["a", "b", "c", "f"],
    },
    {
        "id": "gbp",
        "original_currency": "GBP",
        "original_amount": "18.75",
        "rate": "105.75",
        "expected_canonical": "1982.81",
        "payer": "d",
        "split_mode": "EXACT",
        "split_ids": ["a", "b", "c", "d", "f"],
        "original_custom_amounts": {
            "a": "3.75",
            "b": "4.00",
            "c": "2.50",
            "d": "5.00",
            "f1": "2.00",
            "f2": "1.50",
        },
        "expected_custom_amounts": {
            "a": "396.56",
            "b": "423.00",
            "c": "264.38",
            "d": "528.75",
            "f1": "211.50",
            "f2": "158.62",
        },
    },
    {
        "id": "aed",
        "original_currency": "AED",
        "original_amount": "250.25",
        "rate": "22.68",
        "expected_canonical": "5675.67",
        "payer": "f",
        "split_mode": "PER_CAPITA",
        "split_ids": ["a", "c", "f"],
        "family_participants": {"f": ["f1", "f2"]},
    },
    {
        "id": "jpy",
        "original_currency": "JPY",
        "original_amount": "12345",
        "rate": "0.56",
        "expected_canonical": "6913.20",
        "payer": "a",
        "split_mode": "PER_FAMILY",
        "split_ids": ["b", "c", "d"],
    },
    {
        "id": "krw",
        "original_currency": "KRW",
        "original_amount": "98765",
        "rate": "0.063",
        "expected_canonical": "6222.20",
        "payer": "b",
        "split_mode": "PER_CAPITA",
        "split_ids": ["a", "b", "d", "f"],
        "family_participants": {"f": ["f1"]},
    },
    {
        "id": "kwd",
        "original_currency": "KWD",
        "original_amount": "12.345",
        "rate": "270.40",
        "expected_canonical": "3338.09",
        "payer": "c",
        "split_mode": "EXACT",
        "split_ids": ["a", "b", "c", "d", "f"],
        "original_custom_amounts": {
            "a": "1.111",
            "b": "2.222",
            "c": "3.333",
            "d": "2.222",
            "f1": "1.111",
            "f2": "2.346",
        },
        "expected_custom_amounts": {
            "a": "300.42",
            "b": "600.83",
            "c": "901.24",
            "d": "600.83",
            "f1": "300.41",
            "f2": "634.36",
        },
    },
    {
        "id": "bhd",
        "original_currency": "BHD",
        "original_amount": "8.765",
        "rate": "220.80",
        "expected_canonical": "1935.31",
        "payer": "d",
        "split_mode": "PER_FAMILY",
        "split_ids": ["a", "d", "f"],
    },
    {
        "id": "omr",
        "original_currency": "OMR",
        "original_amount": "-4.321",
        "rate": "216.25",
        "expected_canonical": "-934.42",
        "payer": "f",
        "split_mode": "PER_CAPITA",
        "split_ids": ["b", "c", "f"],
        "family_participants": {"f": ["f1", "f2"]},
    },
]

EXPECTED_PRECISE_NET = {
    "a": "2224.362999999999",
    "b": "3767.208833333333",
    "c": "-19.038666666667",
    "d": "-2597.096999999999",
    "f": "-3375.436166666666",
}
EXPECTED_ROUNDED_NET = {
    "a": "2224.36",
    "b": "3767.21",
    "c": "-19.04",
    "d": "-2597.10",
    "f": "-3375.43",
}
EXPECTED_AFTER_PAYMENT_PRECISE_NET = {
    "a": "2224.362999999999",
    "b": "2767.208833333333",
    "c": "-19.038666666667",
    "d": "-2597.096999999999",
    "f": "-2375.436166666666",
}
EXPECTED_AFTER_PAYMENT_ROUNDED_NET = {
    "a": "2224.36",
    "b": "2767.21",
    "c": "-19.04",
    "d": "-2597.10",
    "f": "-2375.43",
}


class _QuoteCollection:
    def __init__(self) -> None:
        self.documents: dict[str, dict] = {}

    async def insert_one(self, document: dict) -> None:
        self.documents[document["id"]] = document

    async def find_one(self, query: dict, _projection: dict) -> dict | None:
        document = self.documents.get(query.get("id"))
        if document and document.get("user_id") == query.get("user_id"):
            return document
        return None


def _approved_conversion(case: dict, quote_id: str | None) -> ConversionRequest | None:
    if case["original_currency"] == "INR":
        return None
    return ConversionRequest(
        mode="manual",
        quote_id=quote_id,
        approved=True,
        manual_input_type="rate",
        manual_rate=Decimal(case["rate"]),
    )


@pytest.fixture
def converted_scenario(monkeypatch) -> dict:
    quote_collection = _QuoteCollection()
    quote_ids = iter(
        f"quote-{case['id']}"
        for case in EXPENSE_CASES
        if case["original_currency"] != "INR"
    )
    fixed_now = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(
        exchange_rates,
        "db",
        SimpleNamespace(exchange_rate_quotes=quote_collection),
    )
    monkeypatch.setattr(exchange_rates, "gen_id", lambda: next(quote_ids))
    monkeypatch.setattr(exchange_rates, "now_utc", lambda: fixed_now)

    async def convert_all() -> tuple[list[dict], dict[str, dict], dict[str, dict]]:
        ledger_expenses = []
        results = {}
        quote_results = {}
        for case in EXPENSE_CASES:
            quote_result = None
            if case["original_currency"] != "INR":
                quote_result = await exchange_rates.create_quote(
                    user_id="ten-currency-test-user",
                    source_currency=case["original_currency"],
                    target_currency="INR",
                    source_amount=case["original_amount"],
                    requested_date=REQUESTED_DATE,
                    mode="manual",
                    manual_input_type="rate",
                    manual_rate=case["rate"],
                )
                quote_results[case["id"]] = quote_result
            result = await expense_conversion.convert_expense(
                user_id="ten-currency-test-user",
                trip_currency="INR",
                date="28-08-26",
                split_mode=case["split_mode"],
                members=MEMBERS,
                original_amount=case["original_amount"],
                original_currency=case["original_currency"],
                original_custom_amounts=case.get("original_custom_amounts"),
                conversion=_approved_conversion(
                    case,
                    quote_result["quote_id"] if quote_result else None,
                ),
                version=1,
                reason="created",
            )
            results[case["id"]] = result
            expense = {
                "id": case["id"],
                "amount": result["amount"],
                "currency": result["currency"],
                "paid_by_member_id": case["payer"],
                "split_member_ids": case["split_ids"],
                "split_mode": case["split_mode"],
                **result["metadata"],
            }
            if case.get("family_participants"):
                expense["family_participants"] = case["family_participants"]
            if result["custom_amounts"] is not None:
                expense["custom_amounts"] = result["custom_amounts"]
            ledger_expenses.append(expense)
        return ledger_expenses, results, quote_results

    expenses, results, quote_results = asyncio.run(convert_all())
    return {
        "members": MEMBERS,
        "expenses": expenses,
        "results": results,
        "quotes": quote_results,
    }


def _decimal_map(values: dict) -> dict[str, Decimal]:
    return {key: Decimal(str(value)) for key, value in values.items()}


def _assert_near(actual: object, expected: object, *, label: str) -> None:
    actual_value = Decimal(str(actual))
    expected_value = Decimal(str(expected))
    difference = abs(actual_value - expected_value)
    if expected_value == 0:
        assert difference <= ZERO_BALANCE_LIMIT, (
            f"{label}: expected zero, got {actual_value}; absolute error {difference} "
            f"exceeds {ZERO_BALANCE_LIMIT}"
        )
        return
    error_percent = difference / abs(expected_value) * Decimal(100)
    assert error_percent <= RELATIVE_ERROR_LIMIT_PERCENT, (
        f"{label}: expected {expected_value}, got {actual_value}; relative error "
        f"{error_percent}% exceeds {RELATIVE_ERROR_LIMIT_PERCENT}%"
    )


def _assert_balance_oracle(actual: dict, expected: dict, *, phase: str) -> None:
    assert set(actual) == set(expected)
    for member_id, expected_value in expected.items():
        _assert_near(actual[member_id], expected_value, label=f"{phase} member {member_id}")


def _transfer_flow(transfers: list[dict], member_ids: list[str]) -> dict[str, Decimal]:
    flow = {member_id: Decimal(0) for member_id in member_ids}
    for transfer in transfers:
        amount = Decimal(str(transfer["amount"]))
        assert amount > 0
        flow[transfer["from_member_id"]] -= amount
        flow[transfer["to_member_id"]] += amount
    return flow


def _assert_projection_conserves(transfers: list[dict], projection: dict) -> None:
    rounded = _decimal_map(projection["rounded_net"])
    assert sum(rounded.values(), Decimal(0)) == 0
    assert _transfer_flow(transfers, list(rounded)) == rounded
    assert all(
        abs(Decimal(adjustment)) < Decimal(projection["increment"])
        for adjustment in projection["rounding_adjustments"].values()
    )


def test_ten_currency_conversion_matrix_matches_frozen_decimal_oracle(converted_scenario):
    assert {case["original_currency"] for case in EXPENSE_CASES} == {
        "INR", "USD", "EUR", "GBP", "AED", "JPY", "KRW", "KWD", "BHD", "OMR"
    }

    results = converted_scenario["results"]
    for case in EXPENSE_CASES:
        result = results[case["id"]]
        if case["original_currency"] != "INR":
            quote_result = converted_scenario["quotes"][case["id"]]
            assert Decimal(quote_result["target_amount"]) == Decimal(
                case["expected_canonical"]
            )
            assert Decimal(quote_result["rate"]) == Decimal(case["rate"])
        assert Decimal(str(result["amount"])) == Decimal(case["expected_canonical"])
        assert result["currency"] == "INR"
        assert result["metadata"]["original_currency"] == case["original_currency"]
        assert result["metadata"]["exchange_rate"].to_decimal() == Decimal(case["rate"])
        if case.get("expected_custom_amounts"):
            assert _decimal_map(result["custom_amounts"]) == _decimal_map(
                case["expected_custom_amounts"]
            )


def test_ten_currency_mixed_settlement_matches_independent_member_oracle(
    converted_scenario,
):
    precise_net = build_precise_net(
        converted_scenario["members"], converted_scenario["expenses"]
    )
    assert sum(precise_net.values()) == 0
    actual_precise = {
        member_id: Decimal(value) / Decimal(SCALE)
        for member_id, value in precise_net.items()
    }
    _assert_balance_oracle(actual_precise, EXPECTED_PRECISE_NET, phase="initial precise")

    transfers, projection = build_settlement_projection(
        precise_net, "INR", whole_unit_enabled=False
    )
    assert projection["currency"] == "INR"
    assert projection["increment"] == "0.01"
    assert projection["routing"]["optimal"] is True
    assert len(transfers) == 4
    _assert_balance_oracle(
        projection["rounded_net"], EXPECTED_ROUNDED_NET, phase="initial rounded"
    )
    _assert_projection_conserves(transfers, projection)
    assert sum(Decimal(str(row["amount"])) for row in transfers) == Decimal("5991.57")


def test_partial_payment_reduces_settlement_volume_by_exactly_one_thousand(
    converted_scenario,
):
    members = converted_scenario["members"]
    expenses = converted_scenario["expenses"]
    initial_net = build_precise_net(members, expenses)
    initial_transfers, _initial_projection = build_settlement_projection(
        initial_net, "INR", whole_unit_enabled=False
    )

    payment = {
        "id": "partial-payment",
        "from_member_id": "f",
        "to_member_id": "b",
        "amount": 1000,
    }
    remaining_net = build_precise_net(members, expenses, payments=[payment])
    assert sum(remaining_net.values()) == 0
    actual_precise = {
        member_id: Decimal(value) / Decimal(SCALE)
        for member_id, value in remaining_net.items()
    }
    _assert_balance_oracle(
        actual_precise,
        EXPECTED_AFTER_PAYMENT_PRECISE_NET,
        phase="post-payment precise",
    )

    remaining_transfers, remaining_projection = build_settlement_projection(
        remaining_net, "INR", whole_unit_enabled=False
    )
    _assert_balance_oracle(
        remaining_projection["rounded_net"],
        EXPECTED_AFTER_PAYMENT_ROUNDED_NET,
        phase="post-payment rounded",
    )
    _assert_projection_conserves(remaining_transfers, remaining_projection)

    initial_volume = sum(Decimal(str(row["amount"])) for row in initial_transfers)
    remaining_volume = sum(Decimal(str(row["amount"])) for row in remaining_transfers)
    assert initial_volume == Decimal("5991.57")
    assert remaining_volume == Decimal("4991.57")
    assert initial_volume - remaining_volume == Decimal("1000.00")
