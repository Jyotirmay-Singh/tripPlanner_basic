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

from services.calculator import (
    allocate_within_family,
    resolve_weights,
    split_per_capita,
    split_per_family,
)
from services.expense_shares import entity_shares_raw
from services.member_breakdown import family_member_ids
from services.spend_summary import aggregate_spend
from utils.display_names import family_member_display_names, member_display_names


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


# ---------- Phase 16: report restructure (concise, professional, CA-reviewable) ----------
# Everything below is additive and PURE (plain dicts/lists). It only RESHAPES the engine's outputs
# for the workbook — no new split/balance math. It reuses the SAME helpers the ledger uses
# (`services.expense_shares.entity_shares_raw`, `services.spend_summary.aggregate_spend`, and the
# `build_*_rows` builders above), so every displayed figure can never drift from
# `utils.balances._compute_balances`.

_MODE_LABELS = {"PER_CAPITA": "Per-Person", "PER_FAMILY": "Per-Family"}


def mode_label(mode) -> str:
    """Split-mode label for display: 'PER_CAPITA' -> 'Per-Person', 'PER_FAMILY' -> 'Per-Family'.
    Unknown/blank defaults to 'Per-Person' (the ledger's PER_CAPITA default)."""
    return _MODE_LABELS.get(mode or "PER_CAPITA", "Per-Person")


def trip_composition(members: list) -> tuple:
    """(individuals, families, singles) — backend mirror of frontend ``composition.ts::tripComposition``.
    A family contributes max(1, roster size) humans and one family; an individual one human + one single.
    """
    individuals = families = singles = 0
    for m in members or []:
        if not m:
            continue
        if m.get("kind") == "family":
            families += 1
            individuals += max(1, len(m.get("family_members") or []))
        else:
            singles += 1
            individuals += 1
    return individuals, families, singles


def composition_label(members: list) -> str:
    """'X Individuals across Y Families & Z Singles' — mirror of ``composition.ts::compositionLabel``
    (omits empty segments; with no families shows just the human count)."""
    individuals, families, singles = trip_composition(members)

    def plural(n, one, many):
        return f"{n} {one if n == 1 else many}"

    if families == 0:
        return plural(individuals, "Individual", "Individuals")
    parts = [plural(families, "Family", "Families")]
    if singles > 0:
        parts.append(plural(singles, "Single", "Singles"))
    return f"{plural(individuals, 'Individual', 'Individuals')} across {' & '.join(parts)}"


def entity_ledger_components(expenses: list, members: list) -> tuple:
    """(paid, share) maps keyed by member id, accumulated EXACTLY as ``_compute_balances`` does.

    For each expense the ledger skips rows that split to nothing (H<=0 / E<=0); ``entity_shares_raw``
    returns ``{}`` for exactly those, so we skip crediting the payer too — keeping these maps in
    lockstep with the ledger. ``paid`` is the SIGNED amount fronted (a money-back row reduces it);
    ``share`` is the sum of each entity's allocations (the quantity the ledger subtracts from net).
    Both are UNROUNDED (callers round for display). By construction, per entity::

        net (from _compute_balances) == paid - share + settlement_adjustment.
    """
    paid = {m["id"]: 0.0 for m in members}
    share = {m["id"]: 0.0 for m in members}
    for e in expenses:
        raw = entity_shares_raw(e, members)
        if not raw:
            continue  # H<=0 / E<=0: the ledger skips this row (no payer credit, no shares)
        pid = e.get("paid_by_member_id")
        if pid in paid:
            paid[pid] += e.get("amount", 0.0)
        for eid, sh in raw.items():
            if eid in share:
                share[eid] += sh
    return paid, share


def settle_adj_by_entity(settlements: list) -> dict:
    """member id -> settlement adjustment (Σ amount paid OUT − Σ amount received), the SAME overlay
    ``_compute_balances`` applies (``net[from] += amount``, ``net[to] -= amount``). Pass the
    non-pending settlement rows only (the set the ledger overlays)."""
    out: dict = {}
    for s in settlements or []:
        amt = s.get("amount", 0.0)
        f = s.get("from_member_id")
        t = s.get("to_member_id")
        if f is not None:
            out[f] = out.get(f, 0.0) + amt
        if t is not None:
            out[t] = out.get(t, 0.0) - amt
    return out


