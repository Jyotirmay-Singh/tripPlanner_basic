"""Frozen accounting oracles for Session 1; no service/database/network fixtures."""

from copy import deepcopy
import random

import pytest

from services.coverage_allocations import (
    cash_uses_for_plan, plan_direct_allocations, plan_group_allocations, plan_offset_allocations,
    validate_allocation_bundle, validate_plan,
)
from services.coverage_read import coverage_response
from services.coverage_support import CoverageError, fingerprint
from services.expense_coverage import build_coverage_snapshot, make_share_revision
from services.ledger_snapshot import LedgerSnapshot
from services.settlement_engine import SCALE, to_scaled

CREATED = "2026-10-01T00:00:00+00:00"
PAID = "2026-10-02T00:00:00+00:00"


def trip():
    return {"id": "t", "currency": "INR", "version": 0, "owner_id": "admin",
            "admin_ids": ["admin"], "user_ids": ["admin", "u_a", "u_b", "u_c", "u_d"],
            "members": [{"id": key, "name": key.upper(), "kind": "individual", "user_id": f"u_{key}"}
                        for key in ("a", "b", "c", "d")]}


def expense(expense_id="dinner", amount=100, payer="a", people=("b",), **extra):
    return {"id": expense_id, "trip_id": "t", "amount": amount, "currency": "INR",
            "paid_by_member_id": payer, "split_member_ids": list(people), "split_mode": "PER_CAPITA",
            "created_at": CREATED, **extra}


def ledger(expenses=None, group=None, *, frozen=True):
    group = group or trip()
    expenses = expenses or [expense()]
    return LedgerSnapshot(group, expenses, revisions=[make_share_revision(
        row, group["members"], "t", recorded_at=CREATED,
    ) for row in expenses] if frozen else [])


def share(snapshot, expense_id="dinner", person="b"):
    return next(row for row in snapshot.shares.values() if row["expense_id"] == expense_id and row["person_id"] == person)


def actors(group):
    return {user: {"id": user} for user in group["user_ids"]}


def approvals_for(snapshot, plan, *, consent=True):
    output = [{"scope": "receipt", "leg_id": leg["id"], "action": "confirmed",
               "actor_user_id": f"u_{leg['to_member_id']}", "plan_hash": plan["plan_hash"]}
              for leg in plan["cash_legs"]]
    if consent:
        output += [{"scope": "consent", "person_id": person, "action": "approved",
                    "actor_user_id": f"u_{person}", "plan_hash": plan["plan_hash"]}
                   for person in plan["required_person_ids"]]
    return output


def received_ledger(snapshot, plan):
    copied = deepcopy(snapshot.ledger)
    for index, leg in enumerate(plan["cash_legs"]):
        copied.payments.append({"id": f"cash-{len(copied.payments)}-{index}", "trip_id": "t",
                                "from_member_id": leg["from_member_id"], "to_member_id": leg["to_member_id"],
                                "amount": leg["amount"], "created_at": PAID, "settlement_intent_id": "intent"})
    return copied


def applied(snapshot, plan):
    copied = received_ledger(snapshot, plan)
    current = build_coverage_snapshot(copied, infer_history=False)
    uses = cash_uses_for_plan(current, plan, {leg["id"]: f"payments:{copied.payments[index]['id']}"
                                             for index, leg in enumerate(plan["cash_legs"], len(snapshot.ledger.payments))})
    event = validate_allocation_bundle(current, plan, uses, approvals_for(current, plan), actors(copied.trip))
    copied.events.append({**event, "id": f"event-{len(copied.events)}", "trip_id": "t", "sequence": len(copied.events) + 1})
    return build_coverage_snapshot(copied)


