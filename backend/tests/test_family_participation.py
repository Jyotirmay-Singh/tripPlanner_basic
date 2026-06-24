# Pure unit tests for intra-family member participation (Model A) — no HTTP / server / DB.
# Covers services.calculator.allocate_within_family and services.member_breakdown.family_member_breakdown.
from services.calculator import (
    allocate_within_family,
    minimize_transfers,
    resolve_weights,
    split_per_capita,
    split_per_family,
)
from services.member_breakdown import family_member_breakdown


def _weight(m):
    return max(1, len(m.get("family_members", []))) if m.get("kind") == "family" else 1


def _compute_net(members, expenses, settlements):
    """Faithful local mirror of utils.balances._compute_balances' net loop (the part that builds the
    entity ledger). Used to PROVE the ledger never reads family_participants."""
    net = {m["id"]: 0.0 for m in members}
    weight_map = {m["id"]: _weight(m) for m in members}
    all_ids = [m["id"] for m in members]
    for e in expenses:
        if e.get("kind", "expense") != "expense":
            continue
        split_ids = e["split_member_ids"] or all_ids
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


class TestAllocateWithinFamily:

    def test_four_members_one_excluded_divides_by_three(self):
        # The bug repro: family share 40, 1 of 4 excluded -> 3 split it, excluded owes 0.
        out = allocate_within_family(40.0, ["a", "v", "s"], ["a", "v", "s", "r"])
        assert out["r"] == 0.0
        assert abs(out["a"] - 40.0 / 3) < 1e-12
        assert abs(out["v"] - 40.0 / 3) < 1e-12
        assert abs(out["s"] - 40.0 / 3) < 1e-12
        assert abs(sum(out.values()) - 40.0) < 1e-9  # total preserved exactly

    def test_none_or_empty_participants_means_all(self):
        roster = ["a", "b", "c", "d"]
        for participants in (None, []):
            out = allocate_within_family(40.0, participants, roster)
            assert all(abs(v - 10.0) < 1e-12 for v in out.values())
            assert abs(sum(out.values()) - 40.0) < 1e-9

    def test_participants_not_in_roster_fall_back_to_all(self):
        # Robustness: every recorded participant was removed -> never drop the family's money.
        out = allocate_within_family(40.0, ["ghost1", "ghost2"], ["a", "b", "c", "d"])
        assert all(abs(v - 10.0) < 1e-12 for v in out.values())
        assert abs(sum(out.values()) - 40.0) < 1e-9

    def test_single_participant_owes_full_family_share(self):
        out = allocate_within_family(40.0, ["a"], ["a", "b", "c", "d"])
        assert out == {"a": 40.0, "b": 0.0, "c": 0.0, "d": 0.0}

    def test_non_divisible_remainder_no_intermediate_rounding(self):
        out = allocate_within_family(100.0, ["a", "b", "c"], ["a", "b", "c", "d"])
        assert out["d"] == 0.0
        assert abs(sum(out.values()) - 100.0) < 1e-9
        for k in ("a", "b", "c"):
            assert abs(out[k] - 100.0 / 3) < 1e-12

    def test_empty_roster_returns_empty(self):
        assert allocate_within_family(40.0, ["a"], []) == {}


def _members():
    return [
        {"id": "S", "name": "Sharma", "kind": "family",
         "family_members": ["Asha", "Vik", "Sam", "Rahul"],
         "family_member_ids": ["a", "v", "s", "r"]},
        {"id": "G", "name": "Gupta", "kind": "family",
         "family_members": ["X", "Y"], "family_member_ids": ["gx", "gy"]},
        {"id": "I", "name": "Indie", "kind": "individual", "family_members": []},
    ]


def _expense(family_participants=None):
    # $70 PER_CAPITA dinner, split among all (7 humans), individual pays.
    return {"id": "e1", "kind": "expense", "amount": 70.0, "category": "Food",
            "split_member_ids": [], "split_mode": "PER_CAPITA", "paid_by_member_id": "I",
            "family_participants": family_participants}


