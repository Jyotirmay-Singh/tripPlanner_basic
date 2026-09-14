"""BREAK-IT-ALL QA campaign — pure Settle-Up engine probes (no server / DB needed).

Exercises the conserving compatibility entry point (services.calculator.minimize_transfers) and the
pure per-pair payment roll-up (services.payments) against adversarial inputs: exact ±0.01 residuals,
cyclic debt, large fan-outs, and unit-snapping leaks. Mirrors the style of test_calculator.py /
test_payments_rollup.py.

Tests carrying a ``FINDING`` comment DOCUMENT a suspected imprecision — they assert the OBSERVED
behavior (so the run stays green) while the comment/name surface the defect for the report.
"""
import pytest

from services.calculator import minimize_transfers
from services.settlement_engine import SettlementLedgerError
from services.payments import pair_blocks, payment_status


def _sum_transfers(transfers):
    return sum(t["amount"] for t in transfers)


def _positive_net(net):
    return sum(v for v in net.values() if v > 0)


class TestWholeUnitTermination:
    """Whole-unit projection resolves cleanly at and below the legal unit boundary."""

    def test_exact_one_unit_residual_is_settled(self):
        assert minimize_transfers({"a": -1, "b": 1}) == [
            {"from_member_id": "a", "to_member_id": "b", "amount": 1}
        ]

    def test_below_half_a_unit_rounds_to_no_transfer(self):
        assert minimize_transfers({"a": -0.49, "b": 0.49}) == []

    def test_half_unit_ledger_imbalance_is_rejected(self):
        with pytest.raises(SettlementLedgerError, match="imbalanced"):
            minimize_transfers({"a": -10.5, "b": 10.0})

    def test_pathological_many_unit_values_terminate(self):
        net = {}
        for i in range(50):
            net[f"d{i}"] = -1
            net[f"c{i}"] = 1
        transfers = minimize_transfers(net)  # must simply RETURN
        assert len(transfers) == 50
        assert _sum_transfers(transfers) == 50


class TestCyclicDebt:
    """Hypothesis: minimize_transfers works on NET balances, so cycles auto-flatten."""

    def test_perfect_cycle_nets_to_nothing(self):
        # A owes B, B owes C, C owes A, all equal -> every net is 0 -> zero transfers.
        assert minimize_transfers({"A": 0.0, "B": 0.0, "C": 0.0}) == []

    def test_imperfect_cycle_flattens_to_minimum(self):
        # A ends up the sole net debtor (-30), B/C net creditors (+15 each): 2 transfers, not 3.
        transfers = minimize_transfers({"A": -30.0, "B": 15.0, "C": 15.0})
        assert len(transfers) == 2
        assert all(t["from_member_id"] == "A" for t in transfers)
        assert _sum_transfers(transfers) == 30.0

    def test_four_node_cycle_with_residual(self):
        net = {"A": -100.0, "B": -50.0, "C": 90.0, "D": 60.0}
        transfers = minimize_transfers(net)
        # Any conserving route for 2 debtors / 2 creditors needs at most 3 transfers.
        assert len(transfers) <= 3
        assert _sum_transfers(transfers) == 150.0


class TestReconciliation:
    def test_large_fanout_reconciles(self):
        net = {"whale": 300.0}
        for i in range(30):
            net[f"m{i}"] = -10.0
        transfers = minimize_transfers(net)
        assert _sum_transfers(transfers) == 300.0
        assert all(t["to_member_id"] == "whale" for t in transfers)

    def test_whole_thirds_reconcile_exactly(self):
        net = {"a": -67, "b": 33, "c": 34}
        transfers = minimize_transfers(net)
        assert _sum_transfers(transfers) == _positive_net(net) == 67

    def test_balanced_ledger_reconciles_to_the_cent(self):
    # A balanced whole-unit ledger reconciles exactly; routing never loses money to float drift.
        net = {"a": -100.00, "b": 33.33, "c": 33.33, "d": 33.34}
        transfers = minimize_transfers(net)
        assert _sum_transfers(transfers) == _positive_net(net) == 100.00

    def test_legacy_precise_thirds_are_jointly_rounded_without_a_residual(self):
        # The precise vector sums to zero even though independently rounded member values would not.
        net = {"a": -10, "b": 3.333333, "c": 3.333333, "d": 3.333334}
        transfers = minimize_transfers(net)
        assert _sum_transfers(transfers) == 10


class TestPaymentRollupBoundaries:
    """Payment status ignores only less than one legal currency unit (mirrors frontend)."""

    def test_status_boundary_exactly_at_eps(self):
        assert payment_status(0.49, 100.0) == "paid"
        assert payment_status(0.5, 100.0) == "partial"
        assert payment_status(100.0, 0.49) == "open"
        assert payment_status(100.0, 0.5) == "partial"

    def test_original_payable_is_current_plus_paid(self):
        transfers = [{"from_member_id": "x", "to_member_id": "y", "amount": 40.0}]
        payments = [{"from_member_id": "x", "to_member_id": "y", "amount": 60.0,
                     "created_at": "2026-07-01T10:00:00+00:00"}]
        blk = pair_blocks(transfers, payments)[0]
        assert blk["status"] == "partial"
        assert blk["paid"] == 60.0
        assert blk["current_payable"] == 40.0
        assert blk["original_payable"] == 100.0

    def test_settled_only_direction_and_paid_sum_reconciles(self):
        transfers = [{"from_member_id": "g", "to_member_id": "y", "amount": 20.0}]
        payments = [
            {"from_member_id": "x", "to_member_id": "y", "amount": 30.0, "created_at": "2026-07-02"},
            {"from_member_id": "x", "to_member_id": "y", "amount": 20.0, "created_at": "2026-07-03"},
        ]
        blocks = pair_blocks(transfers, payments)
        assert len(blocks) == 2
        settled = blocks[1]
        assert (settled["from_member_id"], settled["to_member_id"]) == ("x", "y")
        assert settled["status"] == "paid" and settled["current_payable"] == 0.0
        assert settled["paid"] == 50.0
        assert [p["amount"] for p in settled["payments"]] == [20.0, 30.0]  # newest-first
        assert round(sum(b["paid"] for b in blocks), 2) == round(sum(p["amount"] for p in payments), 2)
