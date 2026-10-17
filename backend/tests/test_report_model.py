"""Independent arithmetic controls for the report snapshot and account/person boundaries."""

from collections import defaultdict
from copy import deepcopy
from dataclasses import replace
from random import Random

import pytest
from fastapi import HTTPException

from services import report_model
from services.report_model import ReportSnapshot, ReportReconciliationError, build_report_data
from services.balance_snapshot import compute_balance_snapshot
from scripts.generate_report_samples import sample_snapshot


def control_snapshot():
    trip = {"id": "t", "name": "Arithmetic controls", "currency": "INR", "members": [
        {"id": "f", "name": "Family", "kind": "family", "family_members": ["Ana", "Ben"],
         "family_member_ids": ["a", "b"]},
        {"id": "s", "name": "Sam", "kind": "individual"},
        {"id": "t", "name": "Taylor", "kind": "individual"},
    ]}

    def expense(eid, amount, payer, mode="PER_CAPITA", **extra):
        return {"id": eid, "amount": amount, "paid_by_member_id": payer, "split_mode": mode,
                "split_member_ids": ["f", "s", "t"], "category": "Food", "date": "16-10-26", **extra}

    expenses = (
        expense("capita", 10, "f"),
        expense("family", 10, "s", "PER_FAMILY"),
        expense("partial", 7, "t", split_member_ids=["f", "s"], family_participants={"f": ["a"]}),
        expense("exact", 11, "f", "EXACT", custom_amounts={"a": 1, "b": 0, "s": 10}),
        expense("refund", -7, "t", split_member_ids=["f", "s"], family_participants={"f": ["a"]}),
    )
    settlements = ({"id": "legacy", "from_member_id": "t", "to_member_id": "f", "amount": 3, "status": "paid"},
                   {"id": "pending", "from_member_id": "s", "to_member_id": "f", "amount": 100, "status": "pending"})
    payments = ({"id": "p1", "from_member_id": "f", "to_member_id": "s", "amount": 2},
                {"id": "p2", "from_member_id": "s", "to_member_id": "f", "amount": 1})
    migration = {"policy_version": "test-policy", "vector": {"f": 1, "s": -1}}
    return ReportSnapshot(trip, expenses, settlements, payments, migration)


def test_hand_calculated_allocations_and_balance_equation():
    data = build_report_data(control_snapshot())
    actual = defaultdict(dict)
    for row in data.allocations:
        actual[row.expense_id][row.person_id] = row.share
    assert dict(actual) == {
        "capita": {"a": 3, "b": 3, "s": 2, "t": 2},
        "family": {"a": 2, "b": 1, "s": 4, "t": 3},
        "partial": {"a": 4, "s": 3},
        "exact": {"a": 1, "b": 0, "s": 10},
        "refund": {"a": -4, "s": -3},
    }
    assert (data.gross, data.money_back, data.net) == (38, 7, 31)
    assert data.category_totals == {"Food": 31}
    assert {a.account_id: (a.share, a.funded, a.sent, a.received, a.adjustment, a.balance)
            for a in data.accounts} == {
        "f": (10, 21, 2, 4, 1, 10),
        "s": (16, 10, 1, 2, -1, -8),
        "t": (5, 0, 3, 0, 0, -2),
    }
    assert {p.person_id: p.share for p in data.member_positions} == {"a": 6, "b": 4}
    assert sum(p.balance for p in data.member_positions) == 10
    assert {a.kind for a in data.adjustments} == {"Migration"}
    for a in data.accounts:
        assert a.balance == a.funded - a.share + a.sent - a.received + a.adjustment
    assert data.outstanding == 10


@pytest.mark.parametrize("simplify", [True, False])
def test_snapshot_matches_authoritative_balances_without_mutating_inputs(simplify):
    source = sample_snapshot()
    source.trip["simplify_debts"] = simplify
    original = deepcopy(source)
    data = build_report_data(source)
    expected = compute_balance_snapshot(source.trip, list(source.expenses), [s for s in source.settlements if s.get("status") != "pending"],
                                        list(source.payments), source.migration_adjustment)
    assert data.balances == expected
    assert source == original
    assert data.outstanding == sum(t["amount"] for t in expected["transfers"])
    assert sum(a.share for a in data.accounts) == data.net
    assert sum(a.sent for a in data.accounts) == sum(e.amount for e in data.events)
    assert sum(a.received for a in data.accounts) == sum(e.amount for e in data.events)
    assert all(t["from_member_id"] not in {p.person_id for p in data.member_positions}
               for t in expected["transfers"])


def test_direct_plan_total_is_sum_of_actual_instructions_not_net_receivables():
    snapshot = control_snapshot()
    snapshot.trip["simplify_debts"] = False
    data = build_report_data(snapshot)
    assert data.outstanding == sum(t["amount"] for t in data.balances["transfers"])


def test_distinct_matching_payment_records_are_never_deduplicated():
    base = control_snapshot()
    twin = {**base.payments[0], "id": "different-source-record"}
    data = build_report_data(replace(base, payments=(*base.payments, twin)))
    assert len(data.events) == 4
    assert {e.source_id for e in data.events} == {"legacy", "p1", "p2", "different-source-record"}
    assert sum(e.amount for e in data.events) == 8


