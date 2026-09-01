import asyncio
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest
from bson.decimal128 import Decimal128

from models.exchange_rate import ConversionRequest
from services import expense_conversion as conversion
from services.exchange_rates import ExchangeRateError


MEMBERS = [
    {"id": "a", "name": "A", "kind": "individual"},
    {"id": "b", "name": "B", "kind": "individual"},
    {"id": "c", "name": "C", "kind": "individual"},
]


def run(awaitable):
    return asyncio.run(awaitable)


def quote(*, target="3520.40", rate="3.5204", target_currency="LKR",
          source="1000.00", source_currency="INR", mode="automatic"):
    return {
        "id": "q1",
        "mode": mode,
        "source_amount": Decimal128(source),
        "source_currency": source_currency,
        "target_amount": Decimal128(target),
        "target_currency": target_currency,
        "rate": Decimal128(rate),
        "requested_date": "2026-08-28",
        "effective_rate_date": "2026-08-28",
        "provider": "frankfurter_v2_blended" if mode == "automatic" else "manual",
        "provider_sources": [],
        "cache_revision": 1,
        "cache_hit": False,
        "stale": False,
        "manual_input_type": None,
        "manual_input_value": None,
    }


def approved():
    return ConversionRequest(mode="automatic", quote_id="q1", approved=True)


def test_inr_expense_converts_to_locked_lkr_canonical_amount(monkeypatch):
    monkeypatch.setattr(conversion, "load_quote", AsyncMock(return_value=quote()))

    result = run(conversion.convert_expense(
        user_id="u1", trip_currency="LKR", date="28-08-26",
        split_mode="PER_CAPITA", members=MEMBERS,
        original_amount="1000", original_currency="INR", original_custom_amounts=None,
        conversion=approved(), version=1, reason="created",
    ))

    assert result["amount"] == 3520.40
    assert result["currency"] == "LKR"
    assert result["metadata"]["original_amount"].to_decimal() == Decimal("1000.00")
    assert result["metadata"]["exchange_rate"].to_decimal() == Decimal("3.5204")
    assert result["metadata"]["exchange_rate_date"] == "2026-08-28"
    assert result["metadata"]["conversion_version"] == 1


def test_inr_expense_converts_to_npr_and_negative_refund_keeps_sign(monkeypatch):
    npr_quote = quote(
        target="-1600.00", rate="1.6", target_currency="NPR", source="-1000.00"
    )
    monkeypatch.setattr(conversion, "load_quote", AsyncMock(return_value=npr_quote))

    result = run(conversion.convert_expense(
        user_id="u1", trip_currency="NPR", date="28-08-26",
        split_mode="PER_CAPITA", members=MEMBERS,
        original_amount="-1000", original_currency="INR", original_custom_amounts=None,
        conversion=approved(), version=2, reason="inputs_changed",
    ))

    assert result["amount"] == -1600.0
    assert result["metadata"]["original_amount"].to_decimal() == Decimal("-1000.00")


def test_npr_expense_converts_to_lkr_trip_currency(monkeypatch):
    npr_quote = quote(
        target="2062.50", rate="1.375", target_currency="LKR",
        source="1500.00", source_currency="NPR",
    )
    monkeypatch.setattr(conversion, "load_quote", AsyncMock(return_value=npr_quote))

    result = run(conversion.convert_expense(
        user_id="u1", trip_currency="LKR", date="28-08-26",
        split_mode="PER_CAPITA", members=MEMBERS,
        original_amount="1500", original_currency="NPR", original_custom_amounts=None,
        conversion=approved(), version=1, reason="created",
    ))

    assert result["amount"] == 2062.50
    assert result["currency"] == "LKR"
    assert result["metadata"]["original_currency"] == "NPR"
    assert result["metadata"]["exchange_rate"].to_decimal() == Decimal("1.375")


