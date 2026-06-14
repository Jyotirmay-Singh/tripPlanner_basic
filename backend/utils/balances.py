from fastapi import HTTPException

from database import db
from services.calculator import minimize_transfers, resolve_weights, split_per_capita


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

    expenses = await db.expenses.find({"trip_id": trip_id, "kind": "expense"}, {"_id": 0}).to_list(5000)
    for e in expenses:
        split_ids = e["split_member_ids"] or [m["id"] for m in members]
        mode = e.get("split_mode", "PER_CAPITA")
        if mode == "PER_CAPITA":
            weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"))
            shares = split_per_capita(e["amount"], weights)
            if not shares:
                continue  # H <= 0; nothing to split (matches old `if total_weight == 0: continue`)
            for sid, share in shares.items():
                net[sid] = net.get(sid, 0) - share
            net[e["paid_by_member_id"]] = net.get(e["paid_by_member_id"], 0) + e["amount"]
        else:
            # PER_FAMILY: interim only — entity-based division is Step 7. Keep the current
            # weight-based behavior so existing numbers/tests are unchanged until then.
            snap = e.get("weight_snapshots") or {}
            def wt(sid: str) -> int:
                if sid in snap:
                    return int(snap[sid])
                return weight_map.get(sid, 1)
            total_weight = sum(wt(sid) for sid in split_ids)
            if total_weight == 0:
                continue
            per_unit = e["amount"] / total_weight
            for sid in split_ids:
                net[sid] = net.get(sid, 0) - per_unit * wt(sid)
            net[e["paid_by_member_id"]] = net.get(e["paid_by_member_id"], 0) + e["amount"]

    # apply settlements
    settlements = await db.settlements.find({"trip_id": trip_id}, {"_id": 0}).to_list(5000)
    for s in settlements:
        net[s["from_member_id"]] = net.get(s["from_member_id"], 0) + s["amount"]
        net[s["to_member_id"]] = net.get(s["to_member_id"], 0) - s["amount"]

    # round
    for k in net:
        net[k] = round(net[k], 2)

    # greedy settlement suggestion
    transfers = minimize_transfers(net)
    return {"net": net, "transfers": transfers, "members": members,
            "currency": trip.get("currency", "INR"),
            "per_person": [
                {"member_id": m["id"], "member_name": m["name"], "kind": m["kind"],
                 "people_count": _weight_of_member(m),
                 "net_total": net.get(m["id"], 0.0),
                 "net_per_person": round(net.get(m["id"], 0.0) / _weight_of_member(m), 2),
                 "family_members": m.get("family_members", []) }
                for m in members
            ]}
