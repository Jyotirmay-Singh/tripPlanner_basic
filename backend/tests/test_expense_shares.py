# Pure unit tests for services.expense_shares — the DISPLAY-only per-expense participant share
# breakdown. No HTTP / server / DB / conftest fixtures: operates only on plain dicts/lists.
#
# Core safety guarantee under test: the derived per-expense shares EQUAL what the existing
# `services.calculator` allocates (PER_CAPITA *and* PER_FAMILY), honor `weight_snapshots` and
# `family_participants`, and the DISPLAYED 2dp shares sum EXACTLY to the expense amount (and each
# family's member sub-shares sum EXACTLY to that family's shown entity share).
from services.calculator import (
    resolve_weights,
    split_per_capita,
    split_per_family,
)
from services.expense_shares import entity_shares_raw, expense_share_breakdown


def _weight_map(members):
    return {
        m["id"]: (max(1, len(m.get("family_members", []))) if m.get("kind") == "family" else 1)
        for m in members
    }


def _members_5a():
    # Section 5(A): 4 families (sizes 4, 4, 2, 1) + 2 individuals = 13 humans.
    return [
        {"id": "f1", "name": "F1", "kind": "family",
         "family_members": ["A", "B", "C", "D"], "family_member_ids": ["f1a", "f1b", "f1c", "f1d"]},
        {"id": "f2", "name": "F2", "kind": "family",
         "family_members": ["A", "B", "C", "D"], "family_member_ids": ["f2a", "f2b", "f2c", "f2d"]},
        {"id": "f3", "name": "F3", "kind": "family",
         "family_members": ["A", "B"], "family_member_ids": ["f3a", "f3b"]},
        {"id": "f4", "name": "F4", "kind": "family",
         "family_members": ["A"], "family_member_ids": ["f4a"]},
        {"id": "i1", "name": "I1", "kind": "individual", "family_members": []},
        {"id": "i2", "name": "I2", "kind": "individual", "family_members": []},
    ]


def _expense(**over):
    e = {"id": "e1", "amount": 130.0, "category": "Food",
         "split_member_ids": [], "split_mode": "PER_CAPITA", "paid_by_member_id": "i1",
         "weight_snapshots": None, "family_participants": None}
    e.update(over)
    return e


class TestEntitySharesEqualCalculator:
    """The derivation must be byte-identical to services.calculator (no second split impl)."""

    def test_per_capita_equals_split_per_capita(self):
        members = _members_5a()
        e = _expense()
        weights = resolve_weights([m["id"] for m in members], _weight_map(members), None)
        assert entity_shares_raw(e, members) == split_per_capita(130.0, weights)

    def test_per_capita_section5a_values(self):
        members = _members_5a()
        raw = entity_shares_raw(_expense(), members)
        assert raw == {"f1": 40.0, "f2": 40.0, "f3": 20.0, "f4": 10.0, "i1": 10.0, "i2": 10.0}

    def test_per_family_equals_split_per_family(self):
        members = _members_5a()
        e = _expense(amount=120.0, split_mode="PER_FAMILY")
        ids = [m["id"] for m in members]
        assert entity_shares_raw(e, members) == split_per_family(120.0, ids)

    def test_per_family_section5b_values(self):
        members = _members_5a()
        raw = entity_shares_raw(_expense(amount=120.0, split_mode="PER_FAMILY"), members)
        # Flat per entity (6 entities) regardless of family size.
        assert raw == {k: 20.0 for k in ("f1", "f2", "f3", "f4", "i1", "i2")}

    def test_per_capita_honors_weight_snapshots(self):
        members = _members_5a()
        snaps = {"f1": 2}  # partial-family override: count f1 as 2 humans, not 4
        e = _expense(weight_snapshots=snaps)
        weights = resolve_weights([m["id"] for m in members], _weight_map(members), snaps)
        assert entity_shares_raw(e, members) == split_per_capita(130.0, weights)
        # sanity: f1 now weighs 2, so total humans drops 13 -> 11.
        assert sum(weights.values()) == 11

    def test_per_family_ignores_weight_snapshots(self):
        members = _members_5a()
        a = entity_shares_raw(_expense(amount=120.0, split_mode="PER_FAMILY", weight_snapshots={"f1": 99}), members)
        b = entity_shares_raw(_expense(amount=120.0, split_mode="PER_FAMILY"), members)
        assert a == b

    def test_subset_split_member_ids(self):
        members = _members_5a()
        e = _expense(amount=90.0, split_member_ids=["f3", "i1", "i2"])  # 2 + 1 + 1 = 4 humans
        weights = resolve_weights(["f3", "i1", "i2"], _weight_map(members), None)
        assert entity_shares_raw(e, members) == split_per_capita(90.0, weights)


