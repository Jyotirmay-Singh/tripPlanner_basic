"""Step 9 — Synchronize XLSX Export Report.

Pure helpers that re-derive each expense's per-member allocation for the XLSX export, using the SAME
calculator functions the ledger uses (`services.calculator`) so the report can never drift from
`utils.balances._compute_balances`.

This module is intentionally pure (plain dicts/lists, no `async`, no `database`/`routes`/
FastAPI/Motor imports — only `services.calculator` and the pure `utils.display_names`) so it is
unit-testable exactly like `test_per_capita.py` / `test_per_family.py`. Rounding here touches ONLY
the displayed cells; these builders never compute `net`, so they add no rounding to the settlement
path.
"""

from services.calculator import resolve_weights, split_per_capita, split_per_family
from services.member_breakdown import family_member_ids
from utils.display_names import member_display_names


def _to_12h(value) -> str:
    """'14:30' -> '2:30 PM'; blank/invalid -> ''. Inlined here (no datetime needed) to keep this
    module pure (it must import only `services.calculator`, never `utils`)."""
    if not value or not isinstance(value, str):
        return ""
    parts = value.strip().split(":")
    if len(parts) != 2 or not (parts[0].isdigit() and parts[1].isdigit()):
        return ""
    h, m = int(parts[0]), int(parts[1])
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return ""
    suffix = "AM" if h < 12 else "PM"
    h12 = h % 12 or 12
    return f"{h12}:{m:02d} {suffix}"


def _date_cell(e: dict) -> str:
    """Date cell for the report: the bare date when there's no time (unchanged for legacy rows),
    or '<date> · <12h time>' when an optional time is present."""
    date = e.get("date", "")
    t = _to_12h(e.get("time"))
    return f"{date} · {t}" if t else date


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
    """member_id -> disambiguated display name; unknown ids resolve to '?' at lookup time.

    Routes through `utils.display_names.member_display_names` so duplicate member names show the same
    `name_1` / `name_2` labels here as on every app screen (single source of truth)."""
    return member_display_names(members)


def _all_ids(members: list) -> list:
    return [m["id"] for m in members]


def build_per_capita_rows(expenses: list, members: list) -> list:
    """One row per participating member for every PER_CAPITA expense (Section 5A).

    Shows H (total humans = sum of effective weights), per-person cost, each member's weight, and that
    member's share. Honors `weight_snapshots` via `resolve_weights` (partial-family overrides and the
    Step-8 size-freeze pins), identical to the ledger. A negative `amount` (money back) yields the
    mirrored negative shares.
    """
    weight_map = build_member_weight_map(members)
    names = _names(members)
    all_ids = _all_ids(members)
    # A PER_CAPITA family restricted to a subset of its roster (via `family_participants`) counts as
    # its INVOLVED-member count (CLAUDE.md §5-A), identical to the ledger, so the exported H /
    # per-person / family share never drift from the app's Balances.
    rosters = {m["id"]: family_member_ids(m) for m in members if m.get("kind") == "family"}
    rows: list = []
    for e in expenses:
        if (e.get("split_mode") or "PER_CAPITA") != "PER_CAPITA":
            continue
        split_ids = e.get("split_member_ids") or all_ids
        weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"),
                                  e.get("family_participants"), rosters)
        shares = split_per_capita(e["amount"], weights)
        if not shares:
            continue  # H <= 0; nothing to split (matches _compute_balances)
        total_humans = sum(weights.values())
        per_human = e["amount"] / total_humans
        for mid, share in shares.items():
            rows.append({
                "date": _date_cell(e),
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
    A negative `amount` (money back) yields the mirrored negative shares.
    """
    names = _names(members)
    all_ids = _all_ids(members)
    rows: list = []
    for e in expenses:
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
                "date": _date_cell(e),
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
    """One row per expense, with the existing columns plus `split_mode`.

    Preserves the existing Transactions-sheet semantics: `split_among` joins the participant names in
    `split_member_ids` order (empty when split-among-all). Unknown ids resolve to '?'. A negative
    `amount` simply carries its sign through to the Amount cell.
    """
    names = _names(members)
    rows: list = []
    for e in expenses:
        paid_by = names.get(e.get("paid_by_member_id"), "?")
        split_among = ", ".join(names.get(sid, "?") for sid in e.get("split_member_ids", []))
        rows.append({
            "date": _date_cell(e),
            "category": e.get("category", ""),
            "description": e.get("description", ""),
            "amount": e["amount"],
            "paid_by": paid_by,
            "split_among": split_among,
            "split_mode": e.get("split_mode", "PER_CAPITA"),
        })
    return rows
