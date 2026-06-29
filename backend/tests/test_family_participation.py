# Pure unit tests for intra-family member participation (Model A) — no HTTP / server / DB.
# Covers services.calculator.allocate_within_family and services.member_breakdown.family_member_breakdown.
from services.calculator import (
    allocate_within_family,
    minimize_transfers,
    resolve_weights,
    split_per_capita,
    split_per_family,
)
from services.member_breakdown import family_member_breakdown, family_member_ids


def _weight(m):
    return max(1, len(m.get("family_members", []))) if m.get("kind") == "family" else 1


def _compute_net(members, expenses, settlements):
    """Faithful local mirror of utils.balances._compute_balances' net loop (the part that builds the
    entity ledger). PER_CAPITA honors family_participants (a restricted family counts as its involved
    member count), exactly like the real ledger; PER_FAMILY ignores it."""
    net = {m["id"]: 0.0 for m in members}
    weight_map = {m["id"]: _weight(m) for m in members}
    rosters = {m["id"]: family_member_ids(m) for m in members if m.get("kind") == "family"}
    all_ids = [m["id"] for m in members]
    for e in expenses:
        if e.get("kind", "expense") != "expense":
            continue
        split_ids = e["split_member_ids"] or all_ids
        mode = e.get("split_mode", "PER_CAPITA")
        if mode == "PER_CAPITA":
            weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"),
                                      e.get("family_participants"), rosters)
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

    def test_section5_example_excluded_member_reduces_family_headcount(self):
        # CLAUDE.md §5-A: excluding Rahul makes Sharma count as its INVOLVED count (3), not full size
        # (4). $70 dinner, H = 3 (Sharma) + 2 (Gupta) + 1 (Indie) = 6 -> per-human 70/6. The family
        # ENTITY total now changes vs. no exclusion (the old "ledger ignores participants" is gone).
        members = _members()
        exp_no = [_expense(None)]
        exp_yes = [_expense({"S": ["a", "v", "s"]})]  # exclude Rahul (r)

        net_no = _compute_net(members, exp_no, [])
        net_yes = _compute_net(members, exp_yes, [])
        assert net_no["S"] == -40.0 and net_no["G"] == -20.0 and net_no["I"] == 60.0  # full size
        assert net_yes != net_no                               # involved count now drives the ledger
        assert net_yes["S"] == -35.0                           # 3 * 70/6 exactly
        assert abs(net_yes["G"] - (-2 * 70 / 6)) < 0.01        # Gupta unrestricted -> 2 humans
        assert abs(net_yes["I"] - (70 - 70 / 6)) < 0.01        # payer credited net of its own share
        assert round(sum(net_yes.values()), 2) == 0.0          # conservation

        bd = family_member_breakdown(members, exp_yes, [], net_yes)
        sharma = {row["id"]: row["net"] for row in bd["S"]}
        assert sharma["r"] == 0.0                              # excluded member owes nothing
        assert round(sum(sharma.values()), 2) == -35.0         # members sum EXACTLY to the family total
        for mid in ("a", "v", "s"):
            assert abs(sharma[mid] - (-35.0 / 3)) < 0.01       # ~ -11.67 each
        # Gupta (no restriction) stays uniform; individual has no per-member breakdown.
        uniform = round(net_yes["G"] / 2, 2)
        assert all(row["net"] == uniform for row in bd["G"])
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


class TestPerFamilyParticipation:
    """PER_FAMILY now redistributes a family's FLAT per-entity share among its participants (Model A):
    the entity-level split (amount / entities) and the ledger are unchanged — only the internal
    per-member display split honors participation."""

    @staticmethod
    def _two_families():
        # Two families of 4 + an individual payer — the $1000 / 2-family worked example.
        return [
            {"id": "F1", "name": "Fam1", "kind": "family",
             "family_members": ["A", "B", "C", "D"], "family_member_ids": ["a", "b", "c", "d"]},
            {"id": "F2", "name": "Fam2", "kind": "family",
             "family_members": ["W", "X", "Y", "Z"], "family_member_ids": ["w", "x", "y", "z"]},
            {"id": "P", "name": "Payer", "kind": "individual", "family_members": []},
        ]

    @staticmethod
    def _expense(family_participants=None):
        return {"id": "e1", "kind": "expense", "amount": 1000.0, "category": "Stay",
                "split_member_ids": ["F1", "F2"], "split_mode": "PER_FAMILY",
                "paid_by_member_id": "P", "family_participants": family_participants}

    def test_each_family_pays_half_split_among_its_participants(self):
        members = self._two_families()
        fp = {"F1": ["a", "b", "c"], "F2": ["w", "x"]}  # F1: 3 of 4 took part; F2: 2 of 4
        net_no = _compute_net(members, [self._expense(None)], [])
        net_yes = _compute_net(members, [self._expense(fp)], [])
        # Entity ledger identical with/without participation: each family owes a flat 500 (1000 / 2).
        assert net_yes == net_no
        assert net_yes["F1"] == -500.0 and net_yes["F2"] == -500.0 and net_yes["P"] == 1000.0

        bd = family_member_breakdown(members, [self._expense(fp)], [], net_yes)
        f1 = {row["id"]: row["net"] for row in bd["F1"]}
        f2 = {row["id"]: row["net"] for row in bd["F2"]}
        # F1: 500 split among 3 -> ~166.67 each, excluded D owes 0, members sum EXACTLY to -500.
        assert f1["d"] == 0.0
        for mid in ("a", "b", "c"):
            assert abs(f1[mid] - (-500.0 / 3)) < 0.01
        assert round(sum(f1.values()), 2) == -500.0
        # F2: 500 split among 2 -> exactly 250 each; Y/Z owe 0.
        assert f2["w"] == -250.0 and f2["x"] == -250.0
        assert f2["y"] == 0.0 and f2["z"] == 0.0
        assert round(sum(f2.values()), 2) == -500.0

    def test_unrestricted_per_family_is_byte_identical_to_net_per_person(self):
        members = self._two_families()
        exp = [self._expense(None)]
        net = _compute_net(members, exp, [])
        bd = family_member_breakdown(members, exp, [], net)
        for fam in ("F1", "F2"):
            uniform = round(net[fam] / 4, 2)  # legacy net_per_person (family size 4)
            assert all(row["net"] == uniform for row in bd[fam])

    def test_participation_map_never_changes_the_ledger(self):
        members = self._two_families()
        base = _compute_net(members, [self._expense(None)], [])
        for fp in (None, {"F1": ["a"]}, {"F1": ["a", "b"], "F2": ["w", "x", "y"]}):
            assert _compute_net(members, [self._expense(fp)], []) == base