def test_bill_payer_counts_and_pending_reports_are_not_coverage():
    data = ledger([expense(amount=300, people=("a", "b", "c"))])
    data.settlements.append({"id": "proposed", "status": "pending", "from_member_id": "b", "to_member_id": "a", "amount": 100})
    data.attempts.append({"id": "attempt", "status": "awaiting_confirmation", "from_member_id": "b", "to_member_id": "a"})
    snapshot = build_coverage_snapshot(data)
    response = coverage_response(snapshot, {"id": "u_b"}, {"dinner"}, capability=True, actions_ready=True)
    assert response["expenses"][0]["settled_count"] == 1
    assert response["expenses"][0]["participant_count"] == 3
    assert snapshot.remaining(share(snapshot)["id"]) == 100 * SCALE
    assert len(response["pending_reports"]) == 2
    assert all(not item["attributed"] for item in response["pending_reports"])
    assert share(snapshot, person="a")["coverage_units"]["wallet_funding"] == 100 * SCALE


def test_direct_route_is_gross_even_when_group_recommendation_is_smaller():
    initial = build_coverage_snapshot(ledger([expense(), expense("reverse", 80, "b", ("a",))]))
    direct = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "100"}])
    assert direct["cash_legs"][0]["amount"] == "100"
    assert initial.precise_net == {"a": 20 * SCALE, "b": -20 * SCALE, "c": 0, "d": 0}
    final = applied(initial, direct)
    assert final.remaining(share(final)["id"]) == 0
    assert final.remaining(share(final, "reverse", "a")["id"]) == 80 * SCALE
    assert final.precise_net["a"] == -80 * SCALE
    with pytest.raises(CoverageError, match="already covered"):
        plan_direct_allocations(final, [{"share_id": share(final)["id"], "amount": "1"}])


@pytest.mark.parametrize("cash,dinner_left", [(20, 0), (10, 10), (1, 19)])
def test_group_payment_explains_exact_cash_plus_offset_and_partial_amounts(cash, dinner_left):
    initial = build_coverage_snapshot(ledger([expense(), expense("reverse", 80, "b", ("a",))]))
    plan = plan_group_allocations(initial, [{"from_member_id": "b", "to_member_id": "a", "amount": str(cash)}])
    validate_plan(initial, plan)
    dinner_lines = [line for line in plan["allocation_lines"] if line["share_id"] == share(initial)["id"]]
    assert {line["kind"]: line["amount"] for line in dinner_lines} == {"group": str(cash), "approved_offset": "80"}
    final = applied(initial, plan)
    assert final.remaining(share(final)["id"]) == dinner_left * SCALE
    assert final.remaining(share(final, "reverse", "a")["id"]) == 0
    assert final.precise_net["a"] == dinner_left * SCALE
    assert len(final.ledger.payments) == 1


def test_group_confirmed_cash_is_credit_until_person_consents_complete():
    initial = build_coverage_snapshot(ledger([expense(), expense("reverse", 80, "b", ("a",))]))
    plan = plan_group_allocations(initial, [{"from_member_id": "b", "to_member_id": "a", "amount": "20"}], intent_id="intent")
    data = received_ledger(initial, plan)
    data.intents.append({"id": "intent", "status": "awaiting_consent", "plan": plan})
    current = build_coverage_snapshot(data, infer_history=False)
    uses = cash_uses_for_plan(current, plan, {plan["cash_legs"][0]["id"]: "payments:cash-0-0"})
    with pytest.raises(CoverageError) as error:
        validate_allocation_bundle(current, plan, uses, approvals_for(current, plan, consent=False), actors(data.trip))
    assert error.value.code == "allocation_consent_pending"
    public = coverage_response(build_coverage_snapshot(data), {"id": "u_b"}, {"dinner"})
    assert public["unapplied_credit"][0]["amount"] == "20"
    assert public["balances"]["a"] == "0"
    assert public["details"]["dinner"]["participants"][0]["remaining_amount"] == "100"


def test_partial_direct_and_source_cash_are_not_posted_twice():
    initial = build_coverage_snapshot(ledger())
    final = applied(initial, plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "40"}]))
    assert final.remaining(share(final)["id"]) == 60 * SCALE
    assert final.precise_net["a"] == 60 * SCALE
    assert coverage_response(final, {"id": "u_b"})["expenses"][0]["settled_count"] == 0


