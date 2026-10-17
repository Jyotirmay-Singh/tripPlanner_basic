from copy import deepcopy
import random

import pytest

from services.direct_debts import build_direct_projection, settlement_mode
from services.settlement_engine import build_precise_net, build_settlement_projection
from utils.settlement_gate import is_precisely_settled


MEMBERS = [{"id": mid, "name": mid.title(), "kind": "individual"}
           for mid in ("ram", "shyam", "rahul")]


def expense(eid, payer, amount, split=None, created_at=None, **fields):
    return {"id": eid, "paid_by_member_id": payer, "amount": amount,
            "split_member_ids": split or [m["id"] for m in MEMBERS],
            "split_mode": "PER_CAPITA", **({"created_at": created_at} if created_at else {}), **fields}


def example():
    return [expense("e1", "ram", 300), expense("e2", "rahul", 150)]


def project(expenses, payments=(), settlements=(), members=None, adjustments=None, currency="INR"):
    members = members if members is not None else MEMBERS
    net = build_precise_net(members, expenses, settlements, payments, adjustments)
    _transfers, metadata = build_settlement_projection(net, currency, whole_unit_enabled=True)
    transfers, metadata = build_direct_projection(
        members, expenses, list(settlements), list(payments), net, metadata, adjustments,
    )
    # Check every case against the independent canonical ledger, including zero-net cycles.
    flow = {member["id"]: 0 for member in members}
    for row in transfers:
        assert isinstance(row["amount"], int) and row["amount"] > 0
        assert row["from_member_id"] != row["to_member_id"]
        flow[row["from_member_id"]] -= row["amount"]
        flow[row["to_member_id"]] += row["amount"]
    assert flow == metadata["rounded_net"]
    assert sum(flow.values()) == 0
    return transfers, metadata


def pairs(transfers):
    return {(row["from_member_id"], row["to_member_id"]): row["amount"] for row in transfers}


def payment(amount, mode=None, **fields):
    return {"id": "p1", "from_member_id": "shyam", "to_member_id": "ram", "amount": amount,
            **({"settlement_mode": mode} if mode else {}), **fields}


@pytest.mark.parametrize("currency", ["INR", "LKR", "NPR", "USD"])
def test_requested_example_and_default_optimizer(currency):
    transfers, meta = project(example(), currency=currency)
    assert pairs(transfers) == {("rahul", "ram"): 50, ("shyam", "rahul"): 50, ("shyam", "ram"): 100}
    assert meta["enabled"] is True
    assert meta["settlement_mode"] == "direct"
    assert meta["routing"]["algorithm"] == "pairwise_v1"
    assert meta["routing"]["optimal"] is False
    assert meta["routing"]["transfer_count_bound"] is None
    net = build_precise_net(MEMBERS, example())
    simplified, _meta = build_settlement_projection(net, currency, whole_unit_enabled=True)
    assert pairs(simplified) == {("shyam", "ram"): 150}
    assert settlement_mode({}) == "simplified"
    assert settlement_mode({"simplify_debts": False}) == "direct"


def test_simplified_paid_and_partial_history_stays_cleared():
    assert project(example(), [payment(150)])[0] == []
    assert project(example(), [payment(150)])[1]["status"] == "settled_exactly"
    assert pairs(project(example(), [payment(60)])[0]) == {("shyam", "ram"): 90}
    # New direct payments only reduce their own pair.
    assert pairs(project(example(), [payment(40, "direct")])[0]) == {
        ("rahul", "ram"): 50, ("shyam", "rahul"): 50, ("shyam", "ram"): 60,
    }


def test_later_expenses_add_direct_debts_to_carried_over_pairs():
    expenses = example() + [expense("later", "rahul", 150, created_at="2026-10-15T14:00:00Z")]
    paid = payment(60, created_at="2026-10-15T13:00:00Z")
    assert pairs(project(expenses, [paid])[0]) == {
        ("shyam", "ram"): 90, ("ram", "rahul"): 50, ("shyam", "rahul"): 50,
    }
    # Changing or removing a payment intentionally recalculates its cleared amount.
    assert pairs(project(expenses, [{**paid, "amount": 100}])[0])[("shyam", "ram")] == 50
    assert pairs(project(expenses)[0]) == {("shyam", "ram"): 100, ("shyam", "rahul"): 100}


def test_pending_settlements_are_ignored_and_completion_uses_paid_time():
    paid = {**payment(150), "status": "pending", "created_at": "2026-10-15T10:00:00Z"}
    assert pairs(project(example(), settlements=[paid])[0]) == pairs(project(example())[0])
    assert project(example(), settlements=[{**paid, "status": "paid", "paid_at": "2026-10-15T13:00:00Z"}])[0] == []


