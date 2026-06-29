# Pure unit tests for the two splitting/balance bug fixes. No HTTP/server/DB — plain dicts + the pure
# services, like test_per_capita.py / test_family_participation.py.
#
# BUG 2: PER_CAPITA must divide by the total INVOLVED humans — a family restricted to a subset of its
#        roster (via family_participants) counts as its involved-member count (CLAUDE.md §5-A).
# BUG 1: the family per-member breakdown uses PER-EXPENSE ISOLATION — each expense's family net is
#        split only among that expense's participants (a member excluded from an expense gets exactly 0
#        from it), the settlement net is split across the roster, and the rows sum EXACTLY to the
#        family net.
from services.calculator import (
    _chosen_participants,
    distribute_chronological,
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


# =========================================================================== BUG 1 — distribute_chronological
class TestDistributeChronological:
    def test_even_split_among_chosen_excluded_zero(self):
        out = distribute_chronological([("exp", -60.0, ["a", "b"])], ["a", "b", "c"])
        assert out == {"a": -30.0, "b": -30.0, "c": 0.0}  # c excluded -> exactly 0

    def test_payer_credit_lands_on_participants(self):
        out = distribute_chronological([("exp", 100.0, ["a", "b"])], ["a", "b", "c"])
        assert out == {"a": 50.0, "b": 50.0, "c": 0.0}

    def test_multiple_expenses_accumulate_per_member(self):
        out = distribute_chronological([("exp", -20.0, ["a"]), ("exp", -40.0, ["a", "b"])], ["a", "b"])
        assert out == {"a": -40.0, "b": -20.0}  # a in both, b only the 2nd

    def test_full_settlement_zeroes_everyone_then_new_expense_shows_fresh(self):
        # a/b owe from old expenses, a FULL settlement clears them, then a new expense (b only).
        events = [
            ("exp", -100.0, ["a"]), ("exp", -100.0, ["b"]),  # a -100, b -100 (net -200)
            ("settle", 200.0, None),                          # family pays back 200 -> both -> 0
            ("exp", -50.0, ["b"]),                            # new unsettled expense, b only
        ]
        out = distribute_chronological(events, ["a", "b"])
        assert out == {"a": 0.0, "b": -50.0}  # settled money gone; only the new expense remains

    def test_partial_settlement_shrinks_open_positions_proportionally(self):
        # a -60, b -40 (net -100); a partial settlement of 50 halves both.
        out = distribute_chronological([("exp", -60.0, ["a"]), ("exp", -40.0, ["b"]),
                                        ("settle", 50.0, None)], ["a", "b"])
        assert out == {"a": -30.0, "b": -20.0}

    def test_settlement_on_zero_positions_splits_evenly(self):
        out = distribute_chronological([("settle", 12.0, None)], ["a", "b", "c"])
        assert out == {"a": 4.0, "b": 4.0, "c": 4.0}

    def test_stale_chosen_ids_dropped(self):
        out = distribute_chronological([("exp", -30.0, ["a", "ghost"])], ["a", "b"])
        assert out == {"a": -30.0, "b": 0.0}  # ghost not in roster -> dropped, a takes the share

    def test_empty_chosen_contributes_nothing(self):
        assert distribute_chronological([("exp", 50.0, [])], ["a", "b"]) == {"a": 0.0, "b": 0.0}

    def test_single_member_and_empty_roster(self):
        assert distribute_chronological([("exp", -7.0, ["a"])], ["a"]) == {"a": -7.0}
        assert distribute_chronological([("exp", -7.0, ["a"]), ("settle", 5.0, None)], []) == {}

    def test_sum_equals_post_settlement_net(self):
        out = distribute_chronological([("exp", -20.0, ["a"]), ("exp", 90.0, ["b"]),
                                        ("settle", 6.0, None)], ["a", "b", "c"])
        assert abs(sum(out.values()) - (-20.0 + 90.0 + 6.0)) < 1e-9


# =========================================================================== BUG 1 — per-expense isolation
class TestBreakdownPerExpenseIsolation:
    def test_excluded_member_zero_for_skipped_expense(self):
        # F=[a,b]; b excluded from the only expense -> b shows exactly 0, a carries the family debt.
        members = [_fam("F", ["a", "b"]), _ind("i1")]
        exps = [_exp(60.0, ["F", "i1"], paid_by="i1", participants={"F": ["a"]})]
        net = compute_net(members, exps, [])  # H = a + i1 = 2, C = 30, F net = -30
        rows = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, [], net)["F"]}
        assert rows == {"a": net["F"], "b": 0.0}

    def test_family_paid_credit_lands_only_on_participants(self):
        # F PAYS 100 with b excluded -> the credit goes to participant a only; b stays 0.
        members = [_fam("F", ["a", "b"]), _ind("i1")]
        exps = [_exp(100.0, ["F", "i1"], paid_by="F", participants={"F": ["a"]})]
        net = compute_net(members, exps, [])  # H = 2, F share 50, F net = 100 - 50 = +50
        rows = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, [], net)["F"]}
        assert rows == {"a": 50.0, "b": 0.0}

    def test_member_owes_only_expenses_they_joined(self):
        # a in both expenses, b only the 2nd -> b owes just its 2nd-expense share. No settlements.
        members = [_fam("F", ["a", "b"]), _ind("i1")]
        exps = [
            _exp(40.0, ["F", "i1"], paid_by="i1", participants={"F": ["a"]}),         # b excluded
            _exp(60.0, ["F", "i1"], paid_by="i1", participants={"F": ["a", "b"]}),    # both -> a,b
        ]
        net = compute_net(members, exps, [])
        rows = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, [], net)["F"]}
        assert rows == {"a": -40.0, "b": -20.0}  # a: 20 (exp1) + 20 (exp2); b: 20 (exp2 only)
        assert round(rows["a"] + rows["b"], 2) == round(net["F"], 2)

    def test_excluded_everywhere_is_zero(self):
        members = [_fam("F", ["a", "b", "c"]), _ind("i1")]
        exps = [_exp(90.0, ["F", "i1"], paid_by="i1", participants={"F": ["a", "b"]})]  # c excluded
        net = compute_net(members, exps, [])
        rows = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, [], net)["F"]}
        assert rows["c"] == 0.0

    def test_rows_sum_to_net_with_paid_settlement_bounded(self):
        # Big numbers: rows stay bounded by real transaction amounts (no artificial blow-up) and sum
        # EXACTLY to the family net. The settlement net is split evenly across the roster.
        members = [_fam("F", ["a", "b"]), _ind("i1"), _ind("i2")]
        exps = [_exp(900000.0, ["F", "i1", "i2"], paid_by="F", participants={"F": ["a"]})]
        setts = [
            {"from_member_id": "i1", "to_member_id": "F", "amount": 299975.0, "status": "paid"},
            {"from_member_id": "i2", "to_member_id": "F", "amount": 299975.0, "status": "paid"},
        ]
        net = compute_net(members, exps, setts)
        rows = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, setts, net)["F"]}
        assert round(sum(rows.values()), 2) == round(net["F"], 2)
        assert all(abs(v) <= 900000.0 for v in rows.values())  # bounded by real amounts
        assert rows["b"] == 0.0  # b held no position; the settlement offsets only the holder (a)

    def test_pending_settlement_not_overlaid_does_not_offset(self):
        # Everyone participates -> the uniform net/size path; passing a (non-overlaid) settlement list
        # leaves the rows identical to the no-settlement rows.
        members = [_fam("F", ["a", "b"]), _ind("i1")]
        exps = [_exp(60.0, ["F", "i1"], paid_by="i1", participants={"F": ["a", "b"]})]
        net = compute_net(members, exps, [])
        rows_no = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, [], net)["F"]}
        rows_set = {r["id"]: r["net"] for r in family_member_breakdown(members, exps, [], net)["F"]}
        assert rows_no == rows_set
