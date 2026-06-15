"""Step 9 — Synchronize XLSX Export Report.

Pure helpers that re-derive each expense's per-member allocation for the XLSX export, using the SAME
calculator functions the ledger uses (`services.calculator`) so the report can never drift from
`utils.balances._compute_balances`.

This module is intentionally pure (plain dicts/lists, no `async`, no `database`/`routes`/`utils`/
FastAPI/Motor imports — only `services.calculator`) so it is unit-testable exactly like
`test_per_capita.py` / `test_per_family.py`. Rounding here touches ONLY the displayed cells; these
builders never compute `net`, so they add no rounding to the settlement path.
"""

from services.calculator import resolve_weights, split_per_capita, split_per_family


def build_member_weight_map(members: list) -> dict:
    """member_id -> base human count (individual = 1, family = max(1, len(family_members))).

    Local mirror of `utils.balances._weight_of_member` / `weight_map`; duplicated deliberately to keep
    this service pure (no import of the route/util layer).
    """
    out = {}
    for m in members:
        if m.get("kind") == "family":
            out[m["id"]] = max(1, len(m.get("family_members", [])))
        else:
            out[m["id"]] = 1
    return out


def _names(members: list) -> dict:
    """member_id -> display name; unknown ids resolve to '?' at lookup time."""
    return {m["id"]: m.get("name", "?") for m in members}


def _all_ids(members: list) -> list:
    return [m["id"] for m in members]


def build_per_capita_rows(expenses: list, members: list) -> list:
    """One row per participating member for every PER_CAPITA expense (Section 5A).

    Shows H (total humans = sum of effective weights), per-person cost, each member's weight, and that
    member's share. Honors `weight_snapshots` via `resolve_weights` (partial-family overrides and the
    Step-8 size-freeze pins), identical to the ledger. Income rows are excluded.
    """
    weight_map = build_member_weight_map(members)
    names = _names(members)
    all_ids = _all_ids(members)
    rows: list = []
    for e in expenses:
        if e.get("kind", "expense") != "expense":
            continue
        if (e.get("split_mode") or "PER_CAPITA") != "PER_CAPITA":
            continue
        split_ids = e.get("split_member_ids") or all_ids
        weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"))
        shares = split_per_capita(e["amount"], weights)
        if not shares:
            continue  # H <= 0; nothing to split (matches _compute_balances)
        total_humans = sum(weights.values())
        per_human = e["amount"] / total_humans
        for mid, share in shares.items():
            rows.append({
                "date": e.get("date", ""),
                "category": e.get("category", ""),
                "description": e.get("description", ""),
                "amount": e["amount"],
                "total_humans": total_humans,
                "per_human": round(per_human, 2),
                "member_name": names.get(mid, "?"),
                "member_weight": weights[mid],
                "member_share": round(share, 2),
            })
    return rows


def build_per_family_rows(expenses: list, members: list) -> list:
    """One row per distinct entity for every PER_FAMILY expense (Section 5B).

    Shows E (total entities) and the flat per-entity cost — every selected family/individual owes
    `amount / E` regardless of family size. Size and `weight_snapshots` are intentionally ignored.
    Income rows are excluded.
    """
    names = _names(members)
    all_ids = _all_ids(members)
    rows: list = []
    for e in expenses:
        if e.get("kind", "expense") != "expense":
            continue
        if (e.get("split_mode") or "PER_CAPITA") != "PER_FAMILY":
            continue
        split_ids = e.get("split_member_ids") or all_ids
        shares = split_per_family(e["amount"], split_ids)
        if not shares:
            continue  # E <= 0; nothing to split
        total_entities = len(shares)  # split_per_family de-dupes; len == distinct entities
        per_entity = e["amount"] / total_entities
        for mid, share in shares.items():
            rows.append({
                "date": e.get("date", ""),
                "category": e.get("category", ""),
                "description": e.get("description", ""),
                "amount": e["amount"],
                "total_entities": total_entities,
                "per_entity": round(per_entity, 2),
                "member_name": names.get(mid, "?"),
                "member_share": round(share, 2),
            })
    return rows


def build_transaction_rows(expenses: list, members: list) -> list:
    """One row per expense (both kinds), with the existing columns plus `split_mode`.

    Preserves the existing Transactions-sheet semantics: `split_among` joins the participant names in
    `split_member_ids` order (empty when split-among-all). Unknown ids resolve to '?'.
    """
    names = _names(members)
    rows: list = []
    for e in expenses:
        paid_by = names.get(e.get("paid_by_member_id"), "?")
        split_among = ", ".join(names.get(sid, "?") for sid in e.get("split_member_ids", []))
        rows.append({
            "date": e.get("date", ""),
            "kind": e.get("kind", "expense"),
            "category": e.get("category", ""),
            "description": e.get("description", ""),
            "amount": e["amount"],
            "paid_by": paid_by,
            "split_among": split_among,
            "split_mode": e.get("split_mode", "PER_CAPITA"),
        })
    return rows