def test_same_currency_uses_rate_one_without_loading_quote(monkeypatch):
    loader = AsyncMock()
    monkeypatch.setattr(conversion, "load_quote", loader)

    result = run(conversion.convert_expense(
        user_id="u1", trip_currency="LKR", date="28-08-26",
        split_mode="PER_CAPITA", members=MEMBERS,
        original_amount="125.50", original_currency="LKR", original_custom_amounts=None,
        conversion=None, version=1, reason="created",
    ))

    assert result["amount"] == 125.5
    assert result["metadata"]["exchange_rate"].to_decimal() == Decimal("1")
    assert result["metadata"]["exchange_rate_provider"] == "identity"
    loader.assert_not_awaited()


def test_exact_conversion_uses_deterministic_largest_remainder(monkeypatch):
    exact_quote = quote(target="150.00", rate="1.5", source="100.00")
    monkeypatch.setattr(conversion, "load_quote", AsyncMock(return_value=exact_quote))

    result = run(conversion.convert_expense(
        user_id="u1", trip_currency="LKR", date="28-08-26",
        split_mode="EXACT", members=MEMBERS,
        original_amount="100", original_currency="INR",
        original_custom_amounts={"a": "33.33", "b": "33.33", "c": "33.34"},
        conversion=approved(), version=1, reason="created",
    ))

    assert result["custom_amounts"] == {"a": 50.0, "b": 49.99, "c": 50.01}
    assert sum(result["custom_amounts"].values()) == result["amount"]
    assert result["history"]["original_custom_amounts"]["a"].to_decimal() == Decimal("33.33")


def test_exact_refund_allocations_are_positive_inputs_and_negative_canonical_shares(monkeypatch):
    exact_quote = quote(target="-150.00", rate="1.5", source="-100.00")
    monkeypatch.setattr(conversion, "load_quote", AsyncMock(return_value=exact_quote))

    result = run(conversion.convert_expense(
        user_id="u1", trip_currency="LKR", date="28-08-26",
        split_mode="EXACT", members=MEMBERS,
        original_amount="-100", original_currency="INR",
        original_custom_amounts={"a": "50", "b": "50"},
        conversion=approved(), version=1, reason="created",
    ))

    assert result["custom_amounts"] == {"a": -75.0, "b": -75.0}
    assert sum(result["custom_amounts"].values()) == -150.0


def test_quote_mismatch_never_silently_saves(monkeypatch):
    monkeypatch.setattr(conversion, "load_quote", AsyncMock(return_value=quote(source="999.00")))

    with pytest.raises(ExchangeRateError) as caught:
        run(conversion.convert_expense(
            user_id="u1", trip_currency="LKR", date="28-08-26",
            split_mode="PER_CAPITA", members=MEMBERS,
            original_amount="1000", original_currency="INR", original_custom_amounts=None,
            conversion=approved(), version=1, reason="created",
        ))
    assert caught.value.code == "conversion_confirmation_required"
    assert caught.value.status_code == 428


def test_locked_exact_reallocation_preserves_rate_and_canonical_total():
    expense = {
        "amount": 150.0,
        "currency": "LKR",
        "original_amount": Decimal128("100.00"),
        "original_currency": "INR",
        "exchange_rate": Decimal128("1.5"),
        "exchange_rate_provider": "frankfurter_v2_blended",
        "exchange_rate_mode": "automatic",
    }

    result = conversion.locked_exact_reallocation_update(
        expense=expense,
        original_custom_amounts={"a": "25", "b": "75"},
        members=MEMBERS, user_id="u1", version=2,
    )

    assert result["custom_amounts"] == {"a": 37.5, "b": 112.5}
    assert result["metadata"]["conversion_version"] == 2
    assert result["history"]["rate"].to_decimal() == Decimal("1.5")
    assert result["history"]["reason"] == "exact_reallocated"


def test_bson_serialization_keeps_metadata_decimals_as_strings():
    assert conversion.serialize_bson({
        "original_amount": Decimal128("1000.00"),
        "rate": Decimal128("3.5204"),
    }) == {"original_amount": "1000.00", "rate": "3.5204"}
