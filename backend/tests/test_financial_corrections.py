"""Financial correction oracles: immutable evidence, gross progress and conserving reversals."""
import asyncio
from copy import deepcopy
from uuid import uuid4

import pytest

from models.expense import ExpenseUpdate
from models.financial_correction import CorrectionPreview
from services import financial_corrections as service
from services.coverage_allocations import plan_direct_allocations, plan_group_allocations, plan_offset_allocations
from services.coverage_support import CoverageError
from services.expense_coverage import build_coverage_snapshot
from services.financial_ledger import apply_effective_ledger, versioned_revision
from services.harmless_updates import metadata_changes
from services.historical_reconciliation import dry_run
from services.settlement_engine import SCALE, to_scaled
from tests.test_expense_coverage import applied, expense, ledger, share, CREATED, PAID


def version_two(data):
    data = deepcopy(data)
    data.trip.update(expense_settlement_activation_version=1, financial_write_guard_version=2,
                     expense_settlement_schema_version=2,
                     version=max([row.get("sequence", 0) for row in data.events] + [data.trip.get("version", 0)]))
    for row in data.expenses:
        row["active_revision_id"] = next(revision["id"] for revision in data.revisions if revision["expense_id"] == row["id"])
        row.setdefault("created_by", "u_a")
        row.setdefault("date", "01-10-26")
    apply_effective_ledger(data)
    return data


def planned(data, operation, target="dinner", changes=None, actor="admin"):
    current = build_coverage_snapshot(data, infer_history=False)
    return asyncio.run(service.plan(data.trip, {"id": actor}, data, CorrectionPreview(
        expected_snapshot_id=current.snapshot_id, operation=operation, target_id=target,
        changes=changes or {}, reason="Correct the recorded evidence"), str(uuid4()), PAID))


def effective(data, proposal):
    result = deepcopy(data)
    event = proposal["event"]
    result.events.extend(event["reversal_events"])
    result.revisions.extend(proposal["revisions"])
    changed = {row["id"]: row for row in proposal["expenses"]}
    result.expenses = [deepcopy(changed.pop(row["id"], row)) for row in (result.raw_expenses or result.expenses)]
    result.expenses.extend(changed.values())
    result.raw_expenses = deepcopy(result.expenses)
    result.corrections.append(event)
    result.trip["version"] += 1
    apply_effective_ledger(result)
    return result


@pytest.mark.parametrize("amount", [120, 80, -100])
def test_covered_amount_and_refund_sign_corrections_reopen_without_moving_cash(amount):
    initial = build_coverage_snapshot(ledger())
    covered = applied(initial, plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "100"}]))
    data = version_two(covered.ledger)
    evidence = deepcopy(data.raw_payments)
    revision = deepcopy(data.revisions[0])
    proposal = planned(data, "replace_expense", changes={"amount": str(amount)})
    assert proposal["requires_admin"]
    final = build_coverage_snapshot(effective(data, proposal), infer_history=False)
    assert final.remaining(share(final)["id"]) == abs(amount) * SCALE
    assert final.claimed.get("payments:cash-0-0", 0) == 0
    assert final.ledger.raw_payments == evidence and final.ledger.revisions[0] == revision
    assert proposal["effects"]["unapplied_credit"][0]["amount"] == "100"


def test_one_expense_edit_reverses_entire_group_bundle_and_its_offsets():
    initial = build_coverage_snapshot(ledger([expense(), expense("reverse", 80, "b", ("a",))]))
    covered = applied(initial, plan_group_allocations(initial, [{"from_member_id": "b", "to_member_id": "a", "amount": "20"}]))
    data = version_two(covered.ledger)
    proposal = planned(data, "replace_expense", changes={"amount": "120"})
    final = build_coverage_snapshot(effective(data, proposal), infer_history=False)
    assert proposal["event"]["reversed_event_ids"] == ["event-0"]
    assert final.remaining(share(final)["id"]) == 120 * SCALE
    assert final.remaining(share(final, "reverse", "a")["id"]) == 80 * SCALE
    assert len(final.ledger.payments) == 1 and final.ledger.payments[0]["amount"] == "20"
    effects = proposal["effects"]
    assert effects["affected_bundles"][0]["approval_count"] == len(data.events[0]["approval_evidence"])
    assert effects["affected_bundles"][0]["approval_count"] > 0
    assert set(effects["expense_names"]) == {"dinner", "reverse"}
    assert {row["expense_id"] for row in effects["before_shares"]} == {"dinner", "reverse"}
    assert effects["cash_sources"][0]["amount"] == "20"
    assert "transaction_reference" not in str(effects)