class TestFamilyMemberBreakdown:

    def test_section5_example_excluded_member_owes_zero_and_family_total_preserved(self):
        members = _members()
        exp_no = [_expense(None)]
        exp_yes = [_expense({"S": ["a", "v", "s"]})]  # exclude Rahul (r)

        net_no = _compute_net(members, exp_no, [])
        net_yes = _compute_net(members, exp_yes, [])
        # Ledger is identical with/without the exclusion: family total + EVERY other entity unchanged.
        assert net_yes == net_no
        assert net_yes["S"] == -40.0 and net_yes["G"] == -20.0 and net_yes["I"] == 60.0

        bd = family_member_breakdown(members, exp_yes, [], net_yes)
        sharma = {row["id"]: row["net"] for row in bd["S"]}
        assert sharma["r"] == 0.0                       # excluded member owes nothing
        assert round(sum(sharma.values()), 2) == -40.0  # members sum EXACTLY to the family total
        for mid in ("a", "v", "s"):
            assert abs(sharma[mid] - (-40.0 / 3)) < 0.01  # ~ -13.33 each
        # Gupta (no restriction) stays uniform; individual has no per-member breakdown.
        assert all(row["net"] == -10.0 for row in bd["G"])
        assert "I" not in bd

    def test_no_restriction_is_byte_identical_to_net_per_person(self):
        members = _members()
        exp = [_expense(None)]
        net = _compute_net(members, exp, [])
        bd = family_member_breakdown(members, exp, [], net)
        for fam in ("S", "G"):
            size = max(1, len(next(m for m in members if m["id"] == fam)["family_members"]))
            uniform = round(net[fam] / size, 2)
            assert all(row["net"] == uniform for row in bd[fam])

    def test_breakdown_does_not_mutate_net(self):
        members = _members()
        net = _compute_net(members, [_expense({"S": ["a", "v", "s"]})], [])
        snapshot = dict(net)
        family_member_breakdown(members, [_expense({"S": ["a", "v", "s"]})], [], net)
        assert net == snapshot

    def test_member_added_after_expense_owes_zero(self):
        # New member 'n' joins Sharma AFTER the expense; the past expense's participants stay [a,v,s].
        members = _members()
        members[0]["family_members"].append("Neha")
        members[0]["family_member_ids"].append("n")
        exp = [_expense({"S": ["a", "v", "s"]})]
        net = _compute_net(members, exp, [])
        bd = family_member_breakdown(members, exp, [], net)
        shares = {row["id"]: row["net"] for row in bd["S"]}
        assert shares["n"] == 0.0   # newly-added member starts at zero on the past expense
        assert shares["r"] == 0.0   # still-excluded member also zero
        assert round(sum(shares.values()), 2) == round(net["S"], 2)

    def test_names_track_roster_order(self):
        members = _members()
        bd = family_member_breakdown(members, [_expense(None)], [], _compute_net(members, [_expense(None)], []))
        assert [row["name"] for row in bd["S"]] == ["Asha", "Vik", "Sam", "Rahul"]

    def test_legacy_family_without_ids_still_renders_uniform(self):
        # A family not yet backfilled (no family_member_ids) stays on the uniform path.
        members = [
            {"id": "S", "name": "Sharma", "kind": "family", "family_members": ["A", "B"]},
            {"id": "I", "name": "Indie", "kind": "individual", "family_members": []},
        ]
        exp = [{"id": "e1", "kind": "expense", "amount": 30.0, "category": "Food",
                "split_member_ids": [], "split_mode": "PER_CAPITA", "paid_by_member_id": "I"}]
        net = _compute_net(members, exp, [])
        bd = family_member_breakdown(members, exp, [], net)
        assert len(bd["S"]) == 2
        assert all(row["net"] == round(net["S"] / 2, 2) for row in bd["S"])


class TestPerFamilyUnaffected:

    def test_per_family_ignores_participation(self):
        # PER_FAMILY divides flat per entity and is size/participation independent.
        members = _members()
        exp = [{"id": "e1", "kind": "expense", "amount": 90.0, "category": "Food",
                "split_member_ids": ["S", "G", "I"], "split_mode": "PER_FAMILY",
                "paid_by_member_id": "I", "family_participants": {"S": ["a"]}}]
        net = _compute_net(members, exp, [])
        # Each entity owes 30 flat (size-independent); participation map is irrelevant to PER_FAMILY.
        assert net["S"] == -30.0 and net["G"] == -30.0
        bd = family_member_breakdown(members, exp, [], net)
        # Uniform within the family (PER_FAMILY is never redistributed by participation): -30/4 each.
        assert all(row["net"] == -7.5 for row in bd["S"])
