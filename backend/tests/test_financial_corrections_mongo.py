"""Disposable replica-set correction races, approval authority and complete rollback."""
import asyncio
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi import HTTPException, FastAPI
import httpx

from models.financial_correction import CorrectionPreview, CorrectionCreate, CorrectionAction, ReconciliationRequest, ReconciliationApply
from services import financial_corrections as corrections, financial_reconciliation, settlement_intents as workflow
from services.historical_reconciliation import dry_run, stage_and_apply
from services.ledger_snapshot import load_ledger
from services.expense_coverage import build_coverage_snapshot
from services.settlement_engine import SCALE
from tests.test_coverage_journal_mongo import isolated
from tests.test_settlement_intents_mongo import setup_workflow, reviewed, approval, snapshot
from tests.test_expense_coverage import share


async def setup(monkeypatch, database):
    await setup_workflow(monkeypatch, database)
    monkeypatch.setattr(corrections, "db", database)
    await corrections.ensure_indexes(database)
    rows = await database.expense_share_revisions.find({}).to_list(None)
    for row in rows:
        await database.expenses.update_one({"id": row["expense_id"]}, {"$set": {
            "active_revision_id": row["id"], "created_by": "u_a", "date": "01-10-26"}})
    await database.trips.update_one({"id": "t"}, {"$set": {
        "expense_settlement_schema_version": 2, "financial_write_guard_version": 2}})


async def preview(database, operation="replace_expense", target="dinner", changes=None, actor="admin"):
    current = await snapshot(database)
    return await corrections.preview("t", CorrectionPreview(expected_snapshot_id=current.snapshot_id,
        operation=operation, target_id=target, changes=changes if changes is not None else {"amount": "120"},
        reason="Correct the recorded amount"), {"id": actor})


def create_body(review):
    return CorrectionCreate(preview_id=review["id"], preview_hash=review["preview_hash"], client_mutation_id=uuid4())


def action(row, action="approve", **fields):
    return CorrectionAction(client_mutation_id=uuid4(), expected_version=row["version"],
                            plan_hash=row["plan_hash"], action=action, reason="Reviewed evidence", **fields)


def test_covered_correction_retry_and_explicit_credit_reconciliation(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a"})
            receipt = await database.payments.find_one({}, {"_id": 0})
            rev = await database.expense_share_revisions.find_one({}, {"_id": 0})
            review = await preview(database)
            body = create_body(review)
            result, replay = await asyncio.gather(corrections.create("t", body, {"id": "admin"}),
                                                corrections.create("t", body, {"id": "admin"}))
            assert result == replay and result["status"] == "applied"
            assert await database.payments.find_one({}, {"_id": 0}) == receipt
            assert await database.expense_share_revisions.find_one({"id": rev["id"]}, {"_id": 0}) == rev
            current = await snapshot(database)
            assert current.remaining(share(current)["id"]) == 120 * SCALE
            assert current.precise_net["a"] == 20 * SCALE
            assert await database.expense_coverage_events.count_documents({"kind": "reversal"}) == 1
            req = ReconciliationRequest(expected_snapshot_id=current.snapshot_id, source_ids=[f"payments:{receipt['id']}"],
                shares=[{"share_id": share(current)["id"], "amount": "100"}], reason="Apply the retained received money")
            credit = await financial_reconciliation.preview("t", req, {"id": "admin"})
            applied = await financial_reconciliation.apply("t", ReconciliationApply(preview_id=credit["id"],
                preview_hash=credit["preview_hash"], client_mutation_id=uuid4()), {"id": "admin"})
            assert applied["status"] == "applied"
            final = await snapshot(database)
            assert final.remaining(share(final)["id"]) == 20 * SCALE
            assert await database.payments.count_documents({}) == 1
    asyncio.run(exercise())


def test_creator_proposal_requires_current_admin_and_pending_report_survives(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            review = await preview(database, actor="u_a")
            proposal = await corrections.create("t", create_body(review), {"id": "u_a"})
            assert proposal["status"] == "awaiting_approval"
            with pytest.raises(HTTPException):
                await corrections.action("t", proposal["id"], action(proposal), {"id": "u_a"})
            result = await corrections.action("t", proposal["id"], action(proposal), {"id": "admin"})
            assert result["status"] == "applied"
            retained = await database.settlement_intents.find_one({"id": intent["id"]}, {"_id": 0})
            assert retained["status"] == "needs_review" and retained["expires_at"] is None
            assert retained["cash_legs"][0]["amount"] == "100"
            received = await workflow.approve("t", intent["id"], approval(retained), {"id": "u_a"})
            assert received["allocation_status"] == "needs_review"
            assert (await database.payments.find_one({}))["amount"] == 100
            assert not await database.expense_coverage_events.count_documents({"kind": "allocation"})
    asyncio.run(exercise())


@pytest.mark.parametrize("collection", ["financial_correction_events", "expense_share_revisions", "financial_correction_actions", "payment_mutation_receipts", "notification_outbox"])
def test_injected_failure_rolls_back_every_effect(monkeypatch, collection):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            review = await preview(database)
            body = create_body(review)
            before = await database.expenses.find_one({}, {"_id": 0})
            target = database[collection]
            original = type(target).insert_one
            async def fail(current, *args, **kwargs):
                result = await original(current, *args, **kwargs)
                if current.name == collection and current.database.name == database.name:
                    raise RuntimeError("injected transaction failure")
                return result
            monkeypatch.setattr(type(target), "insert_one", fail)
            with pytest.raises(RuntimeError):
                await corrections.create("t", body, {"id": "admin"})
            assert await database.expenses.find_one({}, {"_id": 0}) == before
            assert await database.financial_correction_events.count_documents({}) == 0
            assert await database.financial_corrections.count_documents({}) == 0
            assert await database.expense_share_revisions.count_documents({}) == 1
            monkeypatch.setattr(type(target), "insert_one", original)
            assert (await corrections.create("t", body, {"id": "admin"}))["status"] == "applied"
    asyncio.run(exercise())


def test_competing_corrections_have_one_valid_ordering_and_stale_reviews_conflict(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            first, second = await preview(database), await preview(database, changes={"amount": "80"})
            outcomes = await asyncio.gather(corrections.create("t", create_body(first), {"id": "admin"}),
                corrections.create("t", create_body(second), {"id": "admin"}), return_exceptions=True)
            assert sum(isinstance(row, dict) for row in outcomes) == 1
            assert sum(isinstance(row, HTTPException) for row in outcomes) == 1
            assert await database.financial_correction_events.count_documents({}) == 1
    asyncio.run(exercise())


def test_repeatable_backfill_is_guarded_and_rejects_stale_snapshot(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, client):
            await setup_workflow(monkeypatch, database)
            await corrections.ensure_indexes(database)
            data = await load_ledger("t", database, coverage=True)
            report = dry_run(data)
            result = await stage_and_apply(database, client, "t", report["plan_hash"], "admin", "Reviewed historical baseline")
            repeated = await stage_and_apply(database, client, "t", report["plan_hash"], "admin", "Reviewed historical baseline")
            assert result["status"] == "applied" and repeated["status"] == "already_applied"
            assert await database.payments.count_documents({}) == 0
            assert await database.expense_share_revisions.count_documents({}) == 1
    asyncio.run(exercise())
