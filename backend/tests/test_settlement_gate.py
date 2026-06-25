"""Pure unit tests for utils.settlement_gate (no server / DB needed).

These exercise the gate over synthetic ``_compute_balances``-shaped dicts, exactly the way
test_calculator.py exercises the math helpers.
"""
from utils.settlement_gate import (
    SETTLED_EPS,
    is_settled,
    entity_net,
    family_rows,
    family_member_net,
    unsettled_family_members,
)


def _balances():
    return {
        "net": {"ind": 0.0, "owes": -50.0, "owed": 50.0, "fam": 0.0, "famX": 10.0},
        "per_person": [
            {"member_id": "ind", "members": []},
            {"member_id": "fam", "members": [
                {"id": "a", "name": "Alice", "net": 0.0},
                {"id": "b", "name": "Bob", "net": 0.0},
            ]},
            {"member_id": "famX", "members": [
                {"id": "x", "name": "Xeni", "net": 10.0},
                {"id": "y", "name": "Yann", "net": 0.0},
            ]},
        ],
    }


class TestIsSettled:
    def test_exact_zero_is_settled(self):
        assert is_settled(0.0)

    def test_negative_zero_is_settled(self):
        assert is_settled(-0.0)

    def test_below_epsilon_is_settled(self):
        assert is_settled(SETTLED_EPS / 2)
        assert is_settled(-SETTLED_EPS / 2)

    def test_at_or_above_epsilon_is_not_settled(self):
        assert not is_settled(SETTLED_EPS)
        assert not is_settled(0.01)
        assert not is_settled(-0.01)


class TestEntityNet:
    def test_known_ids(self):
        b = _balances()
        assert entity_net(b, "owes") == -50.0
        assert entity_net(b, "owed") == 50.0

    def test_unknown_id_defaults_zero(self):
        assert entity_net(_balances(), "ghost") == 0.0

    def test_missing_net_key_defaults_zero(self):
        assert entity_net({}, "anything") == 0.0


class TestFamilyRows:
    def test_returns_breakdown_rows(self):
        rows = family_rows(_balances(), "fam")
        assert [r["name"] for r in rows] == ["Alice", "Bob"]

    def test_unknown_family_returns_empty(self):
        assert family_rows(_balances(), "nope") == []

    def test_individual_member_has_no_rows(self):
        assert family_rows(_balances(), "ind") == []


class TestFamilyMemberNet:
    def test_existing_member(self):
        assert family_member_net(_balances(), "famX", "x") == 10.0

    def test_settled_member(self):
        assert family_member_net(_balances(), "famX", "y") == 0.0

    def test_missing_member_returns_none(self):
        assert family_member_net(_balances(), "famX", "zzz") is None

    def test_missing_family_returns_none(self):
        assert family_member_net(_balances(), "ghost", "x") is None


class TestUnsettledFamilyMembers:
    def test_fully_settled_family_has_no_blockers(self):
        assert unsettled_family_members(_balances(), "fam") == []

    def test_partially_settled_family_lists_only_unsettled(self):
        rows = unsettled_family_members(_balances(), "famX")
        assert [r["name"] for r in rows] == ["Xeni"]

    def test_unknown_family_has_no_blockers(self):
        assert unsettled_family_members(_balances(), "nope") == []