def test_direct_cycles_remain_open_and_block_removal_despite_zero_nets():
    expenses = [expense("e1", "ram", 100, ["shyam"]),
                expense("e2", "shyam", 100, ["rahul"]),
                expense("e3", "rahul", 100, ["ram"])]
    transfers, meta = project(expenses)
    assert len(transfers) == 3
    assert all(value == 0 for value in meta["rounded_net"].values())
    assert meta["status"] == "open"
    assert not is_precisely_settled({"settlement_projection": meta, "transfers": transfers}, "ram")
    paid = [{"id": f"p{index}", **row, "settlement_mode": "direct"} for index, row in enumerate(transfers)]
    assert project(expenses, paid)[0] == []


def test_refunds_reverse_direct_obligations_and_repeated_pairs_combine():
    expenses = [expense("a", "ram", 300), expense("b", "ram", -90), expense("c", "ram", 30)]
    assert pairs(project(expenses)[0]) == {("rahul", "ram"): 80, ("shyam", "ram"): 80}
    assert pairs(project([expense("refund", "ram", -90)])[0]) == {
        ("ram", "rahul"): 30, ("ram", "shyam"): 30,
    }


@pytest.mark.parametrize("mode,expected", [
    ("PER_CAPITA", {("family", "ram"): 150}),
    ("PER_FAMILY", {("family", "ram"): 150}),
    ("EXACT", {("family", "ram"): 120}),
])
def test_families_are_one_unit_with_authoritative_allocations(mode, expected):
    members = [{"id": "ram", "name": "Ram", "kind": "individual"},
               {"id": "family", "name": "Family", "kind": "family", "family_members": ["F1", "F2"],
                "family_member_ids": ["f1", "f2"]}]
    row = expense("family", "ram", 300, ["ram", "family"], split_mode=mode,
                  family_participants={"family": ["f1"]})
    if mode == "EXACT":
        row["custom_amounts"] = {"ram": 180, "f1": 70, "f2": 50}
    assert pairs(project([row], members=members)[0]) == expected


def test_settled_removed_entity_is_not_resurrected():
    members = [{"id": "ram", "name": "Ram", "kind": "individual"}]
    expense_row = expense("history", "ram", 100, ["ram", "removed"])
    paid = {"id": "old", "from_member_id": "removed", "to_member_id": "ram", "amount": 50}
    assert project([expense_row], [paid], members=members)[0] == []


def test_removed_zero_net_historical_chain_is_carried_forward_without_ghosts():
    expenses = [expense("a", "ram", 100, ["removed"]), expense("b", "removed", 100, ["shyam"])]
    assert pairs(project(expenses)[0]) == {("shyam", "ram"): 100}


def test_legacy_rounding_and_migration_adjustments_reconcile():
    rows = [expense("fractional", "ram", "1250.25")]
    project(rows)
    transfers, meta = project([expense("cost", "ram", 100, ["shyam"])],
                              adjustments={"ram": -40, "shyam": 40})
    assert pairs(transfers) == {("shyam", "ram"): 60}
    assert meta["policy_version"] == "whole_unit_v1"


def test_replay_is_deterministic_independent_of_collection_order():
    expenses = example() + [expense("new", "rahul", 150, created_at="2026-10-15T14:00:00+00:00")]
    payments = [payment(60, created_at="2026-10-15T13:00:00Z"),
                payment(20, "direct", id="p2", created_at="2026-10-15T15:00:00Z")]
    expected = project(expenses, payments)
    rng = random.Random(1015)
    for _ in range(20):
        shuffled_expenses, shuffled_payments = deepcopy(expenses), deepcopy(payments)
        rng.shuffle(shuffled_expenses)
        rng.shuffle(shuffled_payments)
        assert project(shuffled_expenses, shuffled_payments) == expected


def test_same_time_payments_and_settlements_use_stable_id_tie_breaking():
    timestamp = "2026-10-15T15:00:00Z"
    first = payment(60, id="a-first", created_at=timestamp)
    second = {"id": "z-last", "from_member_id": "rahul", "to_member_id": "ram", "amount": 50,
              "status": "paid", "paid_at": timestamp, "settlement_mode": "direct"}
    assert pairs(project(example(), [first], [second])[0]) == {
        ("shyam", "ram"): 90, ("ram", "rahul"): 50,
    }


def test_random_direct_ledgers_conserve_every_member_and_support_payment_completion():
    rng = random.Random(65844)
    ids = [member["id"] for member in MEMBERS]
    for iteration in range(40):
        rows = [expense(f"e{i}", rng.choice(ids), rng.choice([-1, 1]) * rng.randint(1, 200),
                        rng.sample(ids, rng.randint(1, 3))) for i in range(rng.randint(1, 15))]
        transfers, _metadata = project(rows)
        paid = [{"id": f"p{iteration}-{i}", **row, "settlement_mode": "direct"}
                for i, row in enumerate(transfers)]
        assert project(rows, paid)[0] == []