def build_summary_spend_rows(members: list, expenses: list) -> dict:
    """'Spend by entity' table for the Summary tab: gross amount PAID per entity, DESCENDING.

    Wraps ``services.spend_summary.aggregate_spend`` (positive-only gross — the same figure the in-app
    SpendBarChart shows), relabeled with disambiguated display names. Ties broken by name for a stable
    order. Returns ``{"rows": [{"name","type","paid"}...], "total": <Σ rounded paids>}``.
    """
    agg = aggregate_spend(members, expenses)
    names = _names(members)
    rows = [
        {"name": names.get(en["entity_id"], en.get("name", "?")),
         "type": "Family" if en["entity_type"] == "family" else "Individual",
         "paid": en["paid"]}
        for en in agg["entities"]
    ]
    rows.sort(key=lambda r: (-r["paid"], r["name"]))
    return {"rows": rows, "total": agg["total"]}


def build_members_families_rows(per_person: list, paid: dict, settle: dict, display: dict) -> list:
    """Hierarchical 'Members & Families' rows: each family as a subtotal with its member rows beneath,
    then standalone individuals, then a grand TOTAL.

    Money is presented so every entity row reconciles EXACTLY: ``Net = Paid - Share + Settlements``.
    Paid & Settlements are exact 2dp sums and Net is the authoritative post-settlement ledger figure
    (the in-app +/-); Share is shown as ``Paid + Settlements - Net``, which is ALGEBRAICALLY the
    engine's own Σ share (``net == paid - share + settle`` ⇒ ``share == paid + settle - net``) — so it
    equals the independently-summed allocation (``entity_ledger_components``'s ``share``, cross-checked
    in tests) yet foots to the cent on every row and column (Σ Paid = Σ Share = grand total;
    Σ Settlements = Σ Net = 0). Family-member rows carry only Net (the post-settlement chronological
    breakdown from ``_compute_balances``, which sums to the family's Net); they are sub-rows EXCLUDED
    from the TOTAL (no double count).

    ``per_person`` is ``bal["per_person"]``; ``paid``/``settle`` are the unrounded maps from
    ``entity_ledger_components`` / ``settle_adj_by_entity``; ``display`` is member id -> label.
    """
    fams = [pp for pp in per_person if pp["kind"] == "family"]
    inds = [pp for pp in per_person if pp["kind"] != "family"]
    rows: list = []
    tot_paid = tot_share = tot_settle = tot_net = 0.0

    def entity_money(mid, net_total):
        paid_d = round(paid.get(mid, 0.0), 2)
        settle_d = round(settle.get(mid, 0.0), 2)
        net_d = round(net_total, 2)
        # Share as the engine identity Paid + Settlements - Net (== Σ share). All operands are 2dp,
        # so the row foots exactly: paid_d - share_d + settle_d == net_d.
        share_d = round(paid_d + settle_d - net_d, 2)
        return paid_d, share_d, settle_d, net_d

    for pp in fams:
        mid = pp["member_id"]
        label = display.get(mid, pp["member_name"])
        paid_d, share_d, settle_d, net_d = entity_money(mid, pp["net_total"])
        rows.append({"kind": "family_subtotal", "name": label, "type": "Family", "family": "",
                     "paid": paid_d, "share": share_d, "settle": settle_d, "net": net_d})
        tot_paid += paid_d
        tot_share += share_d
        tot_settle += settle_d
        tot_net += net_d
        for mrow in pp.get("members", []):
            rows.append({"kind": "family_member", "name": mrow["name"], "type": "Family member",
                         "family": label, "paid": None, "share": None, "settle": None,
                         "net": round(mrow["net"], 2)})

    for pp in inds:
        mid = pp["member_id"]
        label = display.get(mid, pp["member_name"])
        paid_d, share_d, settle_d, net_d = entity_money(mid, pp["net_total"])
        rows.append({"kind": "individual", "name": label, "type": "Individual", "family": "",
                     "paid": paid_d, "share": share_d, "settle": settle_d, "net": net_d})
        tot_paid += paid_d
        tot_share += share_d
        tot_settle += settle_d
        tot_net += net_d

    rows.append({"kind": "total", "name": "TOTAL", "type": "", "family": "",
                 "paid": round(tot_paid, 2), "share": round(tot_share, 2),
                 "settle": round(tot_settle, 2), "net": round(tot_net, 2)})
    return rows