def test_pure_offset_proposal_leaves_direct_payment_open_then_closes_both_without_cash():
    initial = build_coverage_snapshot(ledger([expense(), expense("reverse", 100, "b", ("a",))]))
    plan = plan_offset_allocations(initial, [share(initial)["id"]])
    data = deepcopy(initial.ledger)
    data.intents = [{"id": "zero", "status": "awaiting_consent", "plan": plan}]
    proposed = build_coverage_snapshot(data)
    assert plan_direct_allocations(proposed, [{"share_id": share(proposed)["id"], "amount": "100"}])
    final = applied(initial, plan)
    assert not final.ledger.payments
    assert all(final.remaining(row["id"]) == 0 for row in final.shares.values())
    assert final.precise_net == initial.precise_net
    direct = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "1"}])
    changed = applied(initial, direct)
    with pytest.raises(CoverageError):
        validate_plan(changed, plan)


def test_routed_cash_can_discharge_two_original_recipients_without_claiming_two_cash_payments():
    initial = build_coverage_snapshot(ledger([expense("ab", 100, "b", ("a",)), expense("bc", 100, "c", ("b",))]))
    plan = plan_group_allocations(initial, [{"from_member_id": "a", "to_member_id": "c", "amount": "100"}])
    assert sum(to_scaled(line["amount"]) for line in plan["allocation_lines"]) == 200 * SCALE
    assert sum(to_scaled(leg["amount"]) for leg in plan["cash_legs"]) == 100 * SCALE
    final = applied(initial, plan)
    assert all(final.remaining(row["id"]) == 0 for row in final.shares.values())
    assert set(final.claimed.values()) == {100 * SCALE}
    assert all(value == 0 for value in final.precise_net.values())
    with pytest.raises(CoverageError):
        plan_direct_allocations(final, [{"share_id": share(final, "ab", "a")["id"], "amount": "1"}])


def test_dependent_cash_legs_are_a_single_conserving_bundle(monkeypatch):
    from services import coverage_allocations
    initial = build_coverage_snapshot(ledger([expense("ac", 100, "c", ("a",)), expense("bd", 100, "d", ("b",))]))
    monkeypatch.setattr(coverage_allocations, "build_settlement_projection", lambda *_a, **_k: ([
        {"from_member_id": "a", "to_member_id": "d", "amount": 100},
        {"from_member_id": "b", "to_member_id": "c", "amount": 100},
    ], {}))
    plan = plan_group_allocations(initial, [{"from_member_id": "a", "to_member_id": "d", "amount": "50"}])
    assert sorted(leg["amount"] for leg in plan["cash_legs"]) == ["50", "50"]
    assert sum(leg["dependency"] for leg in plan["cash_legs"]) == 1
    assert sorted(line["amount"] for line in plan["allocation_lines"]) == ["50", "50"]
    assert len(plan["cycles"][0]["edges"]) == 4
    validate_plan(initial, plan)
    received = received_ledger(initial, plan)
    received.payments.pop()
    pending = build_coverage_snapshot(received, infer_history=False)
    with pytest.raises(CoverageError) as error:
        validate_allocation_bundle(pending, plan, [], approvals_for(pending, plan), actors(received.trip))
    assert error.value.code == "receipt_pending"


def test_database_order_does_not_change_allocation_and_later_expenses_do_not_move_confirmed_lines():
    data = ledger([expense(), expense("reverse", 80, "b", ("a",))])
    initial = build_coverage_snapshot(data)
    plan = plan_group_allocations(initial, [{"from_member_id": "b", "to_member_id": "a", "amount": "20"}])
    shuffled = deepcopy(data)
    random.Random(19).shuffle(shuffled.expenses)
    random.Random(20).shuffle(shuffled.revisions)
    other = build_coverage_snapshot(shuffled)
    assert other.snapshot_id == initial.snapshot_id
    assert plan == plan_group_allocations(other, [{"from_member_id": "b", "to_member_id": "a", "amount": "20"}])
    final = applied(initial, plan)
    before = deepcopy(share(final)["coverage_units"])
    later = deepcopy(final.ledger)
    # A later-created expense may have an earlier bill date.
    later.expenses.append(expense("later", 50, "a", ("b",), date="01-01-20", created_at="2026-10-03T00:00:00+00:00"))
    refreshed = build_coverage_snapshot(later)
    assert share(refreshed)["coverage_units"] == before
    assert refreshed.remaining(share(refreshed, "later")["id"]) == 50 * SCALE