class TestDisplaySumsExactly:

    def test_entity_shares_sum_to_amount(self):
        members = _members_5a()
        bd = expense_share_breakdown(_expense(), members)
        total = sum(ent["share"] for ent in bd["entities"])
        assert round(total, 2) == 130.0

    def test_non_divisible_amount_sums_exactly(self):
        members = [
            {"id": "i1", "name": "I1", "kind": "individual", "family_members": []},
            {"id": "i2", "name": "I2", "kind": "individual", "family_members": []},
            {"id": "i3", "name": "I3", "kind": "individual", "family_members": []},
        ]
        bd = expense_share_breakdown(_expense(amount=100.0, paid_by_member_id="i1"), members)
        shares = sorted(ent["share"] for ent in bd["entities"])
        assert sum(shares) == 100.0
        # 100/3 -> two 33.33 and one 33.34 (largest-remainder)
        assert shares == [33.33, 33.33, 33.34]

    def test_family_sub_shares_sum_to_entity_share(self):
        members = _members_5a()
        bd = expense_share_breakdown(_expense(), members)
        for ent in bd["entities"]:
            if ent["members"]:
                assert round(sum(s["share"] for s in ent["members"]), 2) == ent["share"]


class TestFamilyParticipantsRedistribution:

    def test_excluded_member_owes_zero_involved_count_weight(self):
        members = _members_5a()
        # f1: only 2 of its 4 members took part. PER_CAPITA now counts f1 as its INVOLVED count (2)
        # per CLAUDE.md §5-A, so H = 2 + 4 + 2 + 1 + 1 + 1 = 11. With $110 -> per-human 10, f1 owes
        # 20 (not 40); the 20 is split between the 2 participants (10 each); the other 2 show 0.
        e = _expense(amount=110.0, family_participants={"f1": ["f1a", "f1b"]})
        assert entity_shares_raw(e, members)["f1"] == 20.0   # involved count 2 * per-human 10
        bd = expense_share_breakdown(e, members)
        f1 = next(ent for ent in bd["entities"] if ent["id"] == "f1")
        sub = {s["id"]: s["share"] for s in f1["members"]}
        assert sub["f1a"] == 10.0 and sub["f1b"] == 10.0
        assert sub["f1c"] == 0.0 and sub["f1d"] == 0.0
        assert round(sum(sub.values()), 2) == f1["share"] == 20.0

    def test_no_restriction_splits_evenly(self):
        members = _members_5a()
        bd = expense_share_breakdown(_expense(), members)
        f1 = next(ent for ent in bd["entities"] if ent["id"] == "f1")
        assert all(s["share"] == 10.0 for s in f1["members"])  # 40 / 4

    def test_per_family_participation_redistributes_flat_share(self):
        members = _members_5a()
        # PER_FAMILY: f1 owes a flat 20 (120/6); split among 2 participants -> 10 each, others 0.
        e = _expense(amount=120.0, split_mode="PER_FAMILY",
                     family_participants={"f1": ["f1a", "f1b"]})
        bd = expense_share_breakdown(e, members)
        f1 = next(ent for ent in bd["entities"] if ent["id"] == "f1")
        sub = {s["id"]: s["share"] for s in f1["members"]}
        assert f1["share"] == 20.0
        assert sub["f1a"] == 10.0 and sub["f1b"] == 10.0
        assert sub["f1c"] == 0.0 and sub["f1d"] == 0.0


class TestBreakdownShape:

    def test_payer_flagged(self):
        members = _members_5a()
        bd = expense_share_breakdown(_expense(), members)
        payer = [ent for ent in bd["entities"] if ent["is_payer"]]
        assert len(payer) == 1 and payer[0]["id"] == "i1"
        assert bd["payer_id"] == "i1"

    def test_individual_has_no_member_sub_rows(self):
        members = _members_5a()
        bd = expense_share_breakdown(_expense(), members)
        i1 = next(ent for ent in bd["entities"] if ent["id"] == "i1")
        assert i1["members"] == []

    def test_names_are_disambiguated_display_labels(self):
        members = _members_5a()
        bd = expense_share_breakdown(_expense(), members)
        f1 = next(ent for ent in bd["entities"] if ent["id"] == "f1")
        assert [s["name"] for s in f1["members"]] == ["A", "B", "C", "D"]

    def test_negative_amount_mirrors_into_negative_shares(self):
        # A negative amount (money back) is split by the SAME calculator into negative display shares
        # that sum exactly to the negative total. The `kind` concept is gone (no such output key).
        members = _members_5a()
        bd = expense_share_breakdown(_expense(amount=-130.0), members)
        assert "kind" not in bd
        assert round(sum(ent["share"] for ent in bd["entities"]), 2) == -130.0
        assert all(ent["share"] <= 0 for ent in bd["entities"])

    def test_mode_carried_through(self):
        members = _members_5a()
        assert expense_share_breakdown(_expense(), members)["mode"] == "PER_CAPITA"
        assert expense_share_breakdown(_expense(split_mode="PER_FAMILY"), members)["mode"] == "PER_FAMILY"

    def test_nothing_to_split_returns_empty_entities(self):
        # No members at all -> H <= 0 -> calculator returns {} -> breakdown has no entities (matches
        # the ledger, which skips such an expense).
        bd = expense_share_breakdown(_expense(), [])
        assert bd["entities"] == []
