import json
import math
import random
import time

import pytest

from services.settlement_engine import (
    SCALE,
    SettlementLedgerError,
    allocate_weighted,
    build_precise_net,
    build_settlement_projection,
    joint_round,
    route_integer_balances,
    to_scaled,
)


def _flow(transfers):
    result = {}
    for transfer in transfers:
        amount = transfer["amount_units"]
        result[transfer["from_member_id"]] = result.get(transfer["from_member_id"], 0) - amount
        result[transfer["to_member_id"]] = result.get(transfer["to_member_id"], 0) + amount
    return result


def test_decimal_parser_and_signed_weighted_allocation_conserve_at_scale():
    assert to_scaled("0.1234567890124") == 123456789012
    assert to_scaled("0.1234567890125") == 123456789013
    positive = allocate_weighted(to_scaled("10"), {"c": 1, "a": 1, "b": 1})
    negative = allocate_weighted(to_scaled("-10"), {"c": 1, "a": 1, "b": 1})
    assert sum(positive.values()) == to_scaled("10")
    assert sum(negative.values()) == to_scaled("-10")
    assert list(positive) == list(negative) == ["a", "b", "c"]
    assert negative == {member_id: -share for member_id, share in positive.items()}


def test_build_precise_net_handles_all_split_modes_refunds_families_and_overlays():
    members = [
        {"id": "f", "name": "Family", "kind": "family", "family_members": ["F1", "F2"],
         "family_member_ids": ["f1", "f2"]},
        {"id": "a", "name": "A", "kind": "individual"},
        {"id": "b", "name": "B", "kind": "individual"},
    ]
    expenses = [
        {"id": "weighted", "amount": 10, "paid_by_member_id": "a",
         "split_member_ids": ["f", "a", "b"], "split_mode": "PER_CAPITA"},
        {"id": "refund", "amount": -3, "paid_by_member_id": "b",
         "split_member_ids": ["a", "b"], "split_mode": "PER_FAMILY"},
        {"id": "exact", "amount": 3, "paid_by_member_id": "f",
         "split_member_ids": ["f", "a"], "split_mode": "EXACT",
         "custom_amounts": {"f1": 1, "a": 2}},
    ]
    net = build_precise_net(
        members,
        expenses,
        [{"id": "s", "from_member_id": "f", "to_member_id": "a", "amount": 0.5,
          "status": "paid"}],
        [{"id": "p", "from_member_id": "b", "to_member_id": "a", "amount": 1}],
    )
    assert net == {"a": to_scaled("5.5"), "b": to_scaled("-3"), "f": to_scaled("-2.5")}
    assert sum(net.values()) == 0


def test_pending_settlements_do_not_change_precise_balances():
    members = [{"id": "a", "kind": "individual"}, {"id": "b", "kind": "individual"}]
    expense = {"id": "e", "amount": 10, "paid_by_member_id": "a",
               "split_member_ids": ["a", "b"], "split_mode": "PER_FAMILY"}
    baseline = build_precise_net(members, [expense])
    pending = build_precise_net(
        members, [expense],
        [{"id": "s", "from_member_id": "b", "to_member_id": "a", "amount": 5,
          "status": "pending"}],
    )
    assert pending == baseline


@pytest.mark.parametrize(
    ("expense", "settled_amount"),
    [
        (
            {"id": "individual-history", "amount": 100, "paid_by_member_id": "a",
             "split_member_ids": ["a", "removed"], "split_mode": "PER_CAPITA"},
            50,
        ),
        (
            {"id": "family-history", "amount": 120, "paid_by_member_id": "a",
             "split_member_ids": ["a", "removed"], "split_mode": "PER_CAPITA",
             "weight_snapshots": {"a": 1, "removed": 2}},
            80,
        ),
        (
            {"id": "exact-family-history", "amount": 120, "paid_by_member_id": "a",
             "split_member_ids": ["a", "removed"], "split_mode": "EXACT",
             "custom_amounts": {"a": 40, "former-person": 80}},
            80,
        ),
    ],
)
def test_settled_removed_member_history_replays_without_a_ghost_balance(
    expense, settled_amount,
):
    members = [{"id": "a", "kind": "individual"}]
    net = build_precise_net(
        members,
        [expense],
        [{"id": "paid", "from_member_id": "removed", "to_member_id": "a",
          "amount": settled_amount, "status": "paid"}],
    )
    assert net == {"a": 0}