@pytest.mark.parametrize("collection,status", [("payments", None), ("settlements", "paid"), ("settlements", None)])
def test_safe_historical_unique_inference_and_effective_legacy_sources(collection, status):
    data = ledger()
    row = {"id": "legacy", "amount": 40, "from_member_id": "b", "to_member_id": "a", "created_at": PAID}
    if status:
        row["status"] = status
    getattr(data, collection).append(row)
    result = build_coverage_snapshot(data)
    assert share(result)["coverage_units"]["historical_inferred"] == 40 * SCALE
    assert result.remaining(share(result)["id"]) == 60 * SCALE
    assert not result.blocked
    assert "Historically inferred" in share(result)["coverage_explanations"][0]["explanation"]


@pytest.mark.parametrize("case", ["ambiguous", "no_revision", "no_time", "fractional", "edited"])
def test_unresolved_history_retains_credit_and_never_reports_false_zero_settled(case):
    expenses = [expense(), expense("other")] if case == "ambiguous" else [expense()]
    data = ledger(expenses, frozen=case != "no_revision")
    row = {"id": "legacy", "amount": "40.5" if case == "fractional" else 40,
           "from_member_id": "b", "to_member_id": "a", "created_at": None if case == "no_time" else PAID}
    data.payments.append(row)
    if case == "edited":
        data.expenses[0]["amount"] = 120
        with pytest.raises(CoverageError) as error:
            build_coverage_snapshot(data)
        assert error.value.code == "share_revision_changed"
        return
    result = build_coverage_snapshot(data)
    public = coverage_response(result, {"id": "u_b"}, {"dinner"})
    assert public["expenses"][0]["settled_count"] is None
    assert public["expenses"][0]["remaining_amount"] is None
    assert public["unapplied_credit"][0]["amount"] == str(row["amount"])
    assert public["details"]["dinner"]["participants"][0]["actionable_amount"] is None
    assert not data.events


def test_explicit_historical_reference_is_labelled_inferred_and_invalid_reference_stays_credit():
    data = ledger(frozen=False)
    original = build_coverage_snapshot(data)
    row = share(original)
    data.payments = [{"id": "legacy", "amount": 100, "from_member_id": "b", "to_member_id": "a",
                      "expense_share_refs": [{"share_id": row["id"], "revision_id": row["revision_id"], "amount": "100"}]}]
    result = build_coverage_snapshot(data)
    assert result.remaining(row["id"]) == 0
    assert coverage_response(result, {"id": "u_b"})["expenses"][0]["inferred_settled_count"] == 1
    data.payments[0]["expense_share_refs"][0]["revision_id"] = "wrong"
    bad = build_coverage_snapshot(data)
    assert bad.remaining(row["id"]) == 100 * SCALE
    assert bad.blocked


def test_attempt_link_is_not_a_second_cash_source_but_two_posted_rows_remain_effective():
    data = ledger()
    data.payments = [{"id": "p", "amount": 40, "from_member_id": "b", "to_member_id": "a", "created_at": PAID,
                      "payment_attempt_id": "attempt"}]
    data.attempts = [{"id": "attempt", "status": "settled_recipient_confirmed", "linked_payment_id": "p", "posted_amount": 40}]
    single = build_coverage_snapshot(data)
    assert single.precise_net["a"] == 60 * SCALE
    data.payments.append({**data.payments[0], "id": "p2"})
    double = build_coverage_snapshot(data)
    assert double.precise_net["a"] == 20 * SCALE
    assert any(case["code"] == "suspected_duplicate_cash" for case in double.review_cases)


