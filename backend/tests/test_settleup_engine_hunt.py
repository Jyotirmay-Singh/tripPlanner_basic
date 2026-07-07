"""BREAK-IT-ALL QA campaign — pure Settle-Up engine probes (no server / DB needed).

Exercises the greedy engine (services.calculator.minimize_transfers) and the pure per-pair
payment roll-up (services.payments) against adversarial inputs: exact ±0.01 residuals, cyclic
debt, large fan-outs, and cent-snapping leaks. Mirrors the style of test_calculator.py /
test_payments_rollup.py.

Tests carrying a ``FINDING`` comment DOCUMENT a suspected imprecision — they assert the OBSERVED
behavior (so the run stays green) while the comment/name surface the defect for the report.
"""
from services.calculator import minimize_transfers
from services.payments import pair_blocks, payment_status


def _sum_transfers(transfers):
    return round(sum(t["amount"] for t in transfers), 2)


def _positive_net(net):
    return round(sum(v for v in net.values() if v > 0), 2)


class TestCentSnapTermination:
    """Hypothesis 6: the greedy loop must resolve cleanly (never hang) around the 0.01 threshold."""

    def test_exact_one_cent_residual_is_dropped_not_looped(self):
        # A ±0.01 imbalance sits ON the strict filter boundary (< -0.01 / > 0.01), so BOTH members
        # are excluded and the cent silently vanishes. The important invariant: it returns (no hang).
        assert minimize_transfers({"a": -0.01, "b": 0.01}) == []

    def test_just_beyond_one_cent_produces_a_transfer(self):
        assert minimize_transfers({"a": -0.02, "b": 0.02}) == [
            {"from_member_id": "a", "to_member_id": "b", "amount": 0.02}
        ]

    def test_half_cent_residual_absorbed_silently(self):
        # -10.005 vs +10.0: 0.005 leftover on the debtor must not spawn a spurious micro-transfer.
        transfers = minimize_transfers({"a": -10.005, "b": 10.0})
        assert transfers == [{"from_member_id": "a", "to_member_id": "b", "amount": 10.0}]

    def test_pathological_many_tiny_values_terminate(self):
        # 50 debtors of -0.03 and 50 creditors of +0.03 — proves the pointer always advances
        # (no infinite loop) even with hundreds of sub-cent-adjacent settlements.
        net = {}
        for i in range(50):
            net[f"d{i}"] = -0.03
            net[f"c{i}"] = 0.03
        transfers = minimize_transfers(net)  # must simply RETURN
        assert len(transfers) == 50
        assert _sum_transfers(transfers) == 1.50


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
        # greedy optimum for 2 debtors / 2 creditors is at most 3 transfers
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

    def test_thirds_reconcile_at_two_dp(self):
        net = {"a": -66.67, "b": 33.33, "c": 33.34}
        transfers = minimize_transfers(net)
        assert _sum_transfers(transfers) == _positive_net(net) == 66.67

    def test_balanced_ledger_reconciles_to_the_cent(self):
        # Post-fix guarantee (integer-cents greedy, BUG-6): for a BALANCED 2dp ledger the suggested
        # transfers reconcile EXACTLY to the total owed -- the debtor is never under-collected by
        # float drift inside the loop.
        net = {"a": -100.00, "b": 33.33, "c": 33.33, "d": 33.34}
        transfers = minimize_transfers(net)
        assert _sum_transfers(transfers) == _positive_net(net) == 100.00

    def test_imbalanced_input_residual_is_upstream_not_a_loop_leak(self):
        # When the net itself does NOT sum to 0 at cent granularity (an artifact of _compute_balances
        # rounding each member independently), one cent stays undistributed. That residual is UPSTREAM
        # of minimize_transfers -- the greedy loop still neither invents nor drops money beyond it.
        net = {"a": -0.10, "b": 0.033333, "c": 0.033333, "d": 0.033334}  # cents: -10 vs 3+3+3 = 9
        transfers = minimize_transfers(net)
        assert _sum_transfers(transfers) == 0.09  # exactly the 9 reconcilable cents


class TestPaymentRollupBoundaries:
    """services.payments.pair_blocks / payment_status at the _EPS boundary (mirrors frontend)."""

    def test_status_boundary_exactly_at_eps(self):
        assert payment_status(0.01, 100.0) == "paid"       # residual == _EPS -> considered cleared
        assert payment_status(0.0101, 100.0) == "partial"  # a hair above -> still owing
        assert payment_status(100.0, 0.01) == "open"       # paid == _EPS -> nothing counted yet

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