def build_split_math_rows(expenses: list, members: list) -> list:
    """Flagship 'Split Math' blocks — one block per expense (date order), reusing the existing
    calculator-faithful builders so allocations can never drift from the ledger.

    Each block::

        {expense, date, category, amount, mode, divisor,
         participants: [{participant, ptype, units, per_unit, allocated}, ...],
         subtotal_units, subtotal_allocated}

    Per-Person reuses ``build_per_capita_rows`` (``units`` = involved-human weight, ``per_unit`` =
    amount / total involved humans); Per-Family reuses ``build_per_family_rows`` (``units`` = 1,
    ``per_unit`` = amount / total entities). ``allocated = units × per_unit``, and Σ allocated ==
    amount, Σ units == divisor. An expense that splits to nothing (H<=0 / E<=0) is skipped, exactly
    like the ledger.
    """
    names = _names(members)
    kind_by_label = {names[m["id"]]: ("Family" if m.get("kind") == "family" else "Individual")
                     for m in members}
    sorted_expenses = sorted(expenses, key=lambda x: x.get("date", ""))
    blocks: list = []
    for e in sorted_expenses:
        mode = e.get("split_mode") or "PER_CAPITA"
        if mode == "PER_FAMILY":
            prows = build_per_family_rows([e], members)
            parts = [{"participant": r["member_name"],
                      "ptype": kind_by_label.get(r["member_name"], "Individual"),
                      "units": 1, "per_unit": r["per_entity"], "allocated": r["member_share"]}
                     for r in prows]
            divisor = prows[0]["total_entities"] if prows else 0
        else:
            prows = build_per_capita_rows([e], members)
            parts = [{"participant": r["member_name"],
                      "ptype": kind_by_label.get(r["member_name"], "Individual"),
                      "units": r["member_weight"], "per_unit": r["per_human"],
                      "allocated": r["member_share"]}
                     for r in prows]
            divisor = prows[0]["total_humans"] if prows else 0
        if not parts:
            continue  # H<=0 / E<=0: skipped, exactly like the ledger
        blocks.append({
            "expense": e.get("description", "") or e.get("category", ""),
            "date": _date_cell(e),
            "category": e.get("category", ""),
            "amount": e.get("amount", 0.0),
            "mode": mode_label(mode),
            "divisor": divisor,
            "participants": parts,
            "subtotal_units": sum(p["units"] for p in parts),
            "subtotal_allocated": round(sum(p["allocated"] for p in parts), 2),
        })
    return blocks


# ---------- Phase 18: exploded per-member Transactions tab + pivot ----------
# Additive and PURE. Explodes each expense into ONE ROW PER TRIP MEMBER (individuals + every family
# member), showing that member's share of that expense ("Total Payable"). It composes the SAME two
# engine helpers the ledger/Expenses-tab breakdown use — ``expense_shares.entity_shares_raw`` (the
# exact per-entity split ``_compute_balances`` computes) and ``calculator.allocate_within_family``
# (the intra-family division; involved-only in PER_CAPITA, all members in PER_FAMILY) — so no split
# math is reimplemented here. Rounding is DISPLAY-only and NAIVE (each member's share rounded
# independently to 2dp, matching the hand-built oracle, e.g. a -600/7 refund shows -85.71 for all 7);
# it never feeds ``net``/settlements. Total Payable is the GROSS per-expense share, so settlements are
# irrelevant to this tab.