def family_trip():
    group = trip()
    group["members"] = group["members"][:2] + [{"id": "f", "kind": "family", "name": "Family",
        "family_members": ["One", "Two", "Three"], "family_member_ids": ["f1", "f2", "f3"],
        "family_member_user_ids": ["u_f1", "u_f2", "u_f3"]}]
    group["user_ids"].extend(["u_f1", "u_f2", "u_f3"])
    return group


@pytest.mark.parametrize("mode", ["PER_CAPITA", "PER_FAMILY", "EXACT"])
def test_family_wallet_funding_person_coverage_and_exclusions(mode):
    group = family_trip()
    extra = {"split_mode": mode, "family_participants": {"f": ["f1", "f2"]}}
    if mode == "EXACT":
        extra["custom_amounts"] = {"f1": 40, "f2": 60, "f3": 0, "a": 100}
    data = ledger([expense(amount=200, payer="f", people=("f", "a"), **extra)], group)
    result = build_coverage_snapshot(data)
    people = [row for row in result.shares.values() if row["wallet_id"] == "f"]
    assert sum(to_scaled(row["original_share"]) for row in people) == to_scaled(result.revisions[0]["entity_shares"]["f"])
    assert all(result.remaining(row["id"]) == 0 for row in people)
    public = coverage_response(result, {"id": "u_f1"})
    assert public["expenses"][0]["participant_count"] == 3
    assert public["expenses"][0]["settled_count"] == 2
    assert public["expenses"][0]["viewer_status"] == "covered"
    assert next(row for row in people if row["person_id"] == "f3")["participating"] is False
    assert result.revisions[0]["funding_person_id"] is None


def test_zero_rounded_people_are_participants_but_exact_zero_exclusions_are_not():
    group = family_trip()
    data = ledger([expense(amount=1, payer="a", people=("f",), family_participants={"f": ["f1", "f2", "f3"]})], group)
    result = build_coverage_snapshot(data)
    summary = coverage_response(result, {"id": "u_f2"})["expenses"][0]
    assert summary["participant_count"] == 3
    assert summary["settled_count"] == 2
    exact = ledger([expense(amount=1, payer="a", people=("f",), split_mode="EXACT",
                            custom_amounts={"f1": 1, "f2": 0, "f3": 0},
                            original_custom_amounts={"f1": "0.5", "f2": "0.5", "f3": "0"})], group)
    summary = coverage_response(build_coverage_snapshot(exact), {"id": "u_f2"})["expenses"][0]
    assert summary["participant_count"] == 2
    assert summary["settled_count"] == 1


def test_missing_family_roster_has_unknown_counts_and_retained_entity_obligation():
    group = family_trip()
    group["members"][-1]["family_member_ids"] = []
    data = ledger([expense(amount=90, people=("f",))], group, frozen=False)
    result = build_coverage_snapshot(data)
    assert result.precise_net["f"] == -90 * SCALE
    summary = coverage_response(result, {"id": "u_f1"})["expenses"][0]
    assert summary["participant_count"] is None and summary["settled_count"] is None
    assert all(row["person_id"] is None for row in result.shares.values())


def test_frozen_family_person_amounts_survive_renames_and_roster_changes_when_wallet_total_is_unchanged():
    group = family_trip()
    data = ledger([expense(amount=100, payer="a", people=("f",), split_mode="PER_FAMILY")], group)
    before = build_coverage_snapshot(data)
    data.trip["members"][-1]["family_members"].append("Four")
    data.trip["members"][-1]["family_member_ids"].append("f4")
    after = build_coverage_snapshot(data)
    assert {row["person_id"]: row["original_share"] for row in before.shares.values()} == {
        row["person_id"]: row["original_share"] for row in after.shares.values()}


