# Pure unit tests for services.calculator per-family math (Step 7).
# No HTTP, no server, no conftest fixtures - operates only on plain dicts/lists.
from services.calculator import split_per_capita, split_per_family


class TestSplitPerFamily:

    def test_section5b_example(self):
        # Section 5(B): 4 families + 2 individuals = 6 entities, a 120 expense
        # -> C = 20 per entity, FLAT regardless of family size.
        ids = ["f1", "f2", "f3", "f4", "i1", "i2"]
        shares = split_per_family(120.0, ids)
        assert shares == {
            "f1": 20.0, "f2": 20.0, "f3": 20.0, "f4": 20.0, "i1": 20.0, "i2": 20.0,
        }
        assert sum(shares.values()) == 120.0

    def test_family_size_ignored_vs_per_capita(self):
        # Same selection: per-capita charges by family size (unequal); per-family
        # charges a flat per-entity share (equal). Proves size has no effect here.
        per_capita = split_per_capita(100.0, {"fam": 5, "ind": 1})
        assert abs(per_capita["fam"] - (100.0 * 5 / 6)) < 1e-12
        assert abs(per_capita["ind"] - (100.0 * 1 / 6)) < 1e-12
        assert per_capita["fam"] != per_capita["ind"]

        per_family = split_per_family(100.0, ["fam", "ind"])
        assert per_family == {"fam": 50.0, "ind": 50.0}

    def test_empty_member_ids_returns_empty(self):
        assert split_per_family(100.0, []) == {}

    def test_single_entity_owes_full_amount(self):
        assert split_per_family(100.0, ["a"]) == {"a": 100.0}

    def test_non_divisible_remainder_no_intermediate_rounding(self):
        # 100 / 3 entities: shares are exact floats, sum back to amount within epsilon.
        shares = split_per_family(100.0, ["a", "b", "c"])
        assert abs(sum(shares.values()) - 100.0) < 1e-9
        for v in shares.values():
            assert abs(v - (100.0 / 3)) < 1e-12  # no rounding applied

    def test_duplicate_ids_collapse_to_one_entity(self):
        # A repeated id counts once: E = 2, single result entry per id.
        shares = split_per_family(90.0, ["a", "b", "a"])
        assert shares == {"a": 45.0, "b": 45.0}

    def test_two_entities_split_evenly(self):
        assert split_per_family(120.0, ["fam", "ind"]) == {"fam": 60.0, "ind": 60.0}