def test_genuine_zero_allocations_are_kept_but_nonparticipants_are_absent():
    source = control_snapshot()
    tiny = {**source.expenses[0], "id": "tiny", "amount": 1}
    data = build_report_data(replace(source, expenses=(tiny,), settlements=(), payments=(), migration_adjustment=None))
    assert {a.person_id: a.share for a in data.allocations} == {"a": 1, "b": 0, "s": 0, "t": 0}
    partial = [a.person_id for a in build_report_data(source).allocations if a.expense_id == "partial"]
    assert partial == ["a", "s"]


def test_historical_people_and_accounts_remain_traceable():
    data = build_report_data(sample_snapshot())
    old = next(a for a in data.accounts if a.account_id == "departed-account")
    assert (old.share, old.funded, old.sent, old.received, old.balance) == (600, 1200, 0, 600, 0)
    old_person = next(a for a in data.allocations if a.person_id == "departed-person")
    assert old_person.account_id == "f1" and old_person.share == 300
    assert "Former person" in old_person.person
    historical = next(p for p in data.member_positions if p.person_id == "departed-person")
    assert historical.balance is None
    assert sum(p.share for p in data.member_positions if p.account_id == "f1") == next(a.share for a in data.accounts if a.account_id == "f1")


def test_removed_whole_family_exact_person_mapping_is_preserved():
    source = control_snapshot()
    source.trip["members"] = source.trip["members"][1:]
    expense = {"id": "old", "amount": 100, "split_mode": "EXACT", "paid_by_member_id": "s",
               "split_member_ids": ["removed-family", "s"], "custom_amounts": {"old-person": 40, "s": 60}}
    settlement = {"id": "paid", "from_member_id": "removed-family", "to_member_id": "s", "amount": 40}
    data = build_report_data(ReportSnapshot(source.trip, (expense,), payments=(settlement,)))
    assert {(a.account_id, a.person_id): a.share for a in data.allocations} == {
        ("s", "s"): 60, ("removed-family", "old-person"): 40,
    }


def test_unresolved_historical_balance_returns_clear_error_instead_of_dropping_it():
    source = sample_snapshot()
    with pytest.raises(HTTPException) as error:
        build_report_data(replace(source, payments=source.payments[1:]), diagnostic=True)
    assert error.value.status_code == 409
    assert "orphaned_member_balance" in error.value.detail


def test_duplicate_names_and_literal_suffixes_have_distinct_report_identities():
    source = control_snapshot()
    for member, name in zip(source.trip["members"], ["Alex", "Alex", "Alex_1"]):
        member["name"] = name
    data = build_report_data(source)
    assert len({a.name.casefold() for a in data.accounts}) == 3
    assert len({(a.account_id, a.person_id) for a in data.allocations}) == 4


def test_historical_fractional_records_get_a_verified_separate_rounding_bridge():
    source = control_snapshot()
    expenses = tuple({**source.expenses[0], "id": str(i), "amount": 10.4} for i in range(3))
    data = build_report_data(ReportSnapshot(source.trip, expenses))
    assert data.net == 30
    assert {a.account_id: a.balance for a in data.accounts} == {"f": 16, "s": -8, "t": -8}
    assert {a.account_id: a.amount for a in data.adjustments} == {"f": 4, "s": -2, "t": -2}
    assert {a.kind for a in data.adjustments} == {"Historical rounding"}
    assert all("precise ledger balance" in a.explanation for a in data.adjustments)


def test_unexplained_balance_difference_is_rejected(monkeypatch):
    real = report_model.compute_balance_snapshot

    def inconsistent(*args, **kwargs):
        balances = real(*args, **kwargs)
        balances["net"]["f"] += 1
        balances["net"]["s"] -= 1
        return balances

    monkeypatch.setattr(report_model, "compute_balance_snapshot", inconsistent)
    with pytest.raises(ReportReconciliationError, match="authoritative whole-unit projection"):
        build_report_data(control_snapshot())


def test_many_whole_unit_family_allocations_conserve_without_adjustments():
    rng = Random(1904)
    source = control_snapshot()
    for mode in ("PER_CAPITA", "PER_FAMILY"):
        for _ in range(30):
            expense = {**source.expenses[0], "split_mode": mode, "amount": rng.randint(-100000, 100000),
                       "paid_by_member_id": rng.choice(["f", "s", "t"])}
            data = build_report_data(ReportSnapshot(source.trip, (expense,)))
            assert sum(a.share for a in data.allocations) == expense["amount"]
            assert not data.adjustments
            assert sum(p.share for p in data.member_positions) == data.accounts[0].share


def test_empty_group_has_no_dummy_rows_or_adjustments():
    data = build_report_data(ReportSnapshot({"id": "empty", "name": "Empty", "members": [], "currency": "INR"}))
    assert data.allocations == data.events == data.accounts == data.adjustments == ()
    assert (data.gross, data.money_back, data.net, data.outstanding) == (0, 0, 0, 0)


def test_nonzero_expense_without_eligible_allocations_is_never_silently_omitted():
    trip = {"id": "empty", "name": "Empty", "members": [], "currency": "INR"}
    with pytest.raises(ReportReconciliationError, match="no eligible allocations"):
        build_report_data(ReportSnapshot(trip, ({"id": "unallocated", "amount": 100},)))


def test_opposing_exact_signs_are_not_hidden_as_a_rounding_adjustment():
    source = control_snapshot()
    expense = {**source.expenses[3], "amount": 0, "custom_amounts": {"a": 1, "s": -1}}
    with pytest.raises(ReportReconciliationError, match="opposing cost"):
        build_report_data(ReportSnapshot(source.trip, (expense,)))