def test_refund_reverses_direction_and_never_fetches_or_changes_conversion_evidence():
    row = expense(amount=-100, original_currency="USD", original_amount="-1.23456",
                  exchange_rate="81.000001234", conversion_version=2,
                  conversion_history=[{"rate": "81.000001234", "provider": "historical", "effective_date": "2026-09-30"}])
    data = ledger([row])
    evidence = deepcopy(data.expenses)
    initial = build_coverage_snapshot(data)
    plan = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "40"}])
    assert plan["cash_legs"][0]["from_member_id"] == "a"
    assert plan["cash_legs"][0]["to_member_id"] == "b"
    final = applied(initial, plan)
    assert final.remaining(share(final)["id"]) == 60 * SCALE
    assert final.precise_net["a"] == -60 * SCALE
    assert data.expenses == evidence


def test_reversal_restores_coverage_as_credit_without_refunding_cash():
    initial = build_coverage_snapshot(ledger())
    final = applied(initial, plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "40"}]))
    data = deepcopy(final.ledger)
    data.events.append({"id": "reverse-event", "trip_id": "t", "sequence": 2, "kind": "reversal",
                        "policy_version": "expense_coverage_v1", "status": "applied", "reverses_event_id": "event-0"})
    reversed_snapshot = build_coverage_snapshot(data)
    assert reversed_snapshot.remaining(share(reversed_snapshot)["id"]) == 100 * SCALE
    assert reversed_snapshot.precise_net == final.precise_net
    assert coverage_response(reversed_snapshot, {"id": "u_b"})["unapplied_credit"][0]["amount"] == "40"


def test_tampered_plan_explanation_and_overcoverage_are_rejected():
    initial = build_coverage_snapshot(ledger())
    plan = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "100"}])
    changed = deepcopy(plan)
    changed["cycles"][0]["edges"][0]["id"] = "wrong"
    changed["plan_hash"] = fingerprint({key: value for key, value in changed.items() if key not in {"id", "plan_hash"}})
    with pytest.raises(CoverageError) as error:
        validate_plan(initial, changed)
    assert error.value.code == "invalid_explanation"
    with pytest.raises(CoverageError):
        plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "101"}])


def test_migration_adjustment_is_not_invented_coverage_and_conserves_wallets():
    data = ledger()
    data.adjustments = {"a": -10, "b": 10}
    result = build_coverage_snapshot(data)
    assert result.precise_net["a"] == 90 * SCALE
    assert result.remaining(share(result)["id"]) == 100 * SCALE
    assert any(case["code"] == "accounting_adjustment_review" for case in result.review_cases)


def test_many_directed_graphs_conserve_and_complete_with_independent_wallet_oracles():
    for seed in range(60):
        rng = random.Random(seed)
        expenses, expected = [], {key: 0 for key in "abcd"}
        for index in range(12):
            payer, debtor = rng.sample(list("abcd"), 2)
            amount = rng.randrange(1, 120)
            expenses.append(expense(f"e{index:02}", amount, payer, (debtor,)))
            expected[payer] += amount * SCALE
            expected[debtor] -= amount * SCALE
        initial = build_coverage_snapshot(ledger(expenses))
        assert initial.precise_net == expected
        from services.settlement_engine import build_settlement_projection
        transfers, _ = build_settlement_projection(initial.precise_net, "INR", whole_unit_enabled=True)
        plan = plan_group_allocations(initial, transfers) if transfers else plan_offset_allocations(initial, list(initial.shares))
        validate_plan(initial, plan)
        final = applied(initial, plan)
        assert all(final.remaining(row["id"]) == 0 for row in final.shares.values())
        assert all(value == 0 for value in final.precise_net.values())


@pytest.mark.parametrize("stale_admin", [False, True])
def test_receipt_permission_requires_current_trip_access_even_if_account_link_remains(stale_admin):
    initial = build_coverage_snapshot(ledger())
    plan = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "40"}])
    data = received_ledger(initial, plan)
    known_actors = actors(data.trip)
    data.trip["user_ids"].remove("u_a")
    if stale_admin:
        data.trip["admin_ids"].append("u_a")
    current = build_coverage_snapshot(data, infer_history=False)
    uses = cash_uses_for_plan(current, plan, {plan["cash_legs"][0]["id"]: "payments:cash-0-0"})
    with pytest.raises(CoverageError) as error:
        validate_allocation_bundle(current, plan, uses, approvals_for(current, plan), known_actors)
    assert error.value.code == "receipt_pending"


