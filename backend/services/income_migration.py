"""Pure helpers for the one-time income -> negative-expense migration (signed-amount model).

No DB / FastAPI imports — only ``services.calculator`` + ``utils.settlement_gate`` — so the
before/after balance simulation that drives the migration's read-only dry-run can be unit-tested in
isolation and can never silently diverge from the real ledger.

The migration removes the separate ``kind:"income"`` concept: an income row becomes a normal expense
with a NEGATIVE amount (money coming back to the group). Income rows were excluded from balances
before, so converting them DOES change historical balances for income-containing trips — these helpers
compute exactly which trips/members change so a human can sign off before any write.
"""

from services.calculator import resolve_weights, split_per_capita, split_per_family
from utils.settlement_gate import is_settled


def _weight_of_member(m: dict) -> int:
    if m.get("kind") == "family":
        return max(1, len(m.get("family_members", [])))
    return 1


def compute_net(members: list, expenses: list, settlements: list) -> dict:
    """member_id -> rounded net. Faithful replica of ``utils.balances._compute_balances`` net loop:
    signed amounts, PER_CAPITA via resolve_weights+split_per_capita / PER_FAMILY via split_per_family,
    then settlements, then a single round(2). Every row passed in is treated as a signed expense (no
    ``kind`` filtering happens here — the caller decides which rows to include)."""
    net = {m["id"]: 0.0 for m in members}
    weight_map = {m["id"]: _weight_of_member(m) for m in members}
    all_ids = [m["id"] for m in members]
    for e in expenses:
        split_ids = e.get("split_member_ids") or all_ids
        mode = e.get("split_mode", "PER_CAPITA")
        if mode == "PER_CAPITA":
            weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"))
            shares = split_per_capita(e["amount"], weights)
        else:
            shares = split_per_family(e["amount"], split_ids)
        if not shares:
            continue
        for sid, share in shares.items():
            net[sid] = net.get(sid, 0) - share
        net[e["paid_by_member_id"]] = net.get(e["paid_by_member_id"], 0) + e["amount"]
    for s in settlements:
        net[s["from_member_id"]] = net.get(s["from_member_id"], 0) + s["amount"]
        net[s["to_member_id"]] = net.get(s["to_member_id"], 0) - s["amount"]
    return {k: round(v, 2) for k, v in net.items()}


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
