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

All reconciliation is done in INTEGER CENTS. The one hard rule (Σ amounts == total) is validated here and
the amounts are snapped (largest-remainder) so the resolved entity shares always sum EXACTLY to the
stored total. This module is the single source of truth every EXACT branch point calls into.
"""

import math
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP

from services.member_breakdown import family_member_ids


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


def validate_original_exact_amounts(total: Decimal, custom_amounts: dict, members: list) -> dict:
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
        value = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if value < 0:
            raise ValueError("Exact split: amounts cannot be negative.")
        normalized[pid] = value
    if not any(value > 0 for value in normalized.values()):
        raise ValueError("Exact split: at least one amount must be greater than 0.")
    expected = abs(total).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    actual = sum(normalized.values(), Decimal("0.00"))
    if actual != expected:
        raise ValueError(
            f"Exact split: amounts must add up to the original total ({expected:.2f}); "
            f"they currently add up to {actual:.2f}."
        )
    return normalized


def convert_original_exact_amounts(original_amounts: dict, rate: Decimal,
                                   canonical_total: Decimal, members: list) -> dict:
    """Convert original magnitudes and apportion target cents by largest remainder."""
    roster_order = ordered_exact_member_ids(members)
    order = [pid for pid in roster_order if pid in original_amounts]
    # Defensive stable ordering for a valid legacy/synthetic id not represented by current roster.
    order.extend(sorted(pid for pid in original_amounts if pid not in order))
    bases: dict[str, int] = {}
    remainders: dict[str, Decimal] = {}
    for pid in order:
        raw_cents = Decimal(str(original_amounts[pid])) * rate * Decimal("100")
        base = int(raw_cents.to_integral_value(rounding=ROUND_DOWN))
        bases[pid] = base
        remainders[pid] = raw_cents - Decimal(base)
    target_cents = int(
        abs(canonical_total).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) * Decimal("100")
    )
    needed = target_cents - sum(bases.values())
    if needed < 0 or needed > len(order):
        raise ValueError("Exact split conversion could not be reconciled to the canonical total")
    ranking = sorted(order, key=lambda pid: (-remainders[pid], roster_order.index(pid)
                                              if pid in roster_order else len(roster_order)))
    cents = dict(bases)
    for pid in ranking[:needed]:
        cents[pid] += 1
    sign = -1 if canonical_total < 0 else 1
    out = {pid: sign * cents[pid] / 100.0 for pid in order}
    if round(sum(out.values()) * 100) != round(float(canonical_total) * 100):
        raise ValueError("Exact split conversion did not sum to the canonical total")
    return out


def _snap_to_cents(amounts: dict, order: list, target_c: int) -> dict:
    """Largest-remainder snap so the returned float amounts sum EXACTLY to `target_c` cents. All EXACT
    amounts are >= 0, so flooring toward 0 is correct. Deterministic: ties broken by `order`.
    (Self-contained mirror of the `_apportion` helper duplicated across the split services, kept local
    so this module stays independently pure.)"""
    base: dict = {}
    rem: dict = {}
    for k in order:
        vc = amounts[k] * 100.0
        b = math.floor(vc + 1e-9)
        base[k] = b
        rem[k] = vc - b
    need = target_c - sum(base.values())
    out_c = dict(base)
    if need > 0:
        ranked = sorted(order, key=lambda k: (-rem[k], order.index(k)))
        for k in ranked[:need]:
            out_c[k] += 1
    elif need < 0:
        ranked = sorted(order, key=lambda k: (rem[k], order.index(k)))
        for k in ranked[: -need]:
            out_c[k] -= 1
    return {k: out_c[k] / 100.0 for k in order}


def validate_exact_amounts(total: float, custom_amounts: dict, valid_member_ids) -> dict:
    """Validate an EXACT payload and return NORMALIZED (cent-snapped) amounts summing exactly to
    round(total, 2). Raises ValueError (which the API converts to HTTP 422) on any violation:

    - `custom_amounts` empty                       -> "select at least one person ..."
    - a key not in `valid_member_ids`              -> "unknown member ..."
    - any amount NaN/inf or < 0                    -> "amount ... cannot be negative"
    - all amounts 0                                -> "at least one amount must be greater than 0"
    - Σ amounts differs from total by > 0.01       -> "amounts must add up to the total ..."

    No I/O. `valid_member_ids` is anything supporting `in` (typically the set from
    `valid_exact_member_ids`)."""
    ca = custom_amounts or {}
    if not ca:
        raise ValueError("Exact split: select at least one person and enter their amounts.")

    valid = set(valid_member_ids)
    for pid, amt in ca.items():
        if pid not in valid:
            raise ValueError(f"Exact split: '{pid}' is not a member of this trip.")
        if amt is None or not math.isfinite(amt):
            raise ValueError("Exact split: every amount must be a number.")
        if amt < 0:
            raise ValueError("Exact split: amounts cannot be negative.")

    order = list(ca.keys())
    raw_sum = sum(float(ca[k]) for k in order)
    if round(raw_sum * 100) <= 0:
        raise ValueError("Exact split: at least one amount must be greater than 0.")

    total_c = round(total * 100)
    if abs(round(raw_sum * 100) - total_c) > 1:
        raise ValueError(
            f"Exact split: amounts must add up to the total ({total:.2f}); "
            f"they currently add up to {raw_sum:.2f}."
        )

    return _snap_to_cents({k: float(ca[k]) for k in order}, order, total_c)


def resolve_exact_entity_shares(custom_amounts: dict, members: list) -> dict:
    """Roll person-level `custom_amounts` UP to `{entity_id -> amount}`, integer-cent safe. A family's
    share = Σ of its members present; a standalone individual's share = their own amount. Keys are
    top-level entity ids, exactly like `split_per_capita` / `split_per_family`, so the ledger consumes
    it unchanged. Zero-valued entities are omitted (they neither owe nor are owed). Unknown keys are
    ignored here (the write-time validator already rejects them)."""
    mapping = _person_to_entity(members)
    cents: dict = {}
    for pid, amt in (custom_amounts or {}).items():
        eid = mapping.get(pid)
        if eid is None:
            continue
        cents[eid] = cents.get(eid, 0) + round((amt or 0.0) * 100)
    return {eid: c / 100.0 for eid, c in cents.items() if c != 0}


def exact_member_shares(custom_amounts: dict, roster_ids: list) -> dict:
    """One family's per-member amounts for the DISPLAY breakdown: `{roster_id -> amount}` over
    `roster_ids`, an absent/unticked member contributing exactly 0.0. Because a family's entity share is
    Σ of these by construction, the per-member breakdown always foots to the family net."""
    ca = custom_amounts or {}
    return {rid: float(ca.get(rid, 0.0) or 0.0) for rid in roster_ids}