@pytest.mark.parametrize("fault", ["hash", "revision", "intent"])
def test_untrusted_pending_plan_is_review_work_and_never_reserves_or_covers(fault):
    initial = build_coverage_snapshot(ledger())
    plan = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "40"}], intent_id="pending")
    if fault == "hash":
        plan["allocation_lines"][0]["amount"] = "50"
    else:
        if fault == "revision":
            plan["allocation_lines"][0]["revision_id"] = "missing-revision"
        else:
            plan["reservation_intent_id"] = "some-other-intent"
        plan["plan_hash"] = fingerprint({key: value for key, value in plan.items() if key not in {"id", "plan_hash"}})
    initial.ledger.intents = [{"id": "pending", "status": "reported", "plan": plan}]
    result = build_coverage_snapshot(initial.ledger)
    assert result.remaining(share(result)["id"]) == 100 * SCALE
    assert not share(result)["reservations"]
    assert result.pending_reports[0]["status"] == "needs_review"
    assert result.blocked
    public = coverage_response(result, {"id": "u_b"})
    assert public["expenses"][0]["remaining_amount"] is None
    assert public["expenses"][0]["review_reasons"] == ["invalid_pending_plan"]


def test_competing_valid_reservations_block_actions_with_known_original_obligation():
    initial = build_coverage_snapshot(ledger())
    data = initial.ledger
    for intent_id in ("one", "two"):
        plan = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "60"}], intent_id=intent_id)
        data.intents.append({"id": intent_id, "status": "reported", "plan": plan})
    result = build_coverage_snapshot(data)
    assert sum(share(result)["reservations"].values()) == 120 * SCALE
    assert result.remaining(share(result)["id"]) == 100 * SCALE
    assert any(case["code"] == "conflicting_reservations" for case in result.review_cases)
    with pytest.raises(CoverageError) as error:
        plan_direct_allocations(result, [{"share_id": share(result)["id"], "amount": "1"}])
    assert error.value.code == "reconciliation_required"


def test_explicit_legacy_refs_cannot_invent_consent_for_an_offset():
    data = ledger([expense(), expense("reverse", 80, "b", ("a",))])
    initial = build_coverage_snapshot(data)
    refs = [{"share_id": row["id"], "revision_id": row["revision_id"], "amount": str(amount)}
            for row, amount in ((share(initial), 100), (share(initial, "reverse", "a"), 80))]
    data.payments.append({"id": "p", "amount": 20, "from_member_id": "b", "to_member_id": "a",
                          "created_at": PAID, "expense_share_refs": refs})
    result = build_coverage_snapshot(data)
    assert result.claimed == {}
    assert result.remaining(share(result)["id"]) == 100 * SCALE
    assert result.remaining(share(result, "reverse", "a")["id"]) == 80 * SCALE
    assert result.precise_net["a"] == 0
    assert coverage_response(result, {"id": "u_b"})["unapplied_credit"][0]["amount"] == "20"


def test_broken_historical_refs_stay_credit_and_are_not_partial_allocations():
    data = ledger()
    data.payments.append({"id": "p", "amount": 40, "from_member_id": "b", "to_member_id": "a",
                          "created_at": PAID, "expense_share_refs": [{"amount": 40}]})
    result = build_coverage_snapshot(data)
    assert result.claimed == {} and result.blocked
    assert result.remaining(share(result)["id"]) == 100 * SCALE


