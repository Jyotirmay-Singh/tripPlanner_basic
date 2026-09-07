"""Currency-policy helpers shared by payment and settlement write routes."""

from decimal import Decimal, InvalidOperation

from fastapi import HTTPException

from config import WHOLE_UNIT_SETTLEMENTS_ENABLED
from services.settlement_engine import POLICY_VERSION, settlement_increment
from utils.currency_rules import (
    CurrencyPrecisionError,
    currency_quantum,
    precision_error_detail,
    validate_currency_precision,
)


# Backward-compatible INR default for callers that import the constant; currency-aware gates derive
# their actual threshold as half of the trip currency's minor unit.
SETTLED_EPS = 0.005


def settled_epsilon(currency: str = "INR") -> float:
    return float(currency_quantum(currency) / 2)


def is_settled(net_value: float, currency: str = "INR") -> bool:
    return abs(net_value) < settled_epsilon(currency)


def entity_net(balances: dict, member_id: str) -> float:
    return balances.get("net", {}).get(member_id, 0.0)


def precise_entity_net(balances: dict, member_id: str) -> Decimal | None:
    """Return the canonical balance when projection metadata is available."""

    value = balances.get("settlement_projection", {}).get("precise_net", {}).get(member_id)
    if value is None:
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def is_precisely_settled(balances: dict, member_id: str) -> bool:
    """A removable entity cannot leave a precise residual with no owner in the live roster."""

    precise = precise_entity_net(balances, member_id)
    return is_settled(
        entity_net(balances, member_id), balances.get("currency", "INR")
    ) if precise is None else precise == 0


def family_rows(balances: dict, family_id: str) -> list:
    for row in balances.get("per_person", []):
        if row.get("member_id") == family_id:
            return row.get("members") or []
    return []


def family_member_net(balances: dict, family_id: str, family_member_id: str):
    for row in family_rows(balances, family_id):
        if row.get("id") == family_member_id:
            return row.get("net", 0.0)
    return None


def unsettled_family_members(balances: dict, family_id: str) -> list:
    return [
        row for row in family_rows(balances, family_id)
        if not is_settled(row.get("net", 0.0), balances.get("currency", "INR"))
    ]


def decimal_amount(value: object) -> Decimal:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise HTTPException(400, "Amount must be a finite number") from exc
    if not amount.is_finite():
        raise HTTPException(400, "Amount must be a finite number")
    return amount


def whole_unit_policy_enabled(trip: dict) -> bool:
    _increment, enabled = settlement_increment(
        trip.get("currency", "INR"), WHOLE_UNIT_SETTLEMENTS_ENABLED
    )
    return enabled


def validate_new_amount(trip: dict, value: object) -> tuple[Decimal, dict]:
    """Validate a newly recorded or amount-edited value and return audit fields."""

    currency = str(trip.get("currency", "INR")).upper()
    try:
        amount = validate_currency_precision(value, currency)
    except CurrencyPrecisionError as exc:
        raise HTTPException(422, precision_error_detail(exc)) from exc
    if amount <= 0:
        raise HTTPException(400, "Amount must be greater than zero")
    if not whole_unit_policy_enabled(trip):
        return amount, {}
    if amount != amount.to_integral_value():
        raise HTTPException(400, f"{currency} payments must be whole-rupee amounts")
    return amount, {
        "settlement_policy_version": POLICY_VERSION,
        "settlement_increment": "1",
    }


def payable_tolerance(trip: dict) -> Decimal:
    """Allow only sub-minor-unit transport noise; a full legal unit can never overpay."""

    if whole_unit_policy_enabled(trip):
        return Decimal("0")
    return currency_quantum(trip.get("currency", "INR")) / 2
