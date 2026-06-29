# Pure unit tests for the two splitting/balance bug fixes. No HTTP/server/DB — plain dicts + the pure
# services, like test_per_capita.py / test_family_participation.py.
#
# BUG 2: PER_CAPITA must divide by the total INVOLVED humans — a family restricted to a subset of its
#        roster (via family_participants) counts as its involved-member count (CLAUDE.md §5-A).
# BUG 1: the family per-member breakdown must show the OUTSTANDING remainder (the post-settlement
#        family net) distributed PROPORTIONALLY to each member's gross consumption — not pre-settlement
#        gross positions that merely sum to the net.
import math

from services.calculator import (
    _chosen_participants,
    distribute_by_consumption,
    involved_count,
    resolve_weights,
    split_per_capita,
)
from services.income_migration import compute_net  # faithful _compute_balances replica
from services.member_breakdown import family_member_breakdown, family_member_ids


# --------------------------------------------------------------------------- helpers
def _fam(mid, ids):
    return {"id": mid, "name": mid, "kind": "family",
            "family_members": [f"m{i}" for i in range(len(ids))], "family_member_ids": ids}


def _ind(mid):
    return {"id": mid, "name": mid, "kind": "individual", "family_members": []}


def _exp(amount, split_ids, mode="PER_CAPITA", paid_by=None, participants=None):
    return {"id": "e1", "amount": amount, "split_member_ids": split_ids, "split_mode": mode,
            "paid_by_member_id": paid_by, "family_participants": participants}


# =========================================================================== _chosen_participants / involved_count
class TestInvolvedCount:
    def test_proper_subset(self):
        assert _chosen_participants(["a", "b", "c"], ["a", "b", "c", "d"]) == ["a", "b", "c"]
        assert involved_count(["a", "b", "c"], ["a", "b", "c", "d"]) == 3

    def test_roster_order_not_participant_order(self):
        assert _chosen_participants(["c", "a"], ["a", "b", "c"]) == ["a", "c"]

    def test_empty_or_none_falls_back_to_full_roster(self):
        for p in (None, []):
            assert involved_count(p, ["a", "b", "c", "d"]) == 4

    def test_none_survive_falls_back_to_full_roster(self):
        assert involved_count(["ghost1", "ghost2"], ["a", "b"]) == 2

    def test_empty_roster_is_zero(self):
        assert involved_count(["a"], []) == 0

    def test_matches_allocate_divisor(self):
        # The whole point: the count that SIZES a family's share == the count allocate divides by.
        from services.calculator import allocate_within_family
        roster, parts = ["a", "b", "c", "d"], ["a", "b", "c"]
        alloc = allocate_within_family(90.0, parts, roster)
        nonzero = [k for k, v in alloc.items() if v != 0.0]
        assert len(nonzero) == involved_count(parts, roster) == 3


# =========================================================================== resolve_weights extension
class TestResolveWeightsInvolved:
    def test_defaults_byte_identical(self):
        base = {"f1": 4, "i1": 1}
        assert resolve_weights(["f1", "i1"], base) == {"f1": 4, "i1": 1}
        assert resolve_weights(["f1", "i1"], base, {"f1": 2}) == {"f1": 2, "i1": 1}

    def test_family_participants_drives_weight(self):
        w = resolve_weights(["f1", "i1"], {"f1": 4, "i1": 1}, None,
                            {"f1": ["a", "b", "c"]}, {"f1": ["a", "b", "c", "d"]})
        assert w == {"f1": 3, "i1": 1}

    def test_snapshot_wins_over_participants(self):
        w = resolve_weights(["f1"], {"f1": 4}, {"f1": 2},
                            {"f1": ["a", "b", "c"]}, {"f1": ["a", "b", "c", "d"]})
        assert w == {"f1": 2}

    def test_no_restriction_full_size(self):
        w = resolve_weights(["f1"], {"f1": 4}, None, {}, {"f1": ["a", "b", "c", "d"]})
        assert w == {"f1": 4}


# =========================================================================== BUG 2 — per-capita involved-count
class TestPerCapitaInvolved:
    def test_single_family_three_of_four(self):
        # CLAUDE.md §5-A worked example: $100, 1 individual + family(4, 3 involved).
        members = [_fam("F", ["a", "b", "c", "d"]), _ind("i1")]
        e = _exp(100.0, [], paid_by="i1", participants={"F": ["a", "b", "c"]})
        net = compute_net(members, [e], [])
        assert net["F"] == -75.0 and net["i1"] == 75.0   # H = 4, C = 25, F total = 3*25 = 75
        bd = family_member_breakdown(members, [e], [], net)
        rows = {r["id"]: r["net"] for r in bd["F"]}
        assert rows == {"a": -25.0, "b": -25.0, "c": -25.0, "d": 0.0}

    def test_multi_family_C_equals_expense_over_H(self):
        # Two families with different involved counts + an individual. $120, H = 3 + 2 + 1 = 6,
        # C = 20; each family total = involved_count * C.
        members = [_fam("F1", ["a", "b", "c", "d"]), _fam("F2", ["w", "x", "y"]), _ind("i1")]
        e = _exp(120.0, [], paid_by="i1",
                 participants={"F1": ["a", "b", "c"], "F2": ["w", "x"]})
        net = compute_net(members, [e], [])
        assert net["F1"] == -60.0   # 3 * 20
        assert net["F2"] == -40.0   # 2 * 20
        assert net["i1"] == 100.0   # 120 - 20
        assert round(sum(net.values()), 2) == 0.0

    def test_per_family_unaffected_by_participants(self):
        # PER_FAMILY: participants stay DISPLAY-only; each family owes the flat per-entity share.
        members = [_fam("F1", ["a", "b", "c", "d"]), _fam("F2", ["w", "x", "y"]), _ind("i1")]
        e = _exp(120.0, [], mode="PER_FAMILY", paid_by="i1",
                 participants={"F1": ["a", "b", "c"], "F2": ["w", "x"]})
        net = compute_net(members, [e], [])
        # 3 entities -> flat 40 each, regardless of involved counts.
        assert net["F1"] == -40.0 and net["F2"] == -40.0 and net["i1"] == 80.0