def build_expense_member_rows(expenses: list, members: list) -> dict:
    """Exploded expense→member rows + a per-person pivot for the Transactions tab.

    Returns::

        {
          "blocks": [ {"sr_no", "category", "description", "date", "amount" (signed),
                       "mode" (label), "paid_by" (entity label),
                       "rows": [{"family", "person", "payable", "participates"}, ...],
                       "block_payable"}, ... ],
          "pivot":  {"rows": [{"name", "total"}, ... alphabetical], "grand_total"},
          "grand_amount":  Σ round(amount, 2) over non-skipped expenses,
          "grand_payable": Σ every row's payable (== pivot.grand_total),
        }

    Expenses are taken in the same date order as the other tabs and given a sequential ``sr_no``; an
    expense that splits to nothing (H<=0 / E<=0 → ``entity_shares_raw`` returns ``{}``) is skipped,
    exactly like the ledger. Member rows are emitted by iterating ``members`` in array order (families
    expand over their roster; individuals are one row), so the person order is identical in every
    block. A member with a 0.00 share (excluded from the split / not participating) has
    ``participates=False`` → renderers show ``"-"``. Family member shares come from
    ``allocate_within_family`` on the family's entity share (excluded members → 0.0); individuals take
    their own entity share. Each share is rounded once for display (naive), so per-block sums may drift
    a few cents in the general case (they cancel to the grand total for the reference dataset).
    """
    names = _names(members)
    # roster (id, display-name) pairs per family, parallel to ``family_members``.
    fam_roster = {
        m["id"]: list(zip(family_member_ids(m), family_member_display_names(m)))
        for m in members if m.get("kind") == "family"
    }
    sorted_expenses = sorted(expenses, key=lambda x: x.get("date", ""))
    blocks: list = []
    pivot: dict = {}  # person id -> {"name", "total"}
    grand_amount = 0.0
    grand_payable = 0.0
    sr = 0

    def _add_pivot(pid, pname, share):
        cell = pivot.setdefault(pid, {"name": pname, "total": 0.0})
        cell["total"] += share

    for e in sorted_expenses:
        raw = entity_shares_raw(e, members)
        if not raw:
            continue  # H<=0 / E<=0: the ledger skips this expense, so do we
        sr += 1
        amount = e.get("amount", 0.0)
        fam_participants = e.get("family_participants") or {}
        rows: list = []
        block_payable = 0.0
        for m in members:
            mid = m["id"]
            if m.get("kind") == "family":
                fam_label = names.get(mid, "?")
                roster = fam_roster.get(mid, [])
                roster_ids = [rid for rid, _ in roster]
                # Divide THIS family's entity share among its members (0.0 when the family is not in
                # the split); PER_CAPITA excludes non-participants, PER_FAMILY splits over all members.
                alloc = allocate_within_family(raw.get(mid, 0.0), fam_participants.get(mid), roster_ids)
                for rid, rname in roster:
                    share = round(alloc.get(rid, 0.0), 2)
                    rows.append({"family": fam_label, "person": rname,
                                 "payable": share, "participates": share != 0.0})
                    block_payable += share
                    _add_pivot(rid, rname, share)
            else:
                label = names.get(mid, "?")
                share = round(raw.get(mid, 0.0), 2)
                rows.append({"family": label, "person": label,
                             "payable": share, "participates": share != 0.0})
                block_payable += share
                _add_pivot(mid, label, share)
        block_payable = round(block_payable, 2)
        blocks.append({
            "sr_no": sr,
            "category": e.get("category", ""),
            "description": e.get("description", ""),
            "date": _date_cell(e),
            "amount": amount,
            "mode": mode_label(e.get("split_mode")),
            "paid_by": names.get(e.get("paid_by_member_id"), "?"),
            "rows": rows,
            "block_payable": block_payable,
        })
        grand_amount += round(amount, 2)
        grand_payable += block_payable

    pivot_rows = sorted(
        ({"name": v["name"], "total": round(v["total"], 2)} for v in pivot.values()),
        key=lambda r: r["name"],
    )
    grand_total = round(sum(r["total"] for r in pivot_rows), 2)
    return {
        "blocks": blocks,
        "pivot": {"rows": pivot_rows, "grand_total": grand_total},
        "grand_amount": round(grand_amount, 2),
        "grand_payable": round(grand_payable, 2),
    }