@pytest.mark.parametrize("operation,changes,new_money", [("replace_cash", {"amount": "60"}, 60), ("void_cash", {}, 0)])
def test_cash_compensation_preserves_receipt_and_reopens_consuming_allocations(operation, changes, new_money):
    initial = build_coverage_snapshot(ledger())
    data = version_two(applied(initial, plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "100"}])).ledger)
    evidence = deepcopy(data.raw_payments)
    proposal = planned(data, operation, "payments:cash-0-0", changes)
    final_data = effective(data, proposal)
    final = build_coverage_snapshot(final_data, infer_history=False)
    assert final.remaining(share(final)["id"]) == 100 * SCALE
    assert final.precise_net["a"] == (100 - new_money) * SCALE
    assert final_data.raw_payments == evidence
    assert proposal["effects"]["recorded_cash_changes"] == [{"before_amount": "100", "after_amount": str(new_money),
        "payer_wallet_id": "b", "receiver_wallet_id": "a"}]
    inverse = planned(final_data, "reverse_correction", proposal["event"]["id"])
    restored = build_coverage_snapshot(effective(final_data, inverse), infer_history=False)
    assert restored.precise_net["a"] == 0 and restored.remaining(share(restored)["id"]) == 100 * SCALE
    assert len(restored.ledger.payments) == 1 and restored.ledger.raw_payments == evidence


def test_repeated_financial_content_gets_new_revision_ids():
    data = version_two(ledger())
    first = versioned_revision(data.expenses[0], data.trip["members"], "t", 2, data.revisions[0]["id"], "operation1", CREATED)
    second = versioned_revision(data.expenses[0], data.trip["members"], "t", 3, first["id"], "operation2", CREATED)
    assert first["financial_fingerprint"] == second["financial_fingerprint"]
    assert first["id"] != second["id"] and first["shares"][0]["id"] != second["shares"][0]["id"]


def test_offset_reversal_preserves_approvals_and_posts_no_cash():
    initial = build_coverage_snapshot(ledger([expense(), expense("reverse", 100, "b", ("a",))]))
    data = version_two(applied(initial, plan_offset_allocations(initial, [share(initial)["id"]])).ledger)
    proposal = planned(data, "reverse_allocation", "event-0", actor="u_b")
    assert set(proposal["required_person_ids"]) == {"a", "b"}
    final = build_coverage_snapshot(effective(data, proposal), infer_history=False)
    assert not final.ledger.payments and not final.ledger.corrections[0]["cash_changes"]
    assert all(final.remaining(row["id"]) == 100 * SCALE for row in final.shares.values())


def test_echoed_financial_values_do_not_normalize_or_reconvert():
    row = expense(amount=100, date="01-10-26", description="Old", custom_amounts=None)
    assert metadata_changes(row, ExpenseUpdate(amount=100, currency="INR", split_mode="PER_CAPITA",
        paid_by_member_id="a", split_member_ids=["b"], description="New"), "INR") == {"description": "New"}
    with pytest.raises(CoverageError):
        metadata_changes(row, ExpenseUpdate(amount=120), "INR")
    with pytest.raises(CoverageError):
        planned(version_two(ledger()), "replace_expense", changes={"amount": "120", "custom_amounts": {"b": "119.5"}})


def test_dry_run_is_repeatable_redacted_and_leaves_ambiguous_cash_unallocated():
    data = ledger([expense(), expense("other", 100)])
    data.payments.append({"id": "p", "trip_id": "t", "amount": 100, "from_member_id": "b", "to_member_id": "a",
                          "created_at": PAID, "upi_id": "secret@address", "transaction_reference": "private"})
    before = deepcopy(data)
    a, b = dry_run(data), dry_run(data)
    assert a == b and data == before
    assert a["activation_blocked"] and a["counts"]["sources"] == 1
    assert "secret@address" not in str(a) and "private" not in str(a)
    assert not a["evidenced_direct_links"]


def test_version_one_datetime_fingerprints_replay_after_upgrade():
    from datetime import datetime, timezone
    from services.expense_coverage import make_share_revision
    data = ledger()
    data.expenses[0]["created_at"] = datetime(2026, 10, 1, tzinfo=timezone.utc)
    data.revisions = [make_share_revision(data.expenses[0], data.trip["members"], "t", recorded_at=CREATED, legacy=True)]
    initial = build_coverage_snapshot(data)
    old_id = initial.revisions[0]["id"]
    data.trip.update(expense_settlement_schema_version=2)
    data.expenses[0]["active_revision_id"] = old_id
    apply_effective_ledger(data)
    upgraded = build_coverage_snapshot(data, infer_history=False)
    assert upgraded.revisions[0]["id"] == old_id and upgraded.precise_net == initial.precise_net


