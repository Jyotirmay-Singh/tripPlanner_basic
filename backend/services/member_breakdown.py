"""Per-member intra-family balance breakdown — divides each family's already-computed ledger ``net``
among its OWN members. This module never mutates ``net``: it only decides each family's INTERNAL
division (the family total, trip headcount, transfers, and every other entity are decided upstream in
``utils.balances._compute_balances`` and passed in unchanged).

Pure helper (plain dicts/lists; imports only ``services.calculator`` + ``utils.display_names``,
mirroring ``services/report_builder.py``).

Two paths, chosen per family:
  * **No participation restriction on any expense** -> every member's share is exactly
    ``round(net / size, 2)``, byte-identical to the legacy uniform ``net_per_person`` shown for each
    roster member.
  * **>=1 expense restricts participation** -> the family's post-(non-pending)-settlement ``net`` is
    distributed across members PROPORTIONALLY to each member's gross consumption (sum of allocated
    shares over positive-amount expenses) via ``distribute_by_consumption``: members who consumed more
    of the family's cost carry more of the outstanding remainder; excluded-everywhere members get 0;
    equal consumption reduces to the even split; a zero basis falls back to an even split among
    participants. A deterministic largest-remainder pass makes the rounded member shares sum EXACTLY
    to the family's rounded ledger net. (This replaced an older owed+credit decomposition that could
    show huge opposite per-member values that merely summed to a small net.)

Note on participation and the family TOTAL: in **PER_CAPITA**, ``family_participants`` reduces a
family's involved headcount, so its entity total is already smaller upstream (CLAUDE.md §5-A); in
**PER_FAMILY** the family's flat per-entity total is unchanged and only its internal division honors
participation. Either way this module distributes whatever ``net`` it is given.
"""

import math

from services.calculator import (
    allocate_within_family,
    distribute_by_consumption,
    resolve_weights,
    split_per_capita,
    split_per_family,
)
from utils.display_names import family_member_display_names


def family_member_ids(family: dict) -> list:
    """Stable member ids parallel to ``family_members``. Pads with synthetic index-based ids for
    legacy rows not yet backfilled (those rows never carry ``family_participants``, so they stay on
    the no-restriction / uniform path and remain byte-identical)."""
    names = family.get("family_members", []) or []
    ids = [str(x) for x in (family.get("family_member_ids") or [])]
    if len(ids) < len(names):
        fid = family.get("id", "")
        ids = ids + [f"{fid}:{i}" for i in range(len(ids), len(names))]
    return ids[: len(names)] if names else []


def _apportion(raw: dict, order: list, target: float) -> dict:
    """Largest-remainder apportionment in cents so the 2dp results sum EXACTLY to round(target, 2).

    Works for negative values (floor toward -inf). Deterministic: ties broken by ``order``.
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


def _weight_map(members: list) -> dict:
    out = {}
    for m in members:
        if m.get("kind") == "family":
            out[m["id"]] = max(1, len(m.get("family_members", [])))
        else:
            out[m["id"]] = 1
    return out


def family_member_breakdown(members: list, expenses: list, settlements: list, net: dict) -> dict:
    """family entity id -> [{"id", "name", "net"}] (one row per roster member, in roster order).

    ``expenses``/``net`` must be the same data ``_compute_balances`` used (all of the trip's expense
    rows, signed; ``net`` already post-(non-pending)-settlement), so the no-restriction path
    reproduces ``net_per_person`` exactly. The restricted path distributes the family's
    post-settlement net across members PROPORTIONALLY to each member's gross consumption (see
    ``distribute_by_consumption``), summing EXACTLY to that net.

    ``settlements`` is retained for signature stability but no longer drives the math: the family's
    net (which already encodes every non-pending settlement) is the single source the breakdown
    distributes, which is precisely what keeps the per-member rows from diverging from the aggregate.
    """
    weight_map = _weight_map(members)
    all_ids = [m["id"] for m in members]
    # Stable roster ids per family, so a PER_CAPITA family restricted to a subset of its roster counts
    # as its INVOLVED-member count (CLAUDE.md §5-A) when its share is sized — identical to the ledger.
    rosters = {m["id"]: family_member_ids(m) for m in members if m.get("kind") == "family"}
    out: dict = {}

    for fam in members:
        if fam.get("kind") != "family":
            continue
        fid = fam["id"]
        names = family_member_display_names(fam)  # parallel to family_members (by index)
        ids = family_member_ids(fam)               # parallel ids
        size = max(1, len(fam.get("family_members", [])))
        if not ids:
            out[fid] = []
            continue
        id_set = set(ids)

        # Each member's GROSS cost (consumption) — the proportional basis for the family's
        # post-settlement net. Built from positive-amount expenses only (refunds reduce the net, not
        # the consumption basis). `participated` is every member who took part in >=1 expense, so the
        # even-split fallback (zero basis) never credits an excluded-everywhere member.
        consumption = {mid: 0.0 for mid in ids}
        participated: set = set()
        restricted = False

        for e in expenses:
            split_ids = e.get("split_member_ids") or all_ids
            if fid not in split_ids:
                continue
            mode = e.get("split_mode") or "PER_CAPITA"
            # The family's already-computed entity share for this expense — exactly what the ledger
            # uses. PER_CAPITA divides by total humans (involved-count aware); PER_FAMILY is flat.
            if mode == "PER_CAPITA":
                weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"),
                                          e.get("family_participants"), rosters)
                fam_share = split_per_capita(e["amount"], weights).get(fid, 0.0)
            else:  # PER_FAMILY: flat per-entity, redistributed within the family by participation
                fam_share = split_per_family(e["amount"], split_ids).get(fid, 0.0)
            if not fam_share:
                continue
            participants = (e.get("family_participants") or {}).get(fid)
            present = [p for p in (participants or []) if p in id_set]
            if present and len(present) < len(ids):
                restricted = True
            alloc = allocate_within_family(fam_share, participants, ids)
            for mid, s in alloc.items():
                if s != 0.0:
                    participated.add(mid)
                if e["amount"] > 0:  # gross cost only; refunds aren't "consumption"
                    consumption[mid] += s

        if not restricted:
            npp = round(net.get(fid, 0.0) / size, 2)  # byte-identical to legacy net_per_person
            rows = [{"id": ids[i], "name": names[i], "net": npp} for i in range(len(ids))]
        else:
            # Distribute the family's post-(non-pending)-settlement net (already in `net`)
            # PROPORTIONALLY to each member's consumption; excluded-everywhere members get exactly 0.
            # Equal consumption -> even split; zero total basis -> even split among participants.
            part_ids = [mid for mid in ids if mid in participated] or list(ids)
            basis = {mid: consumption[mid] for mid in part_ids}
            dist = distribute_by_consumption(net.get(fid, 0.0), basis, part_ids)
            raw = {mid: dist.get(mid, 0.0) for mid in ids}
            apport = _apportion(raw, ids, net.get(fid, 0.0))
            rows = [{"id": ids[i], "name": names[i], "net": apport[ids[i]]} for i in range(len(ids))]

        for row in rows:
            if row["net"] == 0:
                row["net"] = 0.0  # normalize -0.0
        out[fid] = rows

    return out
