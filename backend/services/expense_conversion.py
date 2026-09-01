"""Server-authoritative expense conversion and immutable audit metadata."""

from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Optional

from bson.decimal128 import Decimal128

from models.exchange_rate import ConversionRequest
from services.custom_split import (
    convert_original_exact_amounts,
    validate_original_exact_amounts,
)
from services.exchange_rates import (
    ExchangeRateError,
    decimal_value,
    load_quote,
    money,
)
from utils.common import now_utc
from utils.date_rules import expense_date_to_iso


def _confirmation_error(message: str) -> ExchangeRateError:
    return ExchangeRateError(
        message,
        code="conversion_confirmation_required",
        status_code=428,
        retryable=False,
    )


def _decimal128(value: Decimal) -> Decimal128:
    return Decimal128(value)


def _decimal_map(values: Optional[dict]) -> Optional[dict]:
    if values is None:
        return None
    return {key: _decimal128(Decimal(str(value))) for key, value in values.items()}


def serialize_bson(value: Any) -> Any:
    """Convert precise BSON values to stable JSON-safe representations."""
    if isinstance(value, Decimal128):
        return str(value.to_decimal())
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: serialize_bson(item) for key, item in value.items()}
    if isinstance(value, list):
        return [serialize_bson(item) for item in value]
    if hasattr(value, "isoformat") and not isinstance(value, str):
        return value.isoformat()
    return value


def stored_original_amount(expense: dict) -> Decimal:
    if expense.get("original_amount") is not None:
        return decimal_value(expense["original_amount"])
    return money(expense.get("amount"))


def stored_original_currency(expense: dict, trip_currency: str) -> str:
    return expense.get("original_currency") or expense.get("currency") or trip_currency


def stored_original_custom_amounts(expense: dict) -> Optional[dict]:
    raw = expense.get("original_custom_amounts")
    if raw is not None:
        return {key: decimal_value(value) for key, value in raw.items()}
    custom = expense.get("custom_amounts")
    if custom is None:
        return None
    return {key: abs(Decimal(str(value))) for key, value in custom.items()}


def reallocate_exact_with_locked_rate(expense: dict, original_custom_amounts: dict,
                                      members: list) -> tuple[dict, dict]:
    """Rebuild EXACT shares without fetching/replacing an otherwise locked conversion rate."""
    original = validate_original_exact_amounts(
        stored_original_amount(expense), original_custom_amounts, members
    )
    rate = decimal_value(expense.get("exchange_rate", Decimal("1")))
    canonical = money(expense.get("amount"))
    canonical_custom = convert_original_exact_amounts(original, rate, canonical, members)
    return _decimal_map(original), canonical_custom


def locked_exact_reallocation_update(*, expense: dict, original_custom_amounts: dict,
                                     members: list, user_id: str, version: int) -> dict:
    """Build an audited EXACT-allocation update while preserving the locked FX quote and total."""
    original_map, canonical_custom = reallocate_exact_with_locked_rate(
        expense, original_custom_amounts, members
    )
    timestamp = now_utc()
    original_amount = stored_original_amount(expense)
    original_currency = stored_original_currency(
        expense, expense.get("currency") or "INR"
    )
    rate = decimal_value(expense.get("exchange_rate", Decimal("1")))
    history = {
        "version": version,
        "reason": "exact_reallocated",
        "original_amount": _decimal128(original_amount),
        "original_currency": original_currency,
        "original_custom_amounts": original_map,
        "canonical_amount": float(money(expense.get("amount"))),
        "canonical_currency": expense.get("currency") or "INR",
        "canonical_custom_amounts": canonical_custom,
        "rate": _decimal128(rate),
        "requested_date": expense.get("exchange_rate_requested_date"),
        "effective_date": expense.get("exchange_rate_date"),
        "provider": expense.get("exchange_rate_provider") or "identity",
        "provider_sources": expense.get("exchange_rate_provider_sources") or [],
        "mode": expense.get("exchange_rate_mode") or "automatic",
        "manual_input_type": expense.get("manual_input_type"),
        "manual_input_value": expense.get("manual_input_value"),
        "stale": bool(expense.get("exchange_rate_stale")),
        "changed_at": timestamp,
        "changed_by": user_id,
    }
    return {
        "custom_amounts": canonical_custom,
        "metadata": {
            "original_custom_amounts": original_map,
            "conversion_version": version,
            "conversion_updated_at": timestamp,
            "conversion_updated_by": user_id,
        },
        "history": history,
    }


def _quote_manual_value(conversion: ConversionRequest) -> Optional[Decimal]:
    if conversion.manual_input_type == "rate":
        return conversion.manual_rate
    if conversion.manual_input_type == "target_amount":
        return conversion.manual_target_amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return None


