# Pure unit tests for services.calculator.minimize_transfers
# No HTTP, no server, no conftest fixtures - operates only on plain dicts/lists.
from services.calculator import minimize_transfers


class TestMinimizeTransfers:

    def test_empty_net_returns_no_transfers(self):
        assert minimize_transfers({}) == []

    def test_all_zero_net_returns_no_transfers(self):
        assert minimize_transfers({"a": 0.0, "b": 0.0, "c": 0.0}) == []

    def test_single_member_returns_no_transfers(self):
        assert minimize_transfers({"a": 0.0}) == []

    def test_simple_two_party_debt(self):
        net = {"a": -50.0, "b": 50.0}
        assert minimize_transfers(net) == [
            {"from_member_id": "a", "to_member_id": "b", "amount": 50.0}
        ]

    def test_multi_party_minimum_transfers(self):
        # a owes 10, b owes 20; c is owed 5, d is owed 25. Net sums to zero.
        net = {"a": -10.0, "b": -20.0, "c": 5.0, "d": 25.0}
        transfers = minimize_transfers(net)
        assert transfers == [
            {"from_member_id": "b", "to_member_id": "d", "amount": 20.0},
            {"from_member_id": "a", "to_member_id": "d", "amount": 5.0},
            {"from_member_id": "a", "to_member_id": "c", "amount": 5.0},
        ]

    def test_sub_epsilon_residual_does_not_spawn_extra_transfer(self):
        # a owes slightly more than b is owed; the 0.005 residual must be
        # absorbed silently rather than producing a spurious micro-transfer.
        net = {"a": -10.005, "b": 10.0}
        transfers = minimize_transfers(net)
        assert transfers == [
            {"from_member_id": "a", "to_member_id": "b", "amount": 10.0}
        ]

    def test_balances_within_epsilon_are_already_settled(self):
        # Both sides are within the 0.01 threshold of zero - nothing to settle.
        net = {"a": -0.005, "b": 0.005}
        assert minimize_transfers(net) == []

    def test_section5_per_capita_example(self):
        # Section 5: 4 families (sizes 4,4,2,1) + 2 individuals = 13 humans,
        # $130 expense -> C = 10/human. family1 (size 4) paid the full $130,
        # so it is owed back everything except its own $40 share.
        net = {
            "family1": 90.0,   # paid 130, owes 40 -> net +90
            "family2": -40.0,  # size 4 -> owes 40
            "family3": -20.0,  # size 2 -> owes 20
            "family4": -10.0,  # size 1 -> owes 10
            "ind1": -10.0,
            "ind2": -10.0,
        }
        transfers = minimize_transfers(net)
        assert transfers == [
            {"from_member_id": "family2", "to_member_id": "family1", "amount": 40.0},
            {"from_member_id": "family3", "to_member_id": "family1", "amount": 20.0},
            {"from_member_id": "family4", "to_member_id": "family1", "amount": 10.0},
            {"from_member_id": "ind1", "to_member_id": "family1", "amount": 10.0},
            {"from_member_id": "ind2", "to_member_id": "family1", "amount": 10.0},
        ]
        assert sum(t["amount"] for t in transfers) == 90.0