def test_unsettled_removed_member_history_is_not_silently_discarded():
    members = [{"id": "a", "kind": "individual"}]
    expense = {"id": "bad-history", "amount": 100, "paid_by_member_id": "a",
               "split_member_ids": ["a", "removed"], "split_mode": "PER_CAPITA"}
    with pytest.raises(SettlementLedgerError) as error:
        build_precise_net(members, [expense])
    assert error.value.code == "orphaned_member_balance"


def test_locked_conversion_metadata_is_irrelevant_during_settlement():
    members = [{"id": "a", "kind": "individual"}, {"id": "b", "kind": "individual"}]
    base = {"id": "fx", "amount": 1250.25, "paid_by_member_id": "a",
            "split_member_ids": ["a", "b"], "split_mode": "PER_FAMILY"}
    first = build_precise_net(members, [{**base, "original_amount": 10, "exchange_rate": "125.025"}])
    second = build_precise_net(members, [{**base, "original_amount": 999, "exchange_rate": "999"}])
    assert first == second


def test_joint_rounding_conserves_known_thirds_case():
    precise = {member_id: to_scaled(value) for member_id, value in {
        "a": "-10.000", "b": "3.333", "c": "3.333", "d": "3.334"
    }.items()}
    assert joint_round(precise, SCALE) == {"a": -10, "b": 3, "c": 3, "d": 4}


def test_equal_remainders_reduce_volume_then_use_stable_id():
    precise = {member_id: to_scaled(value) for member_id, value in {
        "d": "0.5", "c": "0.5", "b": "0.5", "a": "-1.5"
    }.items()}
    assert joint_round(precise, SCALE) == {"a": -1, "b": 1, "c": 0, "d": 0}


def test_joint_rounding_properties_over_fixed_seed_adversarial_vectors():
    rng = random.Random(8701)
    for _ in range(500):
        count = rng.randint(2, 40)
        values = [rng.randint(-10**16, 10**16) for _ in range(count - 1)]
        values.append(-sum(values))
        rng.shuffle(values)
        precise = {f"m{index:03}": value for index, value in enumerate(values)}
        rounded = joint_round(precise, SCALE)
        assert sum(rounded.values()) == 0
        for member_id, value in precise.items():
            floor = value // SCALE
            assert rounded[member_id] in {floor, floor + (value % SCALE != 0)}
            assert abs(rounded[member_id] * SCALE - value) < SCALE


def test_whole_projection_flow_properties_over_fixed_seed_vectors():
    rng = random.Random(8849)
    for _ in range(200):
        count = rng.randint(2, 18)
        values = [rng.randint(-100_000 * SCALE, 100_000 * SCALE) for _ in range(count - 1)]
        values.append(-sum(values))
        rng.shuffle(values)
        precise = {f"m{index:02}": value for index, value in enumerate(values)}

        transfers, projection = build_settlement_projection(
            precise, "LKR", whole_unit_enabled=True
        )

        flow = {member_id: 0 for member_id in precise}
        for transfer in transfers:
            amount = transfer["amount"]
            assert isinstance(amount, int)
            assert amount > 0
            flow[transfer["from_member_id"]] -= amount
            flow[transfer["to_member_id"]] += amount
        assert flow == projection["rounded_net"]
        assert sum(flow.values()) == 0


def test_routing_finds_true_minimum_for_greedy_counterexample():
    balances = {"credit4": 4, "credit3": 3, "debt3": -3, "debt2a": -2, "debt2b": -2}
    result = route_integer_balances(balances)
    assert result.optimal is True
    assert result.algorithm == "exact_dfs_v1"
    assert len(result.transfers) == 3
    assert _flow(result.transfers) == balances


def test_routing_has_deterministic_state_and_entity_fallbacks():
    small = {"a": -3, "b": -2, "c": 5}
    state_fallback = route_integer_balances(small, state_limit=1)
    assert state_fallback.algorithm == "greedy_heap_v1"
    assert state_fallback.optimal is False
    assert state_fallback.fallback_reason == "state_limit"
    many = {f"d{i:02}": -1 for i in range(7)} | {f"c{i:02}": 1 for i in range(7)}
    entity_fallback = route_integer_balances(many)
    assert entity_fallback.fallback_reason == "entity_limit"
    assert len(entity_fallback.transfers) <= 13
    assert _flow(entity_fallback.transfers) == many


