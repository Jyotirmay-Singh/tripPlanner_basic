"""EXACT split mode (Phase 22) — pure helpers, no I/O.

EXACT lets the expense author assign an explicit per-person amount (family members and/or standalone
individuals). Input is PERSON-level (`custom_amounts: {member_id -> amount}`); presence of a key means
"involved", absence means 0. These person-level amounts roll UP to the same `{entity_id -> amount}` shape
the two existing modes emit (`split_per_capita` / `split_per_family`), so the ledger
(`utils.balances._compute_balances`), the read-time share re-derivation (`services.expense_shares`), and
the scaled settlement ledger (`services.settlement_engine`) consumes EXACT with no mode-specific
routing fork.

Person-level id space = every standalone-individual entity id ∪ every family's roster ids
(`services.member_breakdown.family_member_ids`). A family's entity share = Σ of its involved members'
amounts; a standalone individual's share = their own amount.

All reconciliation is done in integer currency minor units. The one hard rule (Σ amounts == total)
is validated here so resolved entity shares always sum exactly to the stored total. This module is
the single source of truth every EXACT branch point calls into.
"""

from decimal import Decimal, ROUND_DOWN

from services.member_breakdown import family_member_ids
from utils.currency_rules import (
    CurrencyPrecisionError,
    apportion_currency_amounts,
    currency_minor_units,
    currency_units,
    quantize_currency,
    validate_currency_precision,
)


def _person_to_entity(members: list) -> dict:
    """member_id (person-level) -> owning entity id. Family roster ids map to the family entity id;
    a standalone individual maps to itself."""
    mapping: dict = {}
    for m in members:
        if m.get("kind") == "family":
            for rid in family_member_ids(m):
                mapping[rid] = m["id"]
        else:
            mapping[m["id"]] = m["id"]
    return mapping


def valid_exact_member_ids(members: list) -> set:
    """The set of person-level ids a caller may key `custom_amounts` by: individual entity ids plus
    every family's roster member ids."""
    return set(_person_to_entity(members).keys())


def ordered_exact_member_ids(members: list) -> list:
    """Stable person order used as the deterministic tie-breaker for converted allocations."""
    return list(_person_to_entity(members).keys())


def validate_original_exact_amounts(
    total: Decimal,
    custom_amounts: dict,
    members: list,
    currency: str = "INR",
) -> dict:
    """Validate positive original-currency allocation magnitudes against ``abs(total)``.

    Refund allocations stay positive in the edit/audit model; the expense sign is applied only to
    the canonical ``custom_amounts`` consumed by the ledger.
    """
    ca = custom_amounts or {}
    if not ca:
        raise ValueError("Exact split: select at least one person and enter their amounts.")
    valid = valid_exact_member_ids(members)
    normalized: dict[str, Decimal] = {}
    for pid, raw in ca.items():
        if pid not in valid:
            raise ValueError(f"Exact split: '{pid}' is not a member of this trip.")
        try:
            value = Decimal(str(raw))
        except Exception:
            raise ValueError("Exact split: every amount must be a number.")
        if not value.is_finite():
            raise ValueError("Exact split: every amount must be a finite number.")
        value = validate_currency_precision(value, currency, label="Exact split amount")
        if value < 0:
            raise ValueError("Exact split: amounts cannot be negative.")
        normalized[pid] = value
    if not any(value > 0 for value in normalized.values()):
        raise ValueError("Exact split: at least one amount must be greater than 0.")
    expected = validate_currency_precision(abs(total), currency)
    actual = sum(normalized.values(), Decimal(0))
    if actual != expected:
        digits = currency_minor_units(currency)
        raise ValueError(
            f"Exact split: amounts must add up to the original total ({expected:.{digits}f}); "
            f"they currently add up to {actual:.{digits}f}."
        )
    return normalized


def convert_original_exact_amounts(original_amounts: dict, rate: Decimal,
                                   canonical_total: Decimal, members: list,
                                   target_currency: str = "INR") -> dict:
    """Convert original magnitudes and apportion target currency units by largest remainder."""
    roster_order = ordered_exact_member_ids(members)
    order = [pid for pid in roster_order if pid in original_amounts]
    # Defensive stable ordering for a valid legacy/synthetic id not represented by current roster.
    order.extend(sorted(pid for pid in original_amounts if pid not in order))
    bases: dict[str, int] = {}
    remainders: dict[str, Decimal] = {}
    scale = Decimal(10) ** currency_minor_units(target_currency)
    for pid in order:
        raw_units = Decimal(str(original_amounts[pid])) * rate * scale
        base = int(raw_units.to_integral_value(rounding=ROUND_DOWN))
        bases[pid] = base
        remainders[pid] = raw_units - Decimal(base)
    target_units = abs(currency_units(canonical_total, target_currency))
    needed = target_units - sum(bases.values())
    if needed < 0 or needed > len(order):
        raise ValueError("Exact split conversion could not be reconciled to the canonical total")
    ranking = sorted(order, key=lambda pid: (-remainders[pid], roster_order.index(pid)
                                              if pid in roster_order else len(roster_order)))
    units = dict(bases)
    for pid in ranking[:needed]:
        units[pid] += 1
    sign = -1 if canonical_total < 0 else 1
    numeric_scale = 10 ** currency_minor_units(target_currency)
    out = {pid: sign * units[pid] / numeric_scale for pid in order}
    if sum(units.values()) != target_units:
        raise ValueError("Exact split conversion did not sum to the canonical total")
    return out


