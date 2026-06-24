# Pure unit tests for utils.display_names (duplicate-name disambiguation, display-only).
# No HTTP, no server, no conftest fixtures — operates only on plain dicts/lists, exactly like
# test_report_builder.py / test_per_capita.py. Mirror of frontend/src/__tests__/displayNames.test.ts.
from utils.display_names import member_display_names, family_member_display_names


def _ind(mid, name):
    return {"id": mid, "name": name, "kind": "individual", "family_members": []}


def _fam(mid, name, roster):
    return {"id": mid, "name": name, "kind": "family", "family_members": list(roster)}


# ---------------- Rule (a): duplicate standalone individuals ----------------
class TestRuleA:
    def test_three_duplicates_suffixed_unique_stays(self):
        members = [_ind("1", "Ravi"), _ind("2", "Ravi"), _ind("3", "Ravi"), _ind("4", "Priya")]
        labels = member_display_names(members)
        assert labels == {"1": "Ravi_1", "2": "Ravi_2", "3": "Ravi_3", "4": "Priya"}

    def test_single_individual_not_suffixed(self):
        assert member_display_names([_ind("1", "Ravi")]) == {"1": "Ravi"}

    def test_suffix_follows_array_order(self):
        # Reverse insertion order -> the suffix numbering follows the array, deterministically.
        members = [_ind("b", "Ravi"), _ind("a", "Ravi")]
        labels = member_display_names(members)
        assert labels == {"b": "Ravi_1", "a": "Ravi_2"}


# ---------------- Rule (b): individuals vs family roster are separate scopes ----------------
class TestRuleB:
    def test_lone_individual_and_family_roster_both_plain(self):
        # One individual "Ravi" + a family whose roster also has a unique "Ravi" -> both stay plain.
        fam = _fam("f", "Sharma", ["Ravi", "Priya"])
        members = [_ind("i", "Ravi"), fam]
        assert member_display_names(members)["i"] == "Ravi"
        assert family_member_display_names(fam) == ["Ravi", "Priya"]

    def test_two_individuals_suffixed_family_roster_untouched(self):
        fam = _fam("f", "Sharma", ["Ravi"])
        members = [_ind("i1", "Ravi"), _ind("i2", "Ravi"), fam]
        labels = member_display_names(members)
        assert labels["i1"] == "Ravi_1"
        assert labels["i2"] == "Ravi_2"
        assert family_member_display_names(fam) == ["Ravi"]  # unique within its family


# ---------------- Rule (c): duplicates within one family roster ----------------
class TestRuleC:
    def test_family_roster_duplicates_suffixed_with_stripped_family_name(self):
        fam = _fam("f", "The Sharmas", ["Ravi", "Ravi", "Priya"])
        assert family_member_display_names(fam) == ["Ravi_TheSharmas_1", "Ravi_TheSharmas_2", "Priya"]

    def test_empty_roster(self):
        assert family_member_display_names(_fam("f", "Sharma", [])) == []


# ---------------- Decision: families follow the same protocol as individuals ----------------
class TestFamilyDecision:
    def test_two_families_same_name_suffixed(self):
        members = [_fam("a", "Sharma", ["X"]), _fam("b", "Sharma", ["Y"])]
        assert member_display_names(members) == {"a": "Sharma_1", "b": "Sharma_2"}

    def test_individual_and_family_share_top_level_scope(self):
        members = [_ind("i", "Sharma"), _fam("f", "Sharma", ["X"])]
        assert member_display_names(members) == {"i": "Sharma_1", "f": "Sharma_2"}


# ---------------- Edge cases ----------------
class TestEdges:
    def test_empty_members(self):
        assert member_display_names([]) == {}

    def test_case_and_whitespace_insensitive_collision_keeps_own_base(self):
        # "Ravi" and "ravi " collide (normalized + lowercased); each keeps its own typed base.
        members = [_ind("1", "Ravi"), _ind("2", "ravi ")]
        assert member_display_names(members) == {"1": "Ravi_1", "2": "ravi_2"}

    def test_typed_number_is_a_distinct_base_no_double_suffix(self):
        # A literal "Ravi 2" is a different normalized name from "Ravi"; neither is suffixed.
        members = [_ind("1", "Ravi"), _ind("2", "Ravi 2")]
        assert member_display_names(members) == {"1": "Ravi", "2": "Ravi 2"}

    def test_internal_whitespace_collapsed_for_base(self):
        # normalize_name collapses internal whitespace in the displayed base.
        assert member_display_names([_ind("1", "Ravi   Kumar")]) == {"1": "Ravi Kumar"}
