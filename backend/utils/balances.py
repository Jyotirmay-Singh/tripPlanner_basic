from fastapi import HTTPException

from database import db
from services.calculator import (
    minimize_transfers,
    resolve_weights,
    split_per_capita,
    split_per_family,
)
from services.member_breakdown import family_member_breakdown, family_member_ids


def _weight_of_member(m: dict) -> int:
    if m["kind"] == "family":
        return max(1, len(m.get("family_members", [])))
    return 1


async def _compute_balances(trip_id: str) -> dict:
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    if not trip:
        raise HTTPException(404, "Trip not found")
    members = trip["members"]
    net = {m["id"]: 0.0 for m in members}
    weight_map = {m["id"]: _weight_of_member(m) for m in members}
    # Stable roster ids per family, so a PER_CAPITA family restricted to a proper subset of its
    # members (via `family_participants`) counts as its INVOLVED-member count (CLAUDE.md §5-A), not
    # its full size — the same involved count that divides the share among members downstream.
    rosters = {m["id"]: family_member_ids(m) for m in members if m.get("kind") == "family"}

    # Signed-amount model: ALL expense rows count. A positive `amount` is an expense (payer is the
    # creditor, participants owe their share); a negative `amount` is money coming back to the group —
    # the exact mirror through the same split engine (payer is debited, participants are credited),
    # with no abs() anywhere below. There is no longer a separate "income" kind to exclude.
    expenses = await db.expenses.find({"trip_id": trip_id}, {"_id": 0}).to_list(5000)
    for e in expenses:
        split_ids = e["split_member_ids"] or [m["id"] for m in members]
        mode = e.get("split_mode", "PER_CAPITA")
        if mode == "PER_CAPITA":
            weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"),
                                      e.get("family_participants"), rosters)
            shares = split_per_capita(e["amount"], weights)
            if not shares:
                continue  # H <= 0; nothing to split (matches old `if total_weight == 0: continue`)
            for sid, share in shares.items():
                net[sid] = net.get(sid, 0) - share
            net[e["paid_by_member_id"]] = net.get(e["paid_by_member_id"], 0) + e["amount"]
        else:
            # PER_FAMILY (Section 5B): flat entity-based division — each selected
            # family/individual owes amount / E regardless of size. Size and
            # weight_snapshots are intentionally ignored here.
            shares = split_per_family(e["amount"], split_ids)
            if not shares:
                continue
            for sid, share in shares.items():
                net[sid] = net.get(sid, 0) - share
            net[e["paid_by_member_id"]] = net.get(e["paid_by_member_id"], 0) + e["amount"]

    # apply settlements (Phase 10): only PAID settlements are real recorded payments that offset
    # the net. Pending records are durable to-dos and must NOT reduce balances. `$ne:"pending"`
    # also matches legacy rows that predate the `status` field (Mongo $ne matches missing fields),
    # so this stays back-compat even before the startup backfill runs.
    settlements = await db.settlements.find(
        {"trip_id": trip_id, "status": {"$ne": "pending"}}, {"_id": 0}).to_list(5000)
    for s in settlements:
        net[s["from_member_id"]] = net.get(s["from_member_id"], 0) + s["amount"]
        net[s["to_member_id"]] = net.get(s["to_member_id"], 0) - s["amount"]

    # round
    for k in net:
        net[k] = round(net[k], 2)

    # Intra-family per-member breakdown (DISPLAY-only; never mutates net/transfers). Honors each
    # expense's family_participants — excluded members show 0 and the family's share is split only
    # among participants. With no restriction it equals the uniform net_per_person below exactly.
    breakdown = family_member_breakdown(members, expenses, settlements, net)

    # greedy settlement suggestion
    transfers = minimize_transfers(net)
    return {"net": net, "transfers": transfers, "members": members,
            "currency": trip.get("currency", "INR"),
            "per_person": [
                {"member_id": m["id"], "member_name": m["name"], "kind": m["kind"],
                 "people_count": _weight_of_member(m),
                 "net_total": net.get(m["id"], 0.0),
                 "net_per_person": round(net.get(m["id"], 0.0) / _weight_of_member(m), 2),
                 "family_members": m.get("family_members", []),
                 # Additive: per-member shares for families ([{id,name,net}]); [] for individuals.
                 "members": breakdown.get(m["id"], []) }
                for m in members
            ]}
