"""Currency-policy helpers shared by payment and settlement write routes."""

from decimal import Decimal, InvalidOperation

from fastapi import HTTPException

from services.settlement_engine import POLICY_VERSION, settlement_increment
from utils.money_policy import (
    AmountRoundsToZeroError,
    amount_rounds_to_zero_detail,
    positive_whole_money,
)


# Backward-compatible INR default for callers that import the constant; currency-aware gates derive
# their actual threshold from the application-wide whole-unit increment.
SETTLED_EPS = 0.5


def settled_epsilon(currency: str = "INR") -> float:
    return 0.5


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
    _increment, enabled = settlement_increment(trip.get("currency", "INR"), True)
    return enabled


def validate_new_amount(trip: dict, value: object) -> tuple[Decimal, dict]:
    """Validate a newly recorded or amount-edited value and return audit fields."""

    try:
        amount = positive_whole_money(value)
    except AmountRoundsToZeroError as exc:
        raise HTTPException(422, amount_rounds_to_zero_detail(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Decimal(amount), {
        "settlement_policy_version": POLICY_VERSION,
        "settlement_increment": "1",
        "money_policy_version": POLICY_VERSION,
    }


def payable_tolerance(trip: dict) -> Decimal:
    """Whole-unit writes allow no overpayment tolerance."""

    return Decimal("0")
