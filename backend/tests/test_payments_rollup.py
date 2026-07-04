"""Pure unit tests for services.payments (no server / DB needed).

Exercises the per-pair payment roll-up + derived status over synthetic transfer/payment lists,
exactly the way test_settlement_gate.py / test_calculator.py exercise the pure helpers.
"""
from services.payments import pair_blocks, payment_status
from utils.permissions import can_record_payment


class TestPaymentStatus:
    def test_open_when_nothing_paid(self):
        assert payment_status(100.0, 0.0) == "open"

    def test_partial_when_some_paid_some_left(self):
        assert payment_status(60.0, 40.0) == "partial"

    def test_paid_when_residual_cleared(self):
        assert payment_status(0.0, 100.0) == "paid"

    def test_below_epsilon_residual_counts_as_paid(self):
        assert payment_status(0.005, 100.0) == "paid"

    def test_tiny_payment_is_still_open(self):
        assert payment_status(100.0, 0.005) == "open"


class TestPairBlocks:
    def test_open_pair_has_no_payments(self):
        transfers = [{"from_member_id": "a", "to_member_id": "b", "amount": 100.0}]
        blocks = pair_blocks(transfers, [])
        assert len(blocks) == 1
        blk = blocks[0]
        assert blk["status"] == "open"
        assert blk["paid"] == 0.0
        assert blk["current_payable"] == 100.0
        assert blk["original_payable"] == 100.0
        assert blk["payments"] == []

    def test_partial_pair_reduces_headline(self):
        # Greedy already shows the residual (300 after a 200 payment); the block reports paid=200
        # and reconstructs the original 500.
        transfers = [{"from_member_id": "ram", "to_member_id": "shyam", "amount": 300.0}]
        payments = [{"from_member_id": "ram", "to_member_id": "shyam", "amount": 200.0,
                     "created_at": "2026-07-01T10:00:00+00:00"}]
        blk = pair_blocks(transfers, payments)[0]
        assert blk["status"] == "partial"
        assert blk["paid"] == 200.0
        assert blk["current_payable"] == 300.0
        assert blk["original_payable"] == 500.0

    def test_settled_only_direction_shows_paid_block(self):
        # No current suggestion for ram->shyam, but a payment exists -> a fully-paid settled block.
        transfers = [{"from_member_id": "gita", "to_member_id": "shyam", "amount": 200.0}]
        payments = [{"from_member_id": "ram", "to_member_id": "shyam", "amount": 200.0,
                     "created_at": "2026-07-01T10:00:00+00:00"}]
        blocks = pair_blocks(transfers, payments)
        assert len(blocks) == 2
        assert blocks[0]["status"] == "open"  # gita->shyam suggestion first
        settled = blocks[1]
        assert (settled["from_member_id"], settled["to_member_id"]) == ("ram", "shyam")
        assert settled["status"] == "paid"
        assert settled["current_payable"] == 0.0
        assert settled["paid"] == 200.0

    def test_multiple_payments_sorted_newest_first_and_summed(self):
        transfers = [{"from_member_id": "a", "to_member_id": "b", "amount": 50.0}]
        payments = [
            {"from_member_id": "a", "to_member_id": "b", "amount": 30.0,
             "created_at": "2026-07-01T09:00:00+00:00"},
            {"from_member_id": "a", "to_member_id": "b", "amount": 20.0,
             "created_at": "2026-07-02T09:00:00+00:00"},
        ]
        blk = pair_blocks(transfers, payments)[0]
        assert blk["paid"] == 50.0
        assert [p["amount"] for p in blk["payments"]] == [20.0, 30.0]  # newest-first

    def test_paid_sum_reconciles_to_records(self):
        transfers = [{"from_member_id": "a", "to_member_id": "b", "amount": 10.0}]
        payments = [
            {"from_member_id": "a", "to_member_id": "b", "amount": 5.0, "created_at": "2026-07-01"},
            {"from_member_id": "c", "to_member_id": "d", "amount": 7.5, "created_at": "2026-07-01"},
        ]
        blocks = pair_blocks(transfers, payments)
        assert round(sum(b["paid"] for b in blocks), 2) == round(sum(p["amount"] for p in payments), 2)


class TestCanRecordPayment:
    """Pure RBAC predicate: only the receiver (creditor's app user) or a trip admin may record."""

    def _trip(self):
        return {
            "owner_id": "owner-u", "admin_ids": ["owner-u", "admin-u"],
            "user_ids": ["owner-u", "admin-u", "creditor-u", "debtor-u"],
            "members": [
                {"id": "m-owner", "user_id": "owner-u"},
                {"id": "m-creditor", "user_id": "creditor-u"},
                {"id": "m-debtor", "user_id": "debtor-u"},
            ],
        }

    def test_admin_and_owner_allowed(self):
        assert can_record_payment(self._trip(), "m-creditor", "admin-u") is True
        assert can_record_payment(self._trip(), "m-creditor", "owner-u") is True

    def test_receiver_allowed(self):
        assert can_record_payment(self._trip(), "m-creditor", "creditor-u") is True

    def test_payer_denied(self):
        # The debtor (payer) can never self-record their own debt as paid.
        assert can_record_payment(self._trip(), "m-creditor", "debtor-u") is False

    def test_unknown_creditor_denied_for_non_admin(self):
        assert can_record_payment(self._trip(), "ghost", "creditor-u") is False
