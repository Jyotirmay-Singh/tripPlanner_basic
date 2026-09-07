"""Read-only inspection helpers for the ISO currency-precision rollout."""

from __future__ import annotations

from typing import Any, Iterable

from utils.currency_rules import (
    CurrencyPrecisionError,
    currency_minor_units,
    normalize_currency,
    validate_currency_precision,
)


def _display_value(value: Any) -> str:
    if hasattr(value, "to_decimal"):
        value = value.to_decimal()
    return str(value)


def _allowed_digits(currency: Any) -> int | None:
    try:
        return currency_minor_units(currency)
    except (KeyError, TypeError, ValueError):
        return None


def _violation(
    *,
    record_type: str,
    record_id: Any,
    trip_id: Any,
    field: str,
    currency: Any,
    value: Any,
    allowed_digits: int | None,
    reason: str,
) -> dict:
    return {
        "record_type": record_type,
        "record_id": str(record_id or ""),
        "trip_id": str(trip_id or ""),
        "field": field,
        "currency": str(currency or ""),
        "value": _display_value(value),
        "allowed_digits": allowed_digits,
        "reason": reason,
    }


def _audit_amount(
    violations: list[dict],
    *,
    record_type: str,
    record_id: Any,
    trip_id: Any,
    field: str,
    currency: Any,
    value: Any,
) -> None:
    if value is None:
        return
    try:
        code = normalize_currency(currency)
    except ValueError:
        violations.append(_violation(
            record_type=record_type,
            record_id=record_id,
            trip_id=trip_id,
            field=field,
            currency=currency,
            value=value,
            allowed_digits=None,
            reason="unsupported_currency",
        ))
        return
    try:
        validate_currency_precision(value, code, label=field)
    except CurrencyPrecisionError:
        violations.append(_violation(
            record_type=record_type,
            record_id=record_id,
            trip_id=trip_id,
            field=field,
            currency=code,
            value=value,
            allowed_digits=currency_minor_units(code),
            reason="excess_precision",
        ))
    except ValueError:
        violations.append(_violation(
            record_type=record_type,
            record_id=record_id,
            trip_id=trip_id,
            field=field,
            currency=code,
            value=value,
            allowed_digits=currency_minor_units(code),
            reason="invalid_amount",
        ))


def _audit_map(
    violations: list[dict],
    *,
    record_type: str,
    record_id: Any,
    trip_id: Any,
    field: str,
    currency: Any,
    values: Any,
) -> None:
    if values is None:
        return
    if not isinstance(values, dict):
        violations.append(_violation(
            record_type=record_type,
            record_id=record_id,
            trip_id=trip_id,
            field=field,
            currency=currency,
            value=values,
            allowed_digits=None,
            reason="invalid_amount_map",
        ))
        return
    for member_id, value in values.items():
        _audit_amount(
            violations,
            record_type=record_type,
            record_id=record_id,
            trip_id=trip_id,
            field=f"{field}.{member_id}",
            currency=currency,
            value=value,
        )


def audit_currency_precision(
    trips: Iterable[dict],
    expenses: Iterable[dict],
    settlements: Iterable[dict],
    payments: Iterable[dict],
) -> list[dict]:
    """Return persisted money values that violate their currency contract.

    This function is deliberately pure. It never rounds, repairs, or mutates a document.
    """

    trip_rows = list(trips)
    trip_by_id = {str(row.get("id")): row for row in trip_rows}
    violations: list[dict] = []

    for trip in trip_rows:
        trip_id = trip.get("id")
        raw_currency = trip.get("currency") or "INR"
        try:
            currency = normalize_currency(raw_currency)
        except ValueError:
            violations.append(_violation(
                record_type="trip",
                record_id=trip_id,
                trip_id=trip_id,
                field="currency",
                currency=raw_currency,
                value=raw_currency,
                allowed_digits=None,
                reason="unsupported_currency",
            ))
            continue
        _audit_amount(
            violations,
            record_type="trip",
            record_id=trip_id,
            trip_id=trip_id,
            field="budget",
            currency=currency,
            value=trip.get("budget"),
        )

    for expense in expenses:
        record_id = expense.get("id")
        trip_id = expense.get("trip_id")
        trip = trip_by_id.get(str(trip_id), {})
        trip_currency = trip.get("currency") or "INR"
        canonical_currency = expense.get("currency") or trip_currency
        original_currency = expense.get("original_currency") or canonical_currency
        if trip and canonical_currency != trip_currency:
            violations.append(_violation(
                record_type="expense",
                record_id=record_id,
                trip_id=trip_id,
                field="currency",
                currency=trip_currency,
                value=canonical_currency,
                allowed_digits=_allowed_digits(trip_currency),
                reason="canonical_currency_mismatch",
            ))
        _audit_amount(
            violations,
            record_type="expense",
            record_id=record_id,
            trip_id=trip_id,
            field="amount",
            currency=canonical_currency,
            value=expense.get("amount"),
        )
        if expense.get("original_amount") is not None:
            _audit_amount(
                violations,
                record_type="expense",
                record_id=record_id,
                trip_id=trip_id,
                field="original_amount",
                currency=original_currency,
                value=expense.get("original_amount"),
            )
        _audit_map(
            violations,
            record_type="expense",
            record_id=record_id,
            trip_id=trip_id,
            field="custom_amounts",
            currency=canonical_currency,
            values=expense.get("custom_amounts"),
        )
        _audit_map(
            violations,
            record_type="expense",
            record_id=record_id,
            trip_id=trip_id,
            field="original_custom_amounts",
            currency=original_currency,
            values=expense.get("original_custom_amounts"),
        )

    for record_type, rows in (("settlement", settlements), ("payment", payments)):
        for row in rows:
            trip_id = row.get("trip_id")
            trip = trip_by_id.get(str(trip_id), {})
            trip_currency = trip.get("currency") or "INR"
            currency = row.get("currency") or trip_currency
            if trip and currency != trip_currency:
                violations.append(_violation(
                    record_type=record_type,
                    record_id=row.get("id"),
                    trip_id=trip_id,
                    field="currency",
                    currency=trip_currency,
                    value=currency,
                    allowed_digits=_allowed_digits(trip_currency),
                    reason="trip_currency_mismatch",
                ))
            _audit_amount(
                violations,
                record_type=record_type,
                record_id=row.get("id"),
                trip_id=trip_id,
                field="amount",
                currency=currency,
                value=row.get("amount"),
            )

    return sorted(
        violations,
        key=lambda row: (
            row["trip_id"], row["record_type"], row["record_id"], row["field"]
        ),
    )


async def audit_database(database: Any) -> list[dict]:
    """Load only the relevant collections and run the read-only audit."""

    async def rows(collection_name: str) -> list[dict]:
        collection = getattr(database, collection_name)
        return await collection.find({}, {"_id": 0}).to_list(length=None)

    trips = await rows("trips")
    expenses = await rows("expenses")
    settlements = await rows("settlements")
    payments = await rows("payments")
    return audit_currency_precision(trips, expenses, settlements, payments)
