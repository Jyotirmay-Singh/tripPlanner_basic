# Pure unit tests for the income -> negative-expense migration helpers (services.income_migration).
# No DB — the before/after simulation that drives the read-only dry-run is exercised directly.
from services.income_migration import compute_net, simulate_trip, to_negative_expense


def _ind(mid):
    return {"id": mid, "name": mid, "kind": "individual", "family_members": []}


def _members():
    return [_ind("P"), _ind("A"), _ind("B")]


def _row(rid, amount, kind, paid_by, split_ids, mode="PER_FAMILY"):
    return {"id": rid, "amount": amount, "kind": kind, "paid_by_member_id": paid_by,
            "split_member_ids": split_ids, "split_mode": mode,
            "date": "01-01-25", "category": "Food", "description": ""}


class TestToNegativeExpense:
    def test_negates_and_drops_kind_without_mutating_input(self):
        src = _row("x", 80.0, "income", "A", ["P", "A", "B"])
        out = to_negative_expense(src)
        assert out["amount"] == -80.0
        assert "kind" not in out
        assert src["amount"] == 80.0 and src["kind"] == "income"  # input untouched (reversible)

    def test_already_negative_income_stays_negative(self):
        assert to_negative_expense(_row("x", -5.0, "income", "A", []))["amount"] == -5.0


class TestSimulateTrip:
    def test_income_changes_balances_as_negative_expense(self):
        members = _members()
        ids = ["P", "A", "B"]
        rows = [
            _row("e1", 90.0, "expense", "P", ids),        # +90 split 3 ways -> P +60, A -30, B -30
            _row("i1", 30.0, "income", "A", ids),         # income (excluded before; -30 after)
        ]
        sim = simulate_trip(members, rows, [])
        assert len(sim["income_rows"]) == 1
        # before: income excluded
        assert sim["before"] == {"P": 60.0, "A": -30.0, "B": -30.0}
        # after: income counts as a -30 expense paid by A
        assert sim["after"] == {"P": 70.0, "A": -50.0, "B": -20.0}
        assert sim["changed"] is True
        assert set(sim["deltas"].keys()) == {"P", "A", "B"}
        assert round(sum(sim["after"].values()), 2) == 0.0  # conservation holds

    def test_pure_expense_trip_is_unchanged(self):
        members = _members()
        rows = [_row("e1", 90.0, "expense", "P", ["P", "A", "B"])]
        sim = simulate_trip(members, rows, [])
        assert sim["income_rows"] == []
        assert sim["before"] == sim["after"]
        assert sim["changed"] is False
        assert sim["deltas"] == {}

    def test_before_matches_kindless_expense_only_ledger(self):
        # `before` must equal computing net over the expense rows only (current production behaviour).
        members = _members()
        ids = ["P", "A", "B"]
        rows = [_row("e1", 90.0, "expense", "P", ids), _row("i1", 30.0, "income", "A", ids)]
        sim = simulate_trip(members, rows, [])
        expense_only = compute_net(members, [rows[0]], [])
        assert sim["before"] == expense_only
