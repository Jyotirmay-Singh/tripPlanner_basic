from decimal import Decimal
from pathlib import Path
import re

import pytest

from models.expense import ExpenseIn, ExpenseUpdate
from models.trip import TripIn, TripUpdate
from utils.currency_rules import (
    CURRENCY_MINOR_UNITS,
    SUPPORTED_CURRENCIES,
    CurrencyPrecisionError,
    apportion_currency_amounts,
    currency_increment,
    currency_minor_units,
    currency_units,
    normalize_currency,
    quantize_currency,
    validate_currency_precision,
)


def test_catalog_has_unique_expected_codes():
    assert len(SUPPORTED_CURRENCIES) == 26
    assert len(set(SUPPORTED_CURRENCIES)) == len(SUPPORTED_CURRENCIES)
    assert {"INR", "USD", "LKR", "NPR"}.issubset(SUPPORTED_CURRENCIES)
    assert tuple(CURRENCY_MINOR_UNITS) == SUPPORTED_CURRENCIES


def test_iso_minor_units_and_increments():
    assert currency_minor_units("jpy") == 0
    assert currency_minor_units("USD") == 2
    assert currency_minor_units("kwd") == 3
    assert currency_increment("JPY") == "1"
    assert currency_increment("INR") == "0.01"
    assert currency_increment("OMR") == "0.001"


def test_user_input_precision_is_rejected_instead_of_silently_rounded():
    assert validate_currency_precision("12", "JPY") == 12
    assert validate_currency_precision("12.34", "USD") == Decimal("12.34")
    assert validate_currency_precision("12.345", "KWD") == Decimal("12.345")
    with pytest.raises(CurrencyPrecisionError, match="JPY allows at most 0"):
        validate_currency_precision("12.1", "JPY")
    with pytest.raises(CurrencyPrecisionError, match="USD allows at most 2"):
        validate_currency_precision("12.345", "USD")


def test_computed_values_quantize_to_the_target_currency():
    assert quantize_currency("12.6", "JPY") == 13
    assert quantize_currency("1.2345", "KWD") == Decimal("1.235")
    assert quantize_currency("-12.5", "JPY") == -13
    assert quantize_currency("-1.2345", "KWD") == Decimal("-1.235")
    assert currency_units("1.005", "USD") == 101


@pytest.mark.parametrize(
    "currency,target,expected",
    [
        ("JPY", "100", [34.0, 33.0, 33.0]),
        ("USD", "1.00", [0.34, 0.33, 0.33]),
        ("KWD", "1.000", [0.334, 0.333, 0.333]),
        ("JPY", "-100", [-33.0, -33.0, -34.0]),
    ],
)
def test_currency_apportionment_is_deterministic_and_reconciles(currency, target, expected):
    raw = {"a": Decimal(target) / 3, "b": Decimal(target) / 3,
           "c": Decimal(target) / 3}
    result = apportion_currency_amounts(raw, ["a", "b", "c"], target, currency)
    assert list(result.values()) == expected
    assert currency_units(sum(result.values()), currency) == currency_units(target, currency)


def test_currency_normalization():
    assert normalize_currency(" usd ") == "USD"
    assert normalize_currency(None) == "INR"
    assert normalize_currency(None, allow_none=True) is None


def test_frontend_catalog_code_and_precision_contract_matches_backend():
    source = (
        Path(__file__).resolve().parents[2] / "frontend" / "src" / "currencies.ts"
    ).read_text(encoding="utf-8")
    frontend_pairs = re.findall(
        r"\{\s*code:\s*'([A-Z]{3})'.*?minorUnits:\s*([023])\s*\}",
        source,
    )
    assert [(code, int(digits)) for code, digits in frontend_pairs] == list(
        CURRENCY_MINOR_UNITS.items()
    )


def test_unsupported_currency_is_rejected():
    with pytest.raises(ValueError, match="Unsupported currency"):
        normalize_currency("XYZ")


def test_trip_models_validate_currency():
    assert TripIn(name="Trip", currency="usd").currency == "USD"
    assert TripUpdate(currency="lkr").currency == "LKR"
    with pytest.raises(ValueError):
        TripIn(name="Trip", currency="XYZ")


def test_expense_models_accept_compatible_optional_currency():
    required = {
        "amount": 10,
        "category": "Food",
        "date": "01-01-26",
        "paid_by_member_id": "m1",
    }
    assert ExpenseIn(**required).currency is None
    assert ExpenseIn(**required, currency="npr").currency == "NPR"
    assert ExpenseUpdate(currency="USD").currency == "USD"
