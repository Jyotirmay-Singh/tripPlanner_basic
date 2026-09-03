"""Pure helpers for the one-time income -> negative-expense migration (signed-amount model).

No DB / FastAPI imports — only ``services.calculator`` + ``utils.settlement_gate`` — so the
before/after balance simulation that drives the migration's read-only dry-run can be unit-tested in
isolation and can never silently diverge from the real ledger.

The migration removes the separate ``kind:"income"`` concept: an income row becomes a normal expense
with a NEGATIVE amount (money coming back to the group). Income rows were excluded from balances
before, so converting them DOES change historical balances for income-containing trips — these helpers
compute exactly which trips/members change so a human can sign off before any write.
"""

from services.settlement_engine import (
    CENT_INCREMENT_SCALED,
    build_precise_net,
    joint_round,
    scaled_number,
)
from utils.settlement_gate import is_settled


def compute_net(members: list, expenses: list, settlements: list) -> dict:
    """member_id -> rounded net. Faithful replica of ``utils.balances._compute_balances`` net loop:
    signed amounts, PER_CAPITA via resolve_weights+split_per_capita / PER_FAMILY via split_per_family,
    then settlements, then a single round(2). Every row passed in is treated as a signed expense (no
    ``kind`` filtering happens here — the caller decides which rows to include).

    PER_CAPITA honors ``family_participants`` exactly like the ledger: a family restricted to a subset
    of its roster counts as its involved-member count. The migration uses this symmetrically (before
    and after both go through here), so the income->negative deltas are unaffected by it."""
    precise = build_precise_net(members, expenses, settlements)
    rounded = joint_round(precise, CENT_INCREMENT_SCALED)
    return {
        member_id: scaled_number(value * CENT_INCREMENT_SCALED)
        for member_id, value in rounded.items()
    }


def to_negative_expense(row: dict) -> dict:
    """An income row as it will be stored post-migration: a signed expense with amount = -abs(amount)
    and the ``kind`` field dropped. Returns a shallow copy; never mutates the input."""
    out = {k: v for k, v in row.items() if k != "kind"}
    out["amount"] = -abs(row["amount"])
    return out


def _is_income(e: dict) -> bool:
    return e.get("kind") == "income"


def simulate_trip(members: list, expenses: list, settlements: list) -> dict:
    """Before/after balance simulation for ONE trip.

    before = current behaviour (income rows EXCLUDED from the ledger).
    after  = signed model (income rows included as negative expenses).

    Returns a dict with the income rows, both net maps, the per-member deltas (only members whose
    rounded net changes), and whether the trip's settled-overall status flips. A trip with no income
    rows yields no deltas (``changed`` False) — provably unaffected.
    """
    income_rows = [e for e in expenses if _is_income(e)]
    expense_rows = [e for e in expenses if not _is_income(e)]
    before = compute_net(members, expense_rows, settlements)
    after_rows = expense_rows + [to_negative_expense(e) for e in income_rows]
    after = compute_net(members, after_rows, settlements)

    deltas = {
        mid: {"before": before.get(mid, 0.0), "after": after.get(mid, 0.0)}
        for mid in before
        if round(after.get(mid, 0.0) - before.get(mid, 0.0), 2) != 0.0
    }
    before_settled = all(is_settled(v) for v in before.values())
    after_settled = all(is_settled(v) for v in after.values())
    return {
        "income_rows": income_rows,
        "before": before,
        "after": after,
        "deltas": deltas,
        "changed": bool(income_rows) and bool(deltas),
        "settled_before": before_settled,
        "settled_after": after_settled,
        "settled_flips": before_settled != after_settled,
    }
