"""Per-expense participant share breakdown — DISPLAY-only, ledger-neutral.

Pure helper (plain dicts/lists; imports only ``services.calculator``, the pure
``services.member_breakdown.family_member_ids`` helper, and ``utils.display_names`` — mirroring
``services/report_builder.py`` and ``services/member_breakdown.py``) that re-derives, for a SINGLE
expense, how its amount is split across the participating entities (and, for families, among the
participating members), using the SAME calculator functions the ledger uses
(``services.calculator``) so the displayed breakdown can never drift from
``utils.balances._compute_balances``.

This module never computes ``net``, never touches settlements/transfers/CRUD, and never persists
anything: the ``shares`` payload is derived at read-time on the expense-list endpoint. Rounding here
touches ONLY the displayed numbers (largest-remainder apportionment so the shown 2dp values sum
EXACTLY to the rounded amount, and each family's member sub-shares sum EXACTLY to that family's shown
entity share), exactly like the Balances intra-family breakdown — it adds no rounding to the
settlement path.

``income`` rows are processed too (the entity split is computed the same way) purely for display; the
ledger ignores income, so the frontend labels income shares as "received / share" with a
"doesn't affect balances" note. Only ``shares`` (a new key) is added to the list response — no
existing field is changed.
"""

import math

from services.calculator import (
    allocate_within_family,
    resolve_weights,
    split_per_capita,
    split_per_family,
)
from services.member_breakdown import family_member_ids
from utils.display_names import family_member_display_names, member_display_names


def _weight_map(members: list) -> dict:
    """member_id -> base human count (individual = 1, family = max(1, len(family_members))).

    Local mirror of ``utils.balances._weight_of_member`` (also duplicated in ``report_builder`` /
    ``member_breakdown``); kept local so this service stays pure (no route/util-layer import).
    """
    out = {}
    for m in members:
        if m.get("kind") == "family":
            out[m["id"]] = max(1, len(m.get("family_members", [])))
        else:
            out[m["id"]] = 1
    return out


def _apportion(raw: dict, order: list, target: float) -> dict:
    """Largest-remainder apportionment in cents so the 2dp results sum EXACTLY to round(target, 2).

    Mirror of ``services.member_breakdown._apportion`` (duplicated to keep this module self-contained,
    matching the codebase's deliberate-duplication-for-purity pattern). Deterministic: ties broken by
    ``order``. Handles negatives (floor toward -inf) though this feature only feeds positive shares.
    """
    target_c = round(target * 100)
    base = {}
    rem = {}
    for k in order:
        vc = raw[k] * 100
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


def entity_shares_raw(expense: dict, members: list) -> dict:
    """Exact per-entity share for ONE expense — byte-identical to what the ledger allocates.

    Uses the SAME calculator call ``_compute_balances`` uses for this expense: PER_CAPITA divides the
    amount across total humans (honoring ``weight_snapshots`` via ``resolve_weights``); PER_FAMILY
    divides flat per entity (size/snapshots ignored). No rounding (sum == amount within float
    epsilon). Returns ``{}`` when there is nothing to split (H<=0 / E<=0), exactly like the ledger,
    which skips such an expense.
    """
    all_ids = [m["id"] for m in members]
    split_ids = expense.get("split_member_ids") or all_ids
    mode = expense.get("split_mode") or "PER_CAPITA"
    amount = expense.get("amount", 0.0)
    if mode == "PER_CAPITA":
        weights = resolve_weights(split_ids, _weight_map(members), expense.get("weight_snapshots"))
        return split_per_capita(amount, weights)
    return split_per_family(amount, split_ids)


def expense_share_breakdown(expense: dict, members: list) -> dict:
    """DISPLAY breakdown of one expense for the Expenses tab (both ``expense`` and ``income`` kinds).

    Shape::

        {
          "mode": "PER_CAPITA" | "PER_FAMILY",
          "kind": "expense" | "income",
          "payer_id": <member id who fronted / received the money>,
          "amount": <expense amount>,
          "entities": [
            {"id", "name", "share", "is_payer",      # entity's owed/received share, 2dp
             "members": [{"id","name","share"}, ...]} # families only; [] for individuals
          ],
        }

    ``share`` values are the calculator allocation rounded for display via a largest-remainder pass so
    the shown entity shares sum EXACTLY to round(amount, 2), and each family's member sub-shares sum
    EXACTLY to that family's shown entity share. Members excluded by ``family_participants`` show
    exactly 0.0. Nothing here feeds the ledger.
    """
    members_by_id = {m["id"]: m for m in members}
    names = member_display_names(members)
    raw = entity_shares_raw(expense, members)
    out = {
        "mode": expense.get("split_mode") or "PER_CAPITA",
        "kind": expense.get("kind", "expense"),
        "payer_id": expense.get("paid_by_member_id"),
        "amount": expense.get("amount", 0.0),
        "entities": [],
    }
    if not raw:
        return out

    order = list(raw.keys())
    shown = _apportion(raw, order, out["amount"])  # entity shares sum EXACTLY to round(amount, 2)
    fam_participants = expense.get("family_participants") or {}

    for eid in order:
        m = members_by_id.get(eid)
        entity = {
            "id": eid,
            "name": names.get(eid, "?"),
            "share": shown[eid],
            "is_payer": eid == out["payer_id"],
            "members": [],
        }
        if m and m.get("kind") == "family":
            ids = family_member_ids(m)
            if ids:
                fnames = family_member_display_names(m)
                # Split THIS family's shown entity share among its participating members (excluded ->
                # 0). Apportion over ONLY the participants so the rounding can never bump an excluded
                # member above 0; participant sub-shares sum EXACTLY to the family's shown share.
                alloc = allocate_within_family(shown[eid], fam_participants.get(eid), ids)
                parts = [mid for mid in ids if alloc[mid] != 0.0]
                sub = _apportion({mid: alloc[mid] for mid in parts}, parts, shown[eid]) if parts else {}
                entity["members"] = [
                    {"id": ids[i], "name": fnames[i], "share": sub.get(ids[i], 0.0)}
                    for i in range(len(ids))
                ]
        out["entities"].append(entity)
    return out
