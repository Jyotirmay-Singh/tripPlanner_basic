# Pure unit tests for services.reallocation.plan_reallocation (Step 8).
# No HTTP, no server, no conftest fixtures - operates only on plain dicts/lists.
from services.reallocation import plan_reallocation


def _exp(eid, split_ids, mode="PER_CAPITA", snaps=None, frozen=None):
    return {
        "id": eid,
        "split_mode": mode,
        "split_member_ids": split_ids,
        "weight_snapshots": snaps,
        "weight_frozen": frozen,
    }


class TestNoOp:

    def test_old_equals_new_is_empty_plan(self):
        # Name/email-only edit (weight unchanged) must not touch any expense.
        exps = [_exp("e1", ["fam", "ind"])]
        plan = plan_reallocation("fam", 3, 3, reweight_past=False, expenses=exps)
        assert plan == {"updates": [], "set_count": 0, "unset_count": 0}

    def test_old_equals_new_retroactive_also_empty(self):
        exps = [_exp("e1", ["fam"], snaps={"fam": 2}, frozen=["fam"])]
        plan = plan_reallocation("fam", 2, 2, reweight_past=True, expenses=exps)
        assert plan["updates"] == [] and plan["set_count"] == 0 and plan["unset_count"] == 0


class TestFreezePast:  # reweight_past=False

    def test_pins_old_weight_and_marks_frozen(self):
        exps = [_exp("e1", ["fam", "ind"])]  # no existing pin
        plan = plan_reallocation("fam", 2, 4, reweight_past=False, expenses=exps)
        assert plan["set_count"] == 1 and plan["unset_count"] == 0
        (u,) = plan["updates"]
        assert u["expense_id"] == "e1" and u["op"] == "set"
        assert u["weight_snapshots"] == {"fam": 2}
        assert u["weight_frozen"] == ["fam"]

    def test_preserves_existing_partial_override(self):
        # Partial-family override pin present, member NOT in weight_frozen -> never overwrite.
        exps = [_exp("e1", ["fam", "ind"], snaps={"fam": 1}, frozen=None)]
        plan = plan_reallocation("fam", 2, 4, reweight_past=False, expenses=exps)
        assert plan["updates"] == [] and plan["set_count"] == 0

    def test_skips_already_frozen_pin(self):
        exps = [_exp("e1", ["fam"], snaps={"fam": 2}, frozen=["fam"])]
        plan = plan_reallocation("fam", 2, 5, reweight_past=False, expenses=exps)
        assert plan["updates"] == [] and plan["set_count"] == 0

    def test_freeze_keeps_other_members_pins(self):
        # Freezing fam must not disturb another member's existing override on the same expense.
        exps = [_exp("e1", ["fam", "ind"], snaps={"ind": 1}, frozen=None)]
        plan = plan_reallocation("fam", 3, 4, reweight_past=False, expenses=exps)
        (u,) = plan["updates"]
        assert u["weight_snapshots"] == {"ind": 1, "fam": 3}
        assert u["weight_frozen"] == ["fam"]


class TestRecalculatePast:  # reweight_past=True

    def test_unsets_frozen_pin(self):
        exps = [_exp("e1", ["fam", "ind"], snaps={"fam": 2}, frozen=["fam"])]
        plan = plan_reallocation("fam", 2, 4, reweight_past=True, expenses=exps)
        assert plan["set_count"] == 0 and plan["unset_count"] == 1
        (u,) = plan["updates"]
        assert u["op"] == "unset"
        assert u["weight_snapshots"] is None  # empty map normalized to None
        assert u["weight_frozen"] is None     # empty list normalized to None

    def test_preserves_partial_override(self):
        # Pin present but NOT in weight_frozen -> a partial-family override -> must survive.
        exps = [_exp("e1", ["fam", "ind"], snaps={"fam": 1}, frozen=None)]
        plan = plan_reallocation("fam", 2, 4, reweight_past=True, expenses=exps)
        assert plan["updates"] == [] and plan["unset_count"] == 0

    def test_noop_when_no_pin(self):
        exps = [_exp("e1", ["fam", "ind"])]
        plan = plan_reallocation("fam", 2, 4, reweight_past=True, expenses=exps)
        assert plan["updates"] == []

    def test_unset_keeps_other_members_pins(self):
        exps = [_exp("e1", ["fam", "ind"], snaps={"fam": 2, "ind": 1}, frozen=["fam"])]
        plan = plan_reallocation("fam", 2, 4, reweight_past=True, expenses=exps)
        (u,) = plan["updates"]
        assert u["weight_snapshots"] == {"ind": 1}  # only fam removed
        assert u["weight_frozen"] is None

    def test_defensive_dangling_frozen_marker_without_pin(self):
        # member in weight_frozen but missing from weight_snapshots -> clean the marker, no crash.
        exps = [_exp("e1", ["fam"], snaps=None, frozen=["fam"])]
        plan = plan_reallocation("fam", 2, 4, reweight_past=True, expenses=exps)
        (u,) = plan["updates"]
        assert u["op"] == "unset"
        assert u["weight_snapshots"] is None and u["weight_frozen"] is None


class TestPerFamilyIgnored:

    def test_per_family_never_in_plan_freeze(self):
        exps = [_exp("e1", ["fam", "ind"], mode="PER_FAMILY")]
        plan = plan_reallocation("fam", 2, 4, reweight_past=False, expenses=exps)
        assert plan["updates"] == []

    def test_per_family_never_in_plan_retroactive_even_if_frozen(self):
        # Even a stray frozen pin on a PER_FAMILY expense is left alone (math ignores it anyway).
        exps = [_exp("e1", ["fam"], mode="PER_FAMILY", snaps={"fam": 2}, frozen=["fam"])]
        plan = plan_reallocation("fam", 2, 4, reweight_past=True, expenses=exps)
        assert plan["updates"] == []

    def test_missing_split_mode_treated_as_per_capita(self):
        e = {"id": "e1", "split_member_ids": ["fam"], "weight_snapshots": None}  # no split_mode key
        plan = plan_reallocation("fam", 2, 4, reweight_past=False, expenses=[e])
        assert plan["set_count"] == 1


class TestParticipantFiltering:

    def test_excluded_when_absent_from_nonempty_split(self):
        exps = [_exp("e1", ["other", "ind"])]
        plan = plan_reallocation("fam", 2, 4, reweight_past=False, expenses=exps)
        assert plan["updates"] == []

    def test_included_when_split_among_all_empty(self):
        exps = [_exp("e1", [])]  # split among all -> fam participates
        plan = plan_reallocation("fam", 2, 4, reweight_past=False, expenses=exps)
        assert plan["set_count"] == 1
        assert plan["updates"][0]["weight_snapshots"] == {"fam": 2}

    def test_included_when_split_among_all_none(self):
        exps = [_exp("e1", None)]
        plan = plan_reallocation("fam", 2, 4, reweight_past=False, expenses=exps)
        assert plan["set_count"] == 1


class TestCountsAndMixedBatch:

    def test_counts_match_emitted_ops(self):
        exps = [
            _exp("e1", ["fam", "ind"]),                                  # freeze -> set
            _exp("e2", ["fam"], snaps={"fam": 1}),                       # partial override -> skip
            _exp("e3", ["fam"], mode="PER_FAMILY"),                      # per-family -> skip
            _exp("e4", ["other"]),                                       # non-participant -> skip
        ]
        plan = plan_reallocation("fam", 3, 5, reweight_past=False, expenses=exps)
        assert plan["set_count"] == 1 and plan["unset_count"] == 0
        assert len(plan["updates"]) == 1 and plan["updates"][0]["expense_id"] == "e1"
