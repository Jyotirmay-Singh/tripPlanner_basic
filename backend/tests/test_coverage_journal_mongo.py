"""Real transactions against an explicitly selected disposable loopback replica set."""

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
import os
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.read_concern import ReadConcern

from services import coverage_journal, ledger_transactions
from services.coverage_allocations import cash_uses_for_plan, plan_direct_allocations, plan_group_allocations
from services.coverage_support import CoverageError
from services.expense_coverage import build_coverage_snapshot
from services.ledger_snapshot import load_ledger
from services.settlement_engine import SCALE
from tests.test_expense_coverage import actors, approvals_for, expense, ledger, share, PAID


@asynccontextmanager
async def isolated(monkeypatch, *, reverse=False):
    url = os.environ.get("COVERAGE_TEST_MONGO_URL")
    if not url:
        pytest.skip("Set COVERAGE_TEST_MONGO_URL to a disposable local replica set")
    if urlparse(url).hostname not in {"localhost", "127.0.0.1"}:
        pytest.fail("Coverage journal tests require a loopback test MongoDB")
    client = AsyncIOMotorClient(url, serverSelectionTimeoutMS=1500)
    database = client[f"trip_splitter_coverage_test_{uuid4().hex}"]
    try:
        hello = await client.admin.command("hello")
        assert hello.get("setName"), "A transaction-capable test replica set is required"
        monkeypatch.setattr(ledger_transactions, "client", client)
        monkeypatch.setattr(coverage_journal, "db", database)
        monkeypatch.setattr(coverage_journal, "EXPENSE_SETTLEMENT_ENABLED", True)
        await coverage_journal.ensure_coverage_indexes(database)
        data = ledger([expense(), expense("reverse", 80, "b", ("a",))] if reverse else None)
        data.trip.update(expense_settlement_activation_version=1, financial_write_guard_version=1)
        await database.trips.insert_one(deepcopy(data.trip))
        await database.users.insert_many(list(actors(data.trip).values()))
        await database.expenses.insert_many(deepcopy(data.expenses))
        await database.expense_share_revisions.insert_many(deepcopy(data.revisions))
        yield database, data, client
    finally:
        # This generated namespace is the only database these tests ever remove.
        await client.drop_database(database.name)
        client.close()


async def seed_received(database, initial, plan, *, consent=True):
    cash_legs = []
    for leg in plan["cash_legs"]:
        cash_id = str(uuid4())
        await database.payments.insert_one({"id": cash_id, "trip_id": "t", "created_at": PAID,
                                            "from_member_id": leg["from_member_id"], "to_member_id": leg["to_member_id"],
                                            "amount": leg["amount"], "settlement_intent_id": plan["reservation_intent_id"]})
        cash_legs.append({**leg, "source_id": f"payments:{cash_id}"})
    approvals = approvals_for(initial, plan, consent=consent)
    await database.settlement_intents.insert_one({"id": plan["reservation_intent_id"], "trip_id": "t",
                                                   "status": "awaiting_consent", "plan": deepcopy(plan),
                                                   "cash_legs": cash_legs, "approvals": approvals})
    current = build_coverage_snapshot(await load_ledger("t", database, coverage=True), infer_history=False)
    uses = cash_uses_for_plan(current, plan, {leg["id"]: leg["source_id"] for leg in cash_legs})
    return uses, approvals


async def append(plan, uses, approvals, *, mutation=None, actor="u_b"):
    return await coverage_journal.append_coverage_event("t", plan=plan, cash_uses=uses, approvals=approvals,
                                                        actor_user_id=actor, client_mutation_id=mutation or str(uuid4()))


def test_real_atomic_retry_and_competing_source_claims(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, data, _client):
            initial = build_coverage_snapshot(data)
            plan = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "40"}], intent_id=str(uuid4()))
            uses, approvals = await seed_received(database, initial, plan)
            mutation = str(uuid4())
            first, replay = await asyncio.gather(append(plan, uses, approvals, mutation=mutation),
                                                  append(plan, uses, approvals, mutation=mutation))
            assert first == replay
            assert await database.expense_coverage_events.count_documents({}) == 1
            assert await database.payments.count_documents({}) == 1
            assert (await database.trips.find_one({"id": "t"}))["version"] == 1
            final = build_coverage_snapshot(await load_ledger("t", database, coverage=True))
            assert final.remaining(share(final)["id"]) == 60 * SCALE
            assert final.precise_net["a"] == 60 * SCALE
            assert set(final.claimed.values()) == {40 * SCALE}
            with pytest.raises(CoverageError):
                await append(plan, uses, approvals)
            assert await database.expense_coverage_events.count_documents({}) == 1

        async with isolated(monkeypatch) as (database, data, _client):
            initial = build_coverage_snapshot(data)
            plan = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "100"}], intent_id=str(uuid4()))
            uses, approvals = await seed_received(database, initial, plan)
            results = await asyncio.gather(append(plan, uses, approvals), append(plan, uses, approvals), return_exceptions=True)
            assert sum(isinstance(result, dict) for result in results) == 1
            assert sum(isinstance(result, CoverageError) for result in results) == 1
            assert await database.expense_coverage_events.count_documents({}) == 1
            assert await database.payments.count_documents({}) == 1
    asyncio.run(exercise())