def test_projection_is_integer_for_lkr_npr_and_cent_based_elsewhere():
    precise = {"a": to_scaled("-10"), "b": to_scaled("3.333"),
               "c": to_scaled("3.333"), "d": to_scaled("3.334")}
    for currency in ("LKR", "NPR"):
        transfers, projection = build_settlement_projection(
            precise, currency, whole_unit_enabled=True
        )
        assert projection["enabled"] is True
        assert projection["increment"] == "1"
        assert all(isinstance(transfer["amount"], int) or transfer["amount"].is_integer()
                   for transfer in transfers)
        assert sum(projection["rounded_net"].values()) == 0
    _transfers, projection = build_settlement_projection(precise, "INR", whole_unit_enabled=True)
    assert projection["enabled"] is False
    assert projection["increment"] == "0.01"


def test_same_state_is_byte_deterministic_regardless_of_mapping_order():
    items = [("z", to_scaled("3.334")), ("b", to_scaled("3.333")),
             ("a", to_scaled("-10")), ("c", to_scaled("3.333"))]
    outputs = []
    for ordering in (items, list(reversed(items)), [items[i] for i in (2, 0, 3, 1)]):
        transfers, projection = build_settlement_projection(
            dict(ordering), "LKR", whole_unit_enabled=True
        )
        outputs.append(json.dumps({"transfers": transfers, "projection": projection}, separators=(",", ":")))
    assert len(set(outputs)) == 1


def test_expense_and_overlay_iteration_order_cannot_change_recommendations():
    members = [
        {"id": "c", "kind": "individual"},
        {"id": "a", "kind": "individual"},
        {"id": "b", "kind": "individual"},
    ]
    expenses = [
        {"id": "e1", "amount": "10", "paid_by_member_id": "a",
         "split_member_ids": ["b", "c"], "split_mode": "PER_FAMILY"},
        {"id": "e2", "amount": "1", "paid_by_member_id": "b",
         "split_member_ids": ["a", "b", "c"], "split_mode": "PER_FAMILY"},
    ]
    settlements = [
        {"id": "s1", "from_member_id": "c", "to_member_id": "a", "amount": "0.25",
         "status": "paid"},
        {"id": "s2", "from_member_id": "c", "to_member_id": "b", "amount": "0.10",
         "status": "paid"},
    ]
    payments = [
        {"id": "p1", "from_member_id": "c", "to_member_id": "a", "amount": "0.5"},
        {"id": "p2", "from_member_id": "c", "to_member_id": "b", "amount": "0.2"},
    ]

    outputs = []
    for member_rows, expense_rows, settlement_rows, payment_rows in (
        (members, expenses, settlements, payments),
        (list(reversed(members)), list(reversed(expenses)),
         list(reversed(settlements)), list(reversed(payments))),
    ):
        precise = build_precise_net(member_rows, expense_rows, settlement_rows, payment_rows)
        transfers, projection = build_settlement_projection(
            precise, "LKR", whole_unit_enabled=True
        )
        outputs.append(json.dumps(
            {"transfers": transfers, "projection": projection}, separators=(",", ":")
        ))
    assert outputs[0] == outputs[1]


def test_recording_all_integer_suggestions_leaves_only_disclosed_precise_residual():
    precise = {"a": to_scaled("-10"), "b": to_scaled("3.333"),
               "c": to_scaled("3.333"), "d": to_scaled("3.334")}
    transfers, _projection = build_settlement_projection(precise, "LKR", whole_unit_enabled=True)
    remaining = dict(precise)
    for transfer in transfers:
        amount = to_scaled(transfer["amount"])
        remaining[transfer["from_member_id"]] += amount
        remaining[transfer["to_member_id"]] -= amount
    next_transfers, next_projection = build_settlement_projection(
        remaining, "LKR", whole_unit_enabled=True
    )
    assert next_transfers == []
    assert next_projection["status"] == "settled_within_rounding"
    assert any(value != "0.000000000000" for value in next_projection["precise_net"].values())