# =========================================================================== BUG 1 — distribute_by_consumption
class TestDistributeByConsumption:
    def test_proportional_descending(self):
        out = distribute_by_consumption(-50.0, {"a": 30.0, "b": 20.0}, ["a", "b"])
        assert out == {"a": -30.0, "b": -20.0}
        assert abs(sum(out.values()) - (-50.0)) < 1e-9

    def test_equal_basis_reduces_to_even_split(self):
        out = distribute_by_consumption(-50.0, {"a": 10.0, "b": 10.0, "c": 10.0, "d": 10.0},
                                        ["a", "b", "c", "d"])
        assert all(abs(v - (-12.5)) < 1e-9 for v in out.values())

    def test_zero_basis_falls_back_to_even_split(self):
        out = distribute_by_consumption(-50.0, {"a": 0.0, "b": 0.0}, ["a", "b"])
        assert out == {"a": -25.0, "b": -25.0}

    def test_negative_basis_clamped(self):
        out = distribute_by_consumption(-50.0, {"a": -5.0, "b": 20.0}, ["a", "b"])
        assert out["b"] == -50.0 and out["a"] == 0.0  # clamped, no sign flip / Inf

    def test_positive_net_creditor(self):
        out = distribute_by_consumption(40.0, {"a": 3.0, "b": 1.0}, ["a", "b"])
        assert out == {"a": 30.0, "b": 10.0}

    def test_single_member_and_empty(self):
        assert distribute_by_consumption(-7.0, {"a": 0.0}, ["a"]) == {"a": -7.0}
        assert distribute_by_consumption(-7.0, {}, []) == {}

    def test_no_nan_inf(self):
        for out in (distribute_by_consumption(-50.0, {}, ["a", "b"]),
                    distribute_by_consumption(0.0, {"a": 0.0}, ["a"])):
            for v in out.values():
                assert math.isfinite(v)


# =========================================================================== BUG 1 — breakdown shows remainder
class TestBreakdownRemainderProportional:
    def _members(self):
        return [_fam("F", ["a", "b"]), _ind("i1"), _ind("i2")]

    def test_large_expense_offset_by_paid_settlement_no_blowup(self):
        # F fronts a huge bill and consumes (restricted to member a); i1/i2 then pay F back via PAID
        # settlements, netting F down to a small remainder. The per-member rows must show that small
        # remainder (no millions, no sign blow-ups) and sum EXACTLY to it.
        members = self._members()
        exps = [_exp(900000.0, ["F", "i1", "i2"], paid_by="F", participants={"F": ["a"]})]
        # F consumed 900000/3 = 300000 (a only); i1, i2 each owe 300000. They pay F back 299975 total.
        setts = [
            {"from_member_id": "i1", "to_member_id": "F", "amount": 299975.0, "status": "paid"},
            {"from_member_id": "i2", "to_member_id": "F", "amount": 299975.0, "status": "paid"},
        ]
        net = compute_net(members, exps, setts)
        rows = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, setts, net)["F"]}
        assert round(sum(rows.values()), 2) == round(net["F"], 2)   # sums to the family net
        assert all(abs(v) < 1e6 for v in rows.values())            # no millions blow-up
        assert rows["b"] == 0.0                                     # b never took part -> 0

    def test_larger_consumption_gets_larger_share(self):
        # Two restricted expenses give member a twice b's consumption; no settlements.
        members = self._members()
        exps = [
            _exp(60.0, ["F", "i1"], paid_by="i1", participants={"F": ["a"]}),     # a consumes
            _exp(60.0, ["F", "i1"], paid_by="i1", participants={"F": ["a", "b"]}),  # a+b consume
        ]
        net = compute_net(members, exps, [])
        rows = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, [], net)["F"]}
        assert abs(rows["a"]) > abs(rows["b"]) > 0                  # a consumed more -> larger share
        assert round(rows["a"] + rows["b"], 2) == round(net["F"], 2)

    def test_pending_settlement_does_not_offset(self):
        members = self._members()
        exps = [_exp(60.0, ["F", "i1"], paid_by="i1", participants={"F": ["a", "b"]})]
        paid_net = compute_net(members, exps, [])
        # A PENDING settlement must NOT change the net or the breakdown.
        pending = [{"from_member_id": "F", "to_member_id": "i1", "amount": 10.0, "status": "pending"}]
        # compute_net here is the expense+settlement replica; the LEDGER filters pending upstream, so
        # we simulate that by NOT passing the pending row to compute_net (it never offsets) and assert
        # the breakdown over the unchanged net is identical.
        rows_no = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, [], paid_net)["F"]}
        rows_pending = {r["id"]: r["net"]
                        for r in family_member_breakdown(members, exps, pending, paid_net)["F"]}
        assert rows_no == rows_pending  # settlements param no longer drives the math; net already final