def _snap_to_units(amounts: dict, order: list, target_units: int, currency: str) -> dict:
    """Largest-remainder snap so returned floats sum exactly in the currency's minor units. All EXACT
    amounts are >= 0, so flooring toward 0 is correct. Deterministic: ties broken by `order`.
    The shared currency helper keeps this write-time path aligned with reports and breakdowns."""
    scale = Decimal(10) ** currency_minor_units(currency)
    target = Decimal(target_units) / scale
    return apportion_currency_amounts(amounts, order, target, currency)


def validate_exact_amounts(
    total: float,
    custom_amounts: dict,
    valid_member_ids,
    currency: str = "INR",
) -> dict:
    """Validate an EXACT payload and return minor-unit-normalized amounts summing exactly to total.

    Raises ValueError (which the API converts to HTTP 422) on any violation:

    - `custom_amounts` empty                       -> "select at least one person ..."
    - a key not in `valid_member_ids`              -> "unknown member ..."
    - any amount NaN/inf or < 0                    -> "amount ... cannot be negative"
    - all amounts 0                                -> "at least one amount must be greater than 0"
    - Σ amounts differs from total                 -> "amounts must add up to the total ..."

    No I/O. `valid_member_ids` is anything supporting `in` (typically the set from
    `valid_exact_member_ids`)."""
    ca = custom_amounts or {}
    if not ca:
        raise ValueError("Exact split: select at least one person and enter their amounts.")

    expected = validate_currency_precision(total, currency, label="Total")
    valid = set(valid_member_ids)
    normalized: dict[str, Decimal] = {}
    for pid, amt in ca.items():
        if pid not in valid:
            raise ValueError(f"Exact split: '{pid}' is not a member of this trip.")
        try:
            value = validate_currency_precision(
                amt, currency, label="Exact split amount"
            )
        except CurrencyPrecisionError:
            raise
        except (TypeError, ValueError) as exc:
            raise ValueError("Exact split: every amount must be a number.") from exc
        if not value.is_finite():
            raise ValueError("Exact split: every amount must be a number.")
        if value < 0:
            raise ValueError("Exact split: amounts cannot be negative.")
        normalized[pid] = value

    order = list(ca.keys())
    actual = sum(normalized.values(), Decimal(0))
    if actual <= 0:
        raise ValueError("Exact split: at least one amount must be greater than 0.")

    if actual != expected:
        digits = currency_minor_units(currency)
        raise ValueError(
            f"Exact split: amounts must add up to the total ({expected:.{digits}f}); "
            f"they currently add up to {actual:.{digits}f}."
        )

    scale = 10 ** currency_minor_units(currency)
    total_units = int(expected * scale)
    return _snap_to_units(
        {key: float(normalized[key]) for key in order}, order, total_units, currency
    )


def resolve_exact_entity_shares(custom_amounts: dict, members: list, currency: str = "INR") -> dict:
    """Roll person-level `custom_amounts` up to entity amounts using currency minor units.

    A family's share is the sum of its members present; a standalone individual's share is their own
    amount. Keys are top-level entity ids, exactly like `split_per_capita` / `split_per_family`, so
    the ledger consumes them unchanged. Zero-valued entities are omitted. Unknown keys are ignored
    here because the write-time validator already rejects them.
    """
    mapping = _person_to_entity(members)
    units: dict = {}
    for pid, amt in (custom_amounts or {}).items():
        eid = mapping.get(pid)
        if eid is None:
            continue
        units[eid] = units.get(eid, 0) + currency_units(amt or 0.0, currency)
    scale = 10 ** currency_minor_units(currency)
    return {eid: value / scale for eid, value in units.items() if value != 0}


def exact_member_shares(custom_amounts: dict, roster_ids: list) -> dict:
    """One family's per-member amounts for the DISPLAY breakdown: `{roster_id -> amount}` over
    `roster_ids`, an absent/unticked member contributing exactly 0.0. Because a family's entity share is
    Σ of these by construction, the per-member breakdown always foots to the family net."""
    ca = custom_amounts or {}
    return {rid: float(ca.get(rid, 0.0) or 0.0) for rid in roster_ids}