def test_recording_one_suggestion_recomputes_a_valid_plan():
    precise = {"a": to_scaled("-10"), "b": to_scaled("3.333"),
               "c": to_scaled("3.333"), "d": to_scaled("3.334")}
    transfers, _projection = build_settlement_projection(precise, "NPR", whole_unit_enabled=True)
    first = transfers[0]
    remaining = dict(precise)
    amount = to_scaled(first["amount"])
    remaining[first["from_member_id"]] += amount
    remaining[first["to_member_id"]] -= amount
    next_transfers, next_projection = build_settlement_projection(
        remaining, "NPR", whole_unit_enabled=True
    )
    assert sum(next_projection["rounded_net"].values()) == 0
    assert all(transfer["amount"] > 0 and float(transfer["amount"]).is_integer()
               for transfer in next_transfers)


def test_exact_one_cent_and_one_unit_are_never_dropped():
    assert build_settlement_projection(
        {"a": to_scaled("-0.01"), "b": to_scaled("0.01")},
        "INR", whole_unit_enabled=False,
    )[0] == [{"from_member_id": "a", "to_member_id": "b", "amount": 0.01}]
    assert build_settlement_projection(
        {"a": -SCALE, "b": SCALE}, "LKR", whole_unit_enabled=True,
    )[0] == [{"from_member_id": "a", "to_member_id": "b", "amount": 1}]


def test_subunit_thirds_case_becomes_a_conserving_zero_whole_unit_projection():
    precise = {member_id: to_scaled(value) for member_id, value in {
        "a": "-0.10", "b": "0.033333", "c": "0.033333", "d": "0.033334",
    }.items()}
    transfers, projection = build_settlement_projection(
        precise, "LKR", whole_unit_enabled=True
    )
    assert transfers == []
    assert projection["status"] == "settled_within_rounding"
    assert projection["rounded_net"] == {"a": 0, "b": 0, "c": 0, "d": 0}


def test_material_imbalance_and_invalid_exact_share_are_blocked():
    with pytest.raises(SettlementLedgerError, match="imbalanced"):
        joint_round({"a": -10, "b": 9}, SCALE)
    members = [{"id": "a", "kind": "individual"}, {"id": "b", "kind": "individual"}]
    with pytest.raises(SettlementLedgerError, match="allocations total"):
        build_precise_net(members, [{"id": "e", "amount": 10, "paid_by_member_id": "a",
                                    "split_member_ids": ["a", "b"], "split_mode": "EXACT",
                                    "custom_amounts": {"a": 4, "b": 5}}])


def test_large_values_do_not_overflow():
    amount = "999999999999999.99"
    members = [{"id": "a", "kind": "individual"}, {"id": "b", "kind": "individual"}]
    net = build_precise_net(members, [{"id": "e", "amount": amount,
                                      "paid_by_member_id": "a", "split_member_ids": ["a", "b"],
                                      "split_mode": "PER_FAMILY"}])
    transfers, projection = build_settlement_projection(net, "LKR", whole_unit_enabled=True)
    assert sum(net.values()) == 0
    assert sum(projection["rounded_net"].values()) == 0
    assert math.isfinite(transfers[0]["amount"])


def test_whole_unit_output_does_not_round_trip_through_binary_float():
    amount = 9_007_199_254_740_993
    transfers, projection = build_settlement_projection(
        {"a": -amount * SCALE, "b": amount * SCALE},
        "LKR",
        whole_unit_enabled=True,
    )
    assert transfers == [{"from_member_id": "a", "to_member_id": "b", "amount": amount}]
    assert projection["rounded_net"] == {"a": -amount, "b": amount}


def test_many_member_greedy_fallback_stays_bounded_and_fast():
    side_size = 2_500
    balances = (
        {f"debtor-{index:04}": -1 for index in range(side_size)}
        | {f"creditor-{index:04}": 1 for index in range(side_size)}
    )

    started = time.perf_counter()
    result = route_integer_balances(balances)
    elapsed = time.perf_counter() - started

    assert result.algorithm == "greedy_heap_v1"
    assert result.fallback_reason == "entity_limit"
    assert len(result.transfers) == side_size
    assert len(result.transfers) <= len(balances) - 1
    assert _flow(result.transfers) == balances
    assert elapsed < 2.0