def test_family_reassignment_keeps_frozen_wallets_and_person_amounts():
    group = ledger().trip
    group["owner_id"] = "u_a"
    group["members"].append({"id": "family", "name": "Family", "kind": "family", "family_members": ["One"],
        "family_member_ids": ["one"], "family_member_emails": [None], "family_member_user_ids": [None]})
    data = version_two(ledger(group=group))
    proposal = planned(data, "reassign_family", "b", {"person_id": "b", "destination_wallet_id": "family"})
    assert not proposal["revisions"] and not proposal["expenses"]
    moved = deepcopy(data)
    moved.trip["members"] = proposal["members"]
    moved.identities = [{"id": "old-b", "member_snapshot": data.trip["members"][1]}]
    apply_effective_ledger(moved)
    final = build_coverage_snapshot(moved, infer_history=False)
    assert share(final)["wallet_id"] == "b" and share(final)["original_share"] == "100"
    assert final.precise_net["b"] == -100 * SCALE and final.precise_net["family"] == 0


@pytest.mark.parametrize("changes", [
    {"paid_by_member_id": "c"},
    {"split_member_ids": ["b", "c"]},
    {"split_member_ids": ["b", "c"], "split_mode": "PER_FAMILY"},
    {"split_member_ids": ["b", "c"], "split_mode": "EXACT", "custom_amounts": {"b": "40", "c": "60"}},
])
def test_covered_payer_participant_and_split_edits_retain_evidence_and_conserve(changes):
    initial = build_coverage_snapshot(ledger())
    data = version_two(applied(initial, plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "100"}])).ledger)
    old = deepcopy(data.revisions[0])
    final = build_coverage_snapshot(effective(data, planned(data, "replace_expense", changes=changes)), infer_history=False)
    assert final.ledger.revisions[0] == old
    assert sum(to_scaled(row["original_share"]) for row in final.shares.values()) == 100 * SCALE
    assert sum(final.precise_net.values()) == 0
    assert final.claimed.get("payments:cash-0-0", 0) == 0
    assert len(final.ledger.payments) == 1


def foreign_covered():
    from bson.decimal128 import Decimal128
    row = expense(date="28-08-26", original_amount=1, original_currency="USD", exchange_rate=Decimal128("100"),
        exchange_rate_date="2026-08-28", exchange_rate_provider="historical-provider", conversion_version=1,
        conversion_history=[{"version": 1, "rate": Decimal128("100"), "provider": "historical-provider"}])
    initial = build_coverage_snapshot(ledger([row]))
    return version_two(applied(initial, plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "100"}])).ledger)


def test_echoed_canonical_foreign_amount_during_payer_correction_never_reconverts(monkeypatch):
    from unittest.mock import AsyncMock
    loader = AsyncMock(side_effect=AssertionError("Unchanged foreign inputs must not load a quote"))
    monkeypatch.setattr(service, "convert_expense", loader)
    data = foreign_covered()
    proposal = planned(data, "replace_expense", changes={"amount": "100", "paid_by_member_id": "c"})
    new = proposal["revisions"][0]["financial_snapshot"]
    assert new["original_amount"] == 1 and new["amount"] == 100 and new["conversion_version"] == 1
    assert new["exchange_rate"] == data.expenses[0]["exchange_rate"]
    loader.assert_not_awaited()


@pytest.mark.parametrize("source_currency", ["USD", "EUR"])
def test_reviewed_fx_or_original_currency_change_preserves_old_quote_and_receipt(monkeypatch, source_currency):
    from unittest.mock import AsyncMock
    from services import expense_conversion
    from tests.test_expense_conversion import quote
    data = foreign_covered()
    old = deepcopy(data.revisions[0])
    loader = AsyncMock(return_value=quote(source="1", source_currency=source_currency,
        target="120", target_currency="INR", rate="120"))
    monkeypatch.setattr(service, "MULTI_CURRENCY_EXPENSES_ENABLED", True)
    monkeypatch.setattr(expense_conversion, "load_quote", loader)
    proposal = planned(data, "replace_expense", changes={"original_amount": "1", "original_currency": source_currency,
        "conversion": {"mode": "automatic", "quote_id": "q1", "approved": True}})
    final = build_coverage_snapshot(effective(data, proposal), infer_history=False)
    assert final.remaining(share(final)["id"]) == 120 * SCALE
    assert final.ledger.revisions[0] == old
    assert final.revisions[0]["financial_snapshot"]["original_currency"] == source_currency
    assert final.revisions[0]["financial_snapshot"]["conversion_version"] == 2
    assert final.ledger.raw_payments[0]["amount"] == "100"
    assert final.claimed.get("payments:cash-0-0", 0) == 0
    loader.assert_awaited_once()