def test_real_cash_waits_for_durable_person_consent_and_forged_approval_is_rejected(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch, reverse=True) as (database, data, _client):
            initial = build_coverage_snapshot(data)
            plan = plan_group_allocations(initial, [{"from_member_id": "b", "to_member_id": "a", "amount": "20"}], intent_id=str(uuid4()))
            uses, receipt_only = await seed_received(database, initial, plan, consent=False)
            with pytest.raises(CoverageError) as pending:
                await append(plan, uses, receipt_only)
            assert pending.value.code == "allocation_consent_pending"
            forged = approvals_for(initial, plan)
            with pytest.raises(CoverageError) as unavailable:
                await append(plan, uses, forged)
            assert unavailable.value.code == "approval_evidence_unavailable"
            assert await database.expense_coverage_events.count_documents({}) == 0
            pending_snapshot = build_coverage_snapshot(await load_ledger("t", database, coverage=True))
            assert pending_snapshot.precise_net["a"] == 0
            assert pending_snapshot.remaining(share(pending_snapshot)["id"]) == 100 * SCALE
            await database.settlement_intents.update_one({"id": plan["reservation_intent_id"]}, {"$set": {"approvals": forged}})
            await append(plan, uses, forged)
            final = build_coverage_snapshot(await load_ledger("t", database, coverage=True))
            assert final.remaining(share(final)["id"]) == 0
            assert share(final)["coverage_units"]["group"] == 20 * SCALE
            assert share(final)["coverage_units"]["approved_offset"] == 80 * SCALE
            assert await database.payments.count_documents({}) == 1
    asyncio.run(exercise())


def test_real_transaction_rolls_back_all_metadata_and_reversal_never_posts_cash(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, data, client):
            initial = build_coverage_snapshot(data)
            plan = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "40"}], intent_id=str(uuid4()))
            uses, approvals = await seed_received(database, initial, plan)
            original_runner = coverage_journal.run_snapshot_transaction
            async def abort_after_callback(callback):
                async with await client.start_session() as session:
                    async with session.start_transaction(read_concern=ReadConcern("snapshot")):
                        await callback(session)
                        raise RuntimeError("Injected failure after journal insert")
            monkeypatch.setattr(coverage_journal, "run_snapshot_transaction", abort_after_callback)
            with pytest.raises(RuntimeError):
                await append(plan, uses, approvals)
            assert await database.expense_coverage_events.count_documents({}) == 0
            assert (await database.trips.find_one({"id": "t"}))["version"] == 0
            assert (await database.settlement_intents.find_one({"id": plan["reservation_intent_id"]}))["status"] == "awaiting_consent"
            assert await database.payments.count_documents({}) == 1
            monkeypatch.setattr(coverage_journal, "run_snapshot_transaction", original_runner)
            original = await append(plan, uses, approvals)
            before = build_coverage_snapshot(await load_ledger("t", database, coverage=True))
            mutation = str(uuid4())
            async def reverse():
                return await coverage_journal.append_coverage_event("t", actor_user_id="admin", client_mutation_id=mutation,
                    reverses_event_id=original["id"], reason="Approved correction; money retained as credit")
            reversed_event, same = await asyncio.gather(reverse(), reverse())
            assert reversed_event == same
            after = build_coverage_snapshot(await load_ledger("t", database, coverage=True))
            assert after.precise_net == before.precise_net
            assert after.remaining(share(after)["id"]) == 100 * SCALE
            assert await database.payments.count_documents({}) == 1
            assert await database.expense_coverage_events.count_documents({}) == 2
            with pytest.raises(CoverageError) as changed:
                await coverage_journal.append_coverage_event("t", actor_user_id="admin", client_mutation_id=str(uuid4()),
                    reverses_event_id=original["id"], reason="Cannot reverse twice")
            assert changed.value.code == "invalid_reversal"
    asyncio.run(exercise())


def test_feature_activation_and_transaction_gates_fail_without_journal_mutation(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, data, _client):
            initial = build_coverage_snapshot(data)
            plan = plan_direct_allocations(initial, [{"share_id": share(initial)["id"], "amount": "40"}], intent_id=str(uuid4()))
            uses, approvals = await seed_received(database, initial, plan)
            monkeypatch.setattr(coverage_journal, "EXPENSE_SETTLEMENT_ENABLED", False)
            with pytest.raises(CoverageError) as disabled:
                await append(plan, uses, approvals)
            assert disabled.value.code == "feature_disabled"
            monkeypatch.setattr(coverage_journal, "EXPENSE_SETTLEMENT_ENABLED", True)
            await database.trips.update_one({"id": "t"}, {"$unset": {"financial_write_guard_version": ""}})
            with pytest.raises(CoverageError) as gate:
                await append(plan, uses, approvals)
            assert gate.value.code == "group_not_ready"
            await database.trips.update_one({"id": "t"}, {"$set": {"financial_write_guard_version": 1}})
            async def unavailable(_callback):
                raise ledger_transactions.TransactionUnavailableError()
            monkeypatch.setattr(coverage_journal, "run_snapshot_transaction", unavailable)
            with pytest.raises(ledger_transactions.TransactionUnavailableError):
                await append(plan, uses, approvals)
            assert await database.expense_coverage_events.count_documents({}) == 0
            assert await database.payments.count_documents({}) == 1
    asyncio.run(exercise())
