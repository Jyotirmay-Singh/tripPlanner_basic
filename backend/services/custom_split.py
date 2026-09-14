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

All reconciliation is done in whole major-currency units. The one hard rule (Σ amounts == total)
is validated here so resolved entity shares always sum exactly to the stored total. This module is
the single source of truth every EXACT branch point calls into.
"""

from decimal import Decimal

from services.member_breakdown import family_member_ids
from utils.money_policy import (
    AmountRoundsToZeroError,
    apportion_whole_amounts,
    decimal_money,
    whole_money,
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
    payer_id: str | None = None,
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
            value = decimal_money(raw, label="Exact split amount")
        except ValueError as exc:
            raise ValueError("Exact split: every amount must be a finite number.") from exc
        if value < 0:
            raise ValueError("Exact split: amounts cannot be negative.")
        normalized[pid] = value
    if not any(value > 0 for value in normalized.values()):
        raise ValueError("Exact split: at least one amount must be greater than 0.")
    expected = abs(decimal_money(total, label="Total"))
    actual = sum(normalized.values(), Decimal(0))
    if actual != expected:
        raise ValueError(
            f"Exact split: amounts must add up to the original total ({expected:f}); "
            f"they currently add up to {actual:f}."
        )
    target = abs(whole_money(expected, label="Total"))
    order = [pid for pid in ordered_exact_member_ids(members) if pid in normalized]
    order.extend(sorted(pid for pid in normalized if pid not in order))
    apportioned = apportion_whole_amounts(
        normalized,
        order,
        target,
        preferred_id=payer_id if payer_id in normalized else None,
    )
    return apportioned


def convert_original_exact_amounts(original_amounts: dict, rate: Decimal,
                                   canonical_total: Decimal, members: list,
                                   target_currency: str = "INR",
                                   payer_id: str | None = None) -> dict:
    """Convert original magnitudes and apportion whole target-currency units."""
    roster_order = ordered_exact_member_ids(members)
    order = [pid for pid in roster_order if pid in original_amounts]
    # Defensive stable ordering for a valid legacy/synthetic id not represented by current roster.
    order.extend(sorted(pid for pid in original_amounts if pid not in order))
    raw_converted = {
        pid: decimal_money(original_amounts[pid], label="Exact split amount") * rate
        for pid in order
    }
    target_units = abs(whole_money(canonical_total, label="Converted total"))
    units = apportion_whole_amounts(
        raw_converted,
        order,
        target_units,
        preferred_id=payer_id if payer_id in raw_converted else None,
    )
    sign = -1 if decimal_money(canonical_total) < 0 else 1
    out = {pid: sign * units[pid] for pid in order}
    if sum(abs(value) for value in out.values()) != target_units:
        raise ValueError("Exact split conversion did not sum to the canonical total")
    return out


def _snap_to_units(amounts: dict, order: list, target_units: int, currency: str) -> dict:
    """Whole-unit snap kept behind the legacy helper name for existing callers/tests."""
    return apportion_whole_amounts(amounts, order, target_units)


def validate_exact_amounts(
    total: float,
    custom_amounts: dict,
    valid_member_ids,
    currency: str = "INR",
) -> dict:
    """Validate an EXACT payload and return whole-unit amounts summing exactly to total.

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

    expected = abs(decimal_money(total, label="Total"))
    valid = set(valid_member_ids)
    normalized: dict[str, Decimal] = {}
    for pid, amt in ca.items():
        if pid not in valid:
            raise ValueError(f"Exact split: '{pid}' is not a member of this trip.")
        try:
            value = decimal_money(amt, label="Exact split amount")
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
        raise ValueError(
            f"Exact split: amounts must add up to the total ({expected:f}); "
            f"they currently add up to {actual:f}."
        )

    total_units = abs(whole_money(expected, label="Total"))
    snapped = _snap_to_units(normalized, order, total_units, currency)
    return snapped


def resolve_exact_entity_shares(custom_amounts: dict, members: list, currency: str = "INR") -> dict:
    """Roll whole-unit person allocations up to entity amounts.

    A family's share is the sum of its members present; a standalone individual's share is their own
    amount. Keys are top-level entity ids, exactly like `split_per_capita` / `split_per_family`, so
    the ledger consumes them unchanged. Zero-valued entities are omitted. Unknown keys are ignored
    here because the write-time validator already rejects them.
    """
    mapping = _person_to_entity(members)
    raw_entities: dict[str, Decimal] = {}
    for pid, amt in (custom_amounts or {}).items():
        eid = mapping.get(pid)
        if eid is None:
            continue
        raw_entities[eid] = raw_entities.get(eid, Decimal(0)) + decimal_money(
            amt or 0,
            label="Exact split amount",
        )
    order = [member["id"] for member in members if member["id"] in raw_entities]
    target = whole_money(
        sum(raw_entities.values(), Decimal(0)),
        label="Exact split total",
        reject_nonzero_to_zero=False,
    )
    apportioned = apportion_whole_amounts(raw_entities, order, target) if order else {}
    return {eid: value for eid, value in apportioned.items() if value != 0}


def exact_member_shares(custom_amounts: dict, roster_ids: list) -> dict:
    """One family's per-member amounts for the DISPLAY breakdown: `{roster_id -> amount}` over
    `roster_ids`, an absent/unticked member contributing exactly 0.0. Because a family's entity share is
    Σ of these by construction, the per-member breakdown always foots to the family net."""
    ca = custom_amounts or {}
    return {
        rid: whole_money(
            ca.get(rid, 0) or 0,
            label="Exact split amount",
            reject_nonzero_to_zero=False,
        )
        for rid in roster_ids
    }
