# Pure unit tests for services.calculator per-capita math (Step 6).
# No HTTP, no server, no conftest fixtures - operates only on plain dicts/lists.
from services.calculator import resolve_weights, split_per_capita


class TestSplitPerCapita:

    def test_section5_per_capita_example(self):
        # Section 5(A): 4 families (sizes 4,4,2,1) + 2 individuals = 13 humans,
        # a 130 expense -> C = 10 per human.
        weights = {"f1": 4, "f2": 4, "f3": 2, "f4": 1, "i1": 1, "i2": 1}
        shares = split_per_capita(130.0, weights)
        assert shares == {
            "f1": 40.0, "f2": 40.0, "f3": 20.0, "f4": 10.0, "i1": 10.0, "i2": 10.0,
        }
        assert sum(shares.values()) == 130.0

    def test_empty_weights_returns_empty(self):
        assert split_per_capita(100.0, {}) == {}

    def test_all_zero_weights_returns_empty(self):
        # H = 0 -> nothing to split (caller skips the expense).
        assert split_per_capita(100.0, {"a": 0, "b": 0}) == {}

    def test_negative_total_weight_returns_empty(self):
        # H <= 0 guard.
        assert split_per_capita(100.0, {"a": -1}) == {}

    def test_single_individual_owes_full_amount(self):
        assert split_per_capita(100.0, {"a": 1}) == {"a": 100.0}

    def test_non_divisible_remainder_no_intermediate_rounding(self):
        # 100 / 3 humans: shares are exact floats, sum back to amount within epsilon.
        weights = {"a": 1, "b": 1, "c": 1}
        shares = split_per_capita(100.0, weights)
        assert abs(sum(shares.values()) - 100.0) < 1e-9
        for v in shares.values():
            assert abs(v - (100.0 / 3)) < 1e-12  # no rounding applied

    def test_family_weight_scales_share(self):
        # A family of 3 owes 3x an individual's per-human share.
        shares = split_per_capita(120.0, {"fam": 3, "ind": 1})
        assert shares == {"fam": 90.0, "ind": 30.0}


class TestResolveWeights:

    def test_base_weights_used_when_no_snapshot(self):
        assert resolve_weights(["fam", "ind"], {"fam": 4, "ind": 1}) == {"fam": 4, "ind": 1}

    def test_snapshot_override_wins(self):
        # Partial-family / Step 8 snapshot overrides the live base weight.
        assert resolve_weights(["fam"], {"fam": 4}, {"fam": 2}) == {"fam": 2}

    def test_unknown_id_defaults_to_one(self):
        assert resolve_weights(["ghost"], {}) == {"ghost": 1}

    def test_empty_split_ids_returns_empty(self):
        # Boundary for the caller-side "split among all members" expansion.
        assert resolve_weights([], {"fam": 4, "ind": 1}) == {}

    def test_snapshot_value_coerced_to_int(self):
        assert resolve_weights(["fam"], {"fam": 4}, {"fam": "3"}) == {"fam": 3}

    def test_resolve_then_split_section5(self):
        # End-to-end through both functions: resolve weights, then per-capita split.
        base = {"f1": 4, "f2": 4, "f3": 2, "f4": 1, "i1": 1, "i2": 1}
        weights = resolve_weights(list(base.keys()), base)
        shares = split_per_capita(130.0, weights)
        assert shares["f1"] == 40.0 and shares["i1"] == 10.0
        assert sum(shares.values()) == 130.0