def test_missing_historical_family_person_is_opaque_without_inventing_a_replacement():
    group = family_trip()
    group["members"][-1]["family_member_ids"].remove("f2")
    group["members"][-1]["family_members"].remove("Two")
    data = ledger([expense(amount=90, people=("f",), split_mode="EXACT",
                           custom_amounts={"f2": 90}, family_member_entity_snapshots={"f2": "f"})], group, frozen=False)
    result = build_coverage_snapshot(data)
    assert result.precise_net["f"] == -90 * SCALE
    assert list(result.shares.values())[0]["person_id"] is None
    public = coverage_response(result, {"id": "u_f1"})
    assert public["expenses"][0]["participant_count"] is None
    assert public["expenses"][0]["remaining_amount"] is None


def test_nonzero_expense_without_authoritative_participants_is_unavailable():
    data = LedgerSnapshot({"id": "t", "members": [], "currency": "INR"}, [expense()])
    with pytest.raises(CoverageError) as error:
        build_coverage_snapshot(data)
    assert error.value.code == "historical_participants_unknown"


def test_confirmed_family_coverage_survives_removal_from_current_roster():
    data = ledger([expense(amount=90, people=("f",), split_mode="PER_FAMILY")], family_trip())
    initial = build_coverage_snapshot(data)
    plan = plan_direct_allocations(initial, [{"share_id": share(initial, person="f2")["id"], "amount": "30"}])
    final = applied(initial, plan)
    data = deepcopy(final.ledger)
    for key, value in (("family_member_ids", "f2"), ("family_members", "Two"), ("family_member_user_ids", "u_f2")):
        data.trip["members"][-1][key].remove(value)
    result = build_coverage_snapshot(data)
    assert share(result, person="f2")["coverage_units"] == share(final, person="f2")["coverage_units"]
    assert result.remaining(share(result, person="f2")["id"]) == 0
    assert result.precise_net == final.precise_net


def test_duplicate_effective_ledger_rows_are_credit_until_reviewed_not_two_safe_inferences():
    data = ledger()
    data.payments = [{"id": key, "amount": 40, "from_member_id": "b", "to_member_id": "a",
                      "created_at": PAID, "payment_attempt_id": "attempt"} for key in ("p1", "p2")]
    result = build_coverage_snapshot(data)
    assert result.claimed == {}
    assert share(result)["coverage_units"]["historical_inferred"] == 0
    assert result.precise_net["a"] == 20 * SCALE
    assert sum(to_scaled(row["amount"]) for row in coverage_response(result, {"id": "u_b"})["unapplied_credit"]) == 80 * SCALE


def test_allocation_creation_order_compares_absolute_timestamps_and_remainder_is_stable():
    initial = build_coverage_snapshot(ledger([
        expense("e0", 100, created_at="2026-10-01T00:00:00+00:00"),
        expense("e1", 100, created_at="2026-10-01T01:00:00+05:30"),
    ]))
    plan = plan_group_allocations(initial, [{"from_member_id": "b", "to_member_id": "a", "amount": "50"}])
    assert plan["allocation_lines"][0]["share_id"] == share(initial, "e1")["id"]
    assert plan["allocation_lines"][0]["amount"] == "50"


def test_frozen_conversion_evidence_and_recorded_actual_cash_people_are_retained():
    data = ledger([expense(original_amount="1.23456789", original_currency="USD", exchange_rate="81.000001234")])
    initial = build_coverage_snapshot(data)
    evidence = initial.revisions[0]["conversion_evidence"]
    assert evidence["exchange_rate"] == "81.000001234"
    data.payments.append({"id": "p", "amount": 40, "from_member_id": "b", "to_member_id": "a",
                          "created_at": PAID, "actual_payer_person_id": "b", "actual_receiver_person_id": "a"})
    result = build_coverage_snapshot(data)
    participant = coverage_response(result, {"id": "u_b"}, {"dinner"})["details"]["dinner"]["participants"][0]
    cash = participant["coverage_explanations"][0]["cash_legs"][0]
    assert cash["actual_payer_person_id"] == "b" and cash["actual_receiver_person_id"] == "a"
    data.expenses[0]["exchange_rate"] = "82.000001234"
    with pytest.raises(CoverageError) as error:
        build_coverage_snapshot(data)
    assert error.value.code == "share_revision_changed"
