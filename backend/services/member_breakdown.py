"""Per-member intra-family balance breakdown (Model A) — DISPLAY-only, ledger-neutral.

Pure helper (plain dicts/lists; imports only ``services.calculator`` + ``utils.display_names``,
mirroring ``services/report_builder.py``) that re-derives, for each family, how its already-computed
ledger ``net`` is divided among its OWN members, honoring each expense's ``family_participants``
(PER_CAPITA only).

The trip ledger (``net``, transfers, settlements, ``net_per_person``) is computed in
``utils.balances._compute_balances`` and passed in unchanged — this module never mutates it and never
changes any family's total, the trip headcount, or any other entity.

Two paths, chosen per family:
  * **No participation restriction on any expense** -> every member's share is exactly
    ``round(net / size, 2)``, byte-identical to the legacy uniform ``net_per_person`` that used to be
    shown for each roster member.
  * **>=1 expense restricts participation** -> PER_CAPITA owed shares are split only among the
    participating members (excluded -> 0) via ``allocate_within_family``; PER_FAMILY owed, paid
    credits, and settlements stay uniform by family size (the payer is the family entity, not a named
    member); a deterministic largest-remainder pass makes the rounded member shares sum EXACTLY to
    the family's rounded ledger net.
"""

import math

from services.calculator import (
    allocate_within_family,
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

    ``expenses`` must be the same kind=="expense" rows and ``net``/``settlements`` the same data
    ``_compute_balances`` used, so the no-restriction path reproduces ``net_per_person`` exactly.
    """
    weight_map = _weight_map(members)
    all_ids = [m["id"] for m in members]
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

        owed = {mid: 0.0 for mid in ids}  # PER_CAPITA owed, redistributed by participation
        uniform = 0.0                      # PER_FAMILY owed + paid credits + settlements (by size)
        restricted = False

        for e in expenses:
            if e.get("kind", "expense") != "expense":
                continue
            split_ids = e.get("split_member_ids") or all_ids
            in_split = fid in split_ids
            mode = e.get("split_mode") or "PER_CAPITA"
            if in_split:
                if mode == "PER_CAPITA":
                    weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"))
                    shares = split_per_capita(e["amount"], weights)
                    fam_share = shares.get(fid, 0.0)
                    if fam_share:
                        participants = (e.get("family_participants") or {}).get(fid)
                        present = [p for p in (participants or []) if p in id_set]
                        if present and len(present) < len(ids):
                            restricted = True
                        alloc = allocate_within_family(fam_share, participants, ids)
                        for mid, s in alloc.items():
                            owed[mid] -= s
                else:  # PER_FAMILY: size-independent, uniform among members (unchanged behavior)
                    shares = split_per_family(e["amount"], split_ids)
                    uniform -= shares.get(fid, 0.0)
            if e.get("paid_by_member_id") == fid:
                uniform += e["amount"]

        for s in settlements:
            if s.get("from_member_id") == fid:
                uniform += s["amount"]
            if s.get("to_member_id") == fid:
                uniform -= s["amount"]

        if not restricted:
            npp = round(net.get(fid, 0.0) / size, 2)  # byte-identical to legacy net_per_person
            rows = [{"id": ids[i], "name": names[i], "net": npp} for i in range(len(ids))]
        else:
            raw = {mid: owed[mid] + uniform / size for mid in ids}
            apport = _apportion(raw, ids, net.get(fid, 0.0))
            rows = [{"id": ids[i], "name": names[i], "net": apport[ids[i]]} for i in range(len(ids))]

        for row in rows:
            if row["net"] == 0:
                row["net"] = 0.0  # normalize -0.0
        out[fid] = rows

    return out
