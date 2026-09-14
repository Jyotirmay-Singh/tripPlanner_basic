"""Application-wide whole-major-unit money policy.

Active ledger values are integers in the currency's major unit.  Exchange-rate ratios are not
money and deliberately do not pass through this module.  Decimal parsing always starts from text so
binary floating-point midpoint behaviour can never change a write decision.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_HALF_UP, localcontext
from typing import Any, Iterable, Mapping, Optional


MONEY_POLICY_VERSION = "whole_unit_v1"
MONEY_INCREMENT = Decimal("1")
MONEY_INCREMENT_TEXT = "1"
MONEY_ROUNDING = "ROUND_HALF_UP"
MONEY_ROUNDING_DESCRIPTION = (
    "Round to the nearest whole major currency unit; midpoint values round away from zero."
)


class AmountRoundsToZeroError(ValueError):
    """A non-zero submitted monetary value cannot be represented by the active policy."""

    def __init__(self, value: Decimal, *, label: str = "Amount") -> None:
        self.value = value
        self.label = label
        super().__init__(f"{label} rounds to zero under {MONEY_POLICY_VERSION}")


def decimal_money(value: Any, *, label: str = "Amount") -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number") from exc
    if not parsed.is_finite():
        raise ValueError(f"{label} must be finite")
    return parsed


def whole_money(
    value: Any,
    *,
    label: str = "Amount",
    reject_nonzero_to_zero: bool = True,
) -> int:
    """Return a whole-unit integer using decimal ROUND_HALF_UP.

    ROUND_HALF_UP is symmetric for signed values: ``400.50 -> 401`` and
    ``-400.50 -> -401``.
    """

    parsed = decimal_money(value, label=label)
    with localcontext() as context:
        context.prec = 60
        rounded = int(parsed.quantize(MONEY_INCREMENT, rounding=ROUND_HALF_UP))
    if reject_nonzero_to_zero and parsed != 0 and rounded == 0:
        raise AmountRoundsToZeroError(parsed, label=label)
    return rounded


def positive_whole_money(value: Any, *, label: str = "Amount") -> int:
    parsed = decimal_money(value, label=label)
    if parsed <= 0:
        raise ValueError(f"{label} must be greater than zero")
    return whole_money(parsed, label=label)


def normalization_change(field: str, before: Any, after: Any) -> Optional[dict]:
    """Return an audit-ready before/after record only when normalization changed the value."""

    parsed_before = decimal_money(before, label=field)
    parsed_after = decimal_money(after, label=field)
    if parsed_before == parsed_after:
        return None
    return {
        "field": str(field),
        "before": format(parsed_before, "f"),
        "after": int(parsed_after) if parsed_after == parsed_after.to_integral_value() else format(parsed_after, "f"),
        "policy_version": MONEY_POLICY_VERSION,
        "rounding": MONEY_ROUNDING,
    }


def amount_rounds_to_zero_detail(exc: AmountRoundsToZeroError) -> dict:
    return {
        "code": "amount_rounds_to_zero",
        "message": str(exc),
        "field": exc.label,
        "submitted_value": format(exc.value, "f"),
        "money_policy_version": MONEY_POLICY_VERSION,
        "increment": MONEY_INCREMENT_TEXT,
        "rounding": MONEY_ROUNDING,
        "retryable": False,
    }


def money_policy_config() -> dict:
    return {
        "version": MONEY_POLICY_VERSION,
        "increment": MONEY_INCREMENT_TEXT,
        "rounding": MONEY_ROUNDING,
        "rounding_description": MONEY_ROUNDING_DESCRIPTION,
        "midpoint_examples": {
            "positive": {"before": "400.50", "after": 401},
            "negative": {"before": "-400.50", "after": -401},
        },
    }


def apportion_whole_amounts(
    values: Mapping[str, Any],
    order: Iterable[str],
    target: Any,
    *,
    preferred_id: Optional[str] = None,
) -> dict[str, int]:
    """Floor proportional amounts to whole units and conserve the signed target.

    For automatic splits, the first leftover unit goes to an eligible payer and remaining units
    follow visible roster order.  Callers that do not supply ``preferred_id`` use roster order for
    every leftover.  The sign is applied after allocating the magnitude so refunds mirror expenses.
    """

    keys = list(order)
    if len(set(keys)) != len(keys) or any(key not in values for key in keys):
        raise ValueError("Whole-unit apportionment order must contain each recipient exactly once")
    target_units = whole_money(target, label="Allocation total", reject_nonzero_to_zero=False)
    if not keys:
        if target_units:
            raise ValueError("Whole-unit apportionment has no recipients for a non-zero total")
        return {}

    sign = -1 if target_units < 0 else 1
    magnitude = abs(target_units)
    raw_magnitudes = {key: abs(decimal_money(values[key], label=f"Allocation for '{key}'")) for key in keys}
    total_raw = sum(raw_magnitudes.values(), Decimal(0))
    if total_raw == 0:
        if magnitude:
            raise ValueError("Whole-unit apportionment has no positive allocation weight")
        return {key: 0 for key in keys}

    bases: dict[str, int] = {}
    with localcontext() as context:
        context.prec = 60
        for key in keys:
            raw_share = Decimal(magnitude) * raw_magnitudes[key] / total_raw
            bases[key] = int(raw_share.to_integral_value(rounding=ROUND_FLOOR))

    needed = magnitude - sum(bases.values())
    if needed < 0 or needed > len(keys):
        raise ValueError("Whole-unit apportionment could not conserve the target")
    priority = list(keys)
    if preferred_id is not None and preferred_id in bases:
        preferred = preferred_id
        priority = [preferred, *[key for key in keys if key != preferred]]
    for key in priority[:needed]:
        bases[key] += 1

    result = {key: sign * bases[key] for key in keys}
    if sum(result.values()) != target_units:
        raise ValueError("Whole-unit apportionment did not match the target")
    return result


def allocate_whole_weighted(
    total: Any,
    weights: Mapping[str, Any],
    order: Iterable[str],
    *,
    preferred_id: Optional[str] = None,
) -> dict[str, int]:
    normalized: dict[str, Decimal] = {}
    for member_id, raw_weight in weights.items():
        weight = decimal_money(raw_weight, label=f"Weight for '{member_id}'")
        if weight < 0:
            raise ValueError(f"Weight cannot be negative for '{member_id}'")
        if weight:
            normalized[str(member_id)] = weight
    ordered = [str(member_id) for member_id in order if str(member_id) in normalized]
    if set(ordered) != set(normalized):
        ordered.extend(sorted(set(normalized) - set(ordered)))
    return apportion_whole_amounts(
        normalized,
        ordered,
        total,
        preferred_id=preferred_id,
    )
