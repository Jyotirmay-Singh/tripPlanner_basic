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
  * **>=1 expense restricts participation** -> CHRONOLOGICAL replay via ``distribute_chronological``:
    the family's expenses AND non-pending settlements are replayed in time order. Each expense's net
    ((amount if the family paid else 0) minus its consumption share) is split EVENLY among only the
    members who took part in THAT expense (excluded ⇒ 0; a family-paid credit lands only on its
    participants), and each settlement SCALES the running positions toward 0 — so settled money
    disappears per member and only later (unsettled) expenses remain. A deterministic largest-remainder
    pass makes the rounded member shares sum EXACTLY to the family's rounded ledger net. When everyone
    participates in everything this reduces to the same uniform ``net/size``, so the two paths agree.
    (This replaced an earlier proportional-by-total-consumption decomposition, then a settlement-net
    even-split, both of which could show already-settled money on a member who should read 0.)

Note on participation and the family TOTAL: in **PER_CAPITA**, ``family_participants`` reduces a
family's involved headcount, so its entity total is already smaller upstream (CLAUDE.md §5-A); in
**PER_FAMILY** the family's flat per-entity total is unchanged and only its internal division honors
participation. Either way this module distributes whatever ``net`` it is given.
"""

import math

from services.calculator import (
    _chosen_participants,
    distribute_chronological,
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
    reproduces ``net_per_person`` exactly. The restricted path replays the family's expenses AND
    non-pending settlements in CHRONOLOGICAL order (``distribute_chronological``): each expense's net
    touches only its participants, and a settlement scales the running positions toward 0 — so settled
    money disappears per member and only later (unsettled) expenses remain — apportioned to sum EXACTLY
    to the family's ledger ``net``.

    ``settlements`` are the SAME non-pending rows ``_compute_balances`` overlaid; each is ordered by
    its ``paid_at``/``created_at`` against the expenses.
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

        # Chronological events for this family: every expense it is in OR paid for contributes
        # ("exp", net_e, chosen) (a member outside `chosen` gets exactly 0 from it); every non-pending
        # settlement touching it contributes ("settle", delta). `restricted` flags any proper-subset
        # participation -> use the chronological isolation path (else the uniform net/size path).
        timed: list = []  # (sort_key, kind, value, chosen)
        restricted = False

        for e in expenses:
            split_ids = e.get("split_member_ids") or all_ids
            in_split = fid in split_ids
            is_payer = e.get("paid_by_member_id") == fid
            if not in_split and not is_payer:
                continue
            mode = e.get("split_mode") or "PER_CAPITA"
            # The family's already-computed entity share for this expense — exactly what the ledger
            # uses (PER_CAPITA involved-count aware; PER_FAMILY flat). 0 when the family only paid.
            if not in_split:
                fam_share = 0.0
            elif mode == "PER_CAPITA":
                weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"),
                                          e.get("family_participants"), rosters)
                fam_share = split_per_capita(e["amount"], weights).get(fid, 0.0)
            else:  # PER_FAMILY: flat per-entity, redistributed within the family by participation
                fam_share = split_per_family(e["amount"], split_ids).get(fid, 0.0)
            # The family's net for THIS expense: credited the full amount when it paid, debited its
            # consumption share. Split evenly among the members who took part (full roster when the
            # family only paid / nobody is restricted).
            net_e = (e["amount"] if is_payer else 0.0) - fam_share
            participants = (e.get("family_participants") or {}).get(fid)
            present = [p for p in (participants or []) if p in id_set]
            if present and len(present) < len(ids):
                restricted = True
            chosen = _chosen_participants(participants, ids)
            timed.append((e.get("created_at") or "", "exp", net_e, chosen))

        for s in settlements:
            # Settlement effect on the family net, same sign as _compute_balances (net[from]+=amount,
            # net[to]-=amount). Ordered by when it took effect (paid_at, else created_at).
            delta = (s["amount"] if s.get("from_member_id") == fid else 0.0) \
                - (s["amount"] if s.get("to_member_id") == fid else 0.0)
            if delta:
                timed.append((s.get("paid_at") or s.get("created_at") or "", "settle", delta, None))

        if not restricted:
            npp = round(net.get(fid, 0.0) / size, 2)  # byte-identical to legacy net_per_person
            rows = [{"id": ids[i], "name": names[i], "net": npp} for i in range(len(ids))]
        else:
            # Replay chronologically (ISO timestamps sort correctly; legacy/blank sort earliest). Each
            # settlement scales the running positions toward 0, so settled money clears per member.
            timed.sort(key=lambda ev: ev[0])
            events = [(kind, value, chosen) for (_, kind, value, chosen) in timed]
            raw = distribute_chronological(events, ids)
            apport = _apportion(raw, ids, net.get(fid, 0.0))
            rows = [{"id": ids[i], "name": names[i], "net": apport[ids[i]]} for i in range(len(ids))]

        for row in rows:
            if row["net"] == 0:
                row["net"] = 0.0  # normalize -0.0
        out[fid] = rows

    return out