async def _validated_rate_result(*, user_id: str, source_amount: Decimal,
                                 source_currency: str, target_currency: str,
                                 requested_date: str,
                                 conversion: Optional[ConversionRequest]) -> dict:
    if source_currency == target_currency:
        if conversion and conversion.mode != "automatic":
            raise ValueError("Same-currency expenses always use rate 1")
        return {
            "quote_id": None,
            "mode": "automatic",
            "target_amount": source_amount,
            "rate": Decimal("1"),
            "effective_rate_date": requested_date,
            "provider": "identity",
            "provider_sources": [],
            "cache_revision": 1,
            "cache_hit": True,
            "stale": False,
            "manual_input_type": None,
            "manual_input_value": None,
        }

    if not conversion or not conversion.approved or not conversion.quote_id:
        raise _confirmation_error("Review and approve an exchange-rate quote before saving")
    quote = await load_quote(conversion.quote_id, user_id)
    if quote.get("source_currency") != source_currency \
            or quote.get("target_currency") != target_currency \
            or decimal_value(quote.get("source_amount")) != source_amount \
            or quote.get("requested_date") != requested_date \
            or quote.get("mode") != conversion.mode:
        raise _confirmation_error("The approved quote no longer matches the expense inputs")
    if quote.get("stale") and not conversion.allow_stale:
        raise _confirmation_error("Confirm that you want to use the stale cached quote")
    if conversion.mode == "manual":
        if quote.get("manual_input_type") != conversion.manual_input_type:
            raise _confirmation_error("The approved manual quote no longer matches the selected mode")
        supplied = _quote_manual_value(conversion)
        stored = decimal_value(quote.get("manual_input_value"))
        if supplied is None or stored != supplied:
            raise _confirmation_error("The approved manual quote no longer matches the entered value")
    return {
        "quote_id": quote["id"],
        "mode": quote["mode"],
        "target_amount": decimal_value(quote["target_amount"]),
        "rate": decimal_value(quote["rate"]),
        "effective_rate_date": quote.get("effective_rate_date"),
        "provider": quote["provider"],
        "provider_sources": quote.get("provider_sources") or [],
        "cache_revision": int(quote.get("cache_revision", 1)),
        "cache_hit": bool(quote.get("cache_hit")),
        "stale": bool(quote.get("stale")),
        "manual_input_type": quote.get("manual_input_type"),
        "manual_input_value": quote.get("manual_input_value"),
    }


async def convert_expense(*, user_id: str, trip_currency: str, date: str,
                          split_mode: str, members: list, original_amount: Any,
                          original_currency: str,
                          original_custom_amounts: Optional[dict],
                          conversion: Optional[ConversionRequest], version: int,
                          reason: str) -> dict:
    source_amount = money(original_amount)
    requested_date = expense_date_to_iso(date)
    rate_result = await _validated_rate_result(
        user_id=user_id,
        source_amount=source_amount,
        source_currency=original_currency,
        target_currency=trip_currency,
        requested_date=requested_date,
        conversion=conversion,
    )
    canonical = rate_result["target_amount"].quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    if canonical == 0:
        raise ValueError("Converted amount rounds to zero in the trip currency")

    normalized_original_custom = None
    canonical_custom = None
    if split_mode == "EXACT":
        normalized_original_custom = validate_original_exact_amounts(
            source_amount, original_custom_amounts or {}, members
        )
        canonical_custom = convert_original_exact_amounts(
            normalized_original_custom, rate_result["rate"], canonical, members
        )

    timestamp = now_utc()
    provider_sources = rate_result["provider_sources"]
    metadata = {
        "original_amount": _decimal128(source_amount),
        "original_currency": original_currency,
        "original_custom_amounts": _decimal_map(normalized_original_custom),
        "exchange_rate": _decimal128(rate_result["rate"]),
        "exchange_rate_requested_date": requested_date,
        "exchange_rate_date": rate_result["effective_rate_date"],
        "exchange_rate_provider": rate_result["provider"],
        "exchange_rate_provider_sources": provider_sources,
        "exchange_rate_mode": rate_result["mode"],
        "manual_input_type": rate_result["manual_input_type"],
        "manual_input_value": rate_result["manual_input_value"],
        "exchange_rate_stale": rate_result["stale"],
        "exchange_rate_cache_hit": rate_result["cache_hit"],
        "exchange_rate_cache_revision": rate_result["cache_revision"],
        "conversion_quote_id": rate_result["quote_id"],
        "conversion_version": version,
        "conversion_updated_at": timestamp,
        "conversion_updated_by": user_id,
    }
    history = {
        "version": version,
        "reason": reason,
        "original_amount": _decimal128(source_amount),
        "original_currency": original_currency,
        "original_custom_amounts": _decimal_map(normalized_original_custom),
        "canonical_amount": float(canonical),
        "canonical_currency": trip_currency,
        "canonical_custom_amounts": canonical_custom,
        "rate": _decimal128(rate_result["rate"]),
        "requested_date": requested_date,
        "effective_date": rate_result["effective_rate_date"],
        "provider": rate_result["provider"],
        "provider_sources": provider_sources,
        "mode": rate_result["mode"],
        "manual_input_type": rate_result["manual_input_type"],
        "manual_input_value": rate_result["manual_input_value"],
        "stale": rate_result["stale"],
        "changed_at": timestamp,
        "changed_by": user_id,
    }
    return {
        "amount": float(canonical),
        "currency": trip_currency,
        "custom_amounts": canonical_custom,
        "metadata": metadata,
        "history": history,
    }


async def convert_create_body(body, trip: dict, user_id: str) -> dict:
    trip_currency = trip.get("currency", "INR")
    if body.original_amount is not None:
        source_amount = body.original_amount
        source_currency = body.original_currency or trip_currency
        original_custom = body.original_custom_amounts
    else:
        source_amount = body.amount
        source_currency = body.currency or trip_currency
        if source_currency != trip_currency:
            raise _confirmation_error(
                "Foreign expenses must use original_amount, original_currency, and an approved quote"
            )
        original_custom = body.custom_amounts
    return await convert_expense(
        user_id=user_id,
        trip_currency=trip_currency,
        date=body.date,
        split_mode=body.split_mode,
        members=trip["members"],
        original_amount=source_amount,
        original_currency=source_currency,
        original_custom_amounts=original_custom,
        conversion=body.conversion,
        version=1,
        reason="created",
    )
