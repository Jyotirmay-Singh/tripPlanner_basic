import pytest

from models.expense import ExpenseIn, ExpenseUpdate
from models.trip import TripIn, TripUpdate
from utils.currency_rules import SUPPORTED_CURRENCIES, normalize_currency


def test_catalog_has_unique_expected_codes():
    assert len(SUPPORTED_CURRENCIES) == 26
    assert len(set(SUPPORTED_CURRENCIES)) == len(SUPPORTED_CURRENCIES)
    assert {"INR", "USD", "LKR", "NPR"}.issubset(SUPPORTED_CURRENCIES)


def test_currency_normalization():
    assert normalize_currency(" usd ") == "USD"
    assert normalize_currency(None) == "INR"
    assert normalize_currency(None, allow_none=True) is None


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
