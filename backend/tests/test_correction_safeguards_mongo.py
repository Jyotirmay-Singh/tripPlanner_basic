"""V2 acceptance scenarios use authenticated routes and disposable loopback databases."""
import asyncio
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from models.expense import ExpenseUpdate
from models.financial_correction import ReconciliationRequest, ReconciliationApply, ReviewedWrite
from models.settlement_intent import SettlementQuoteRequest, SettlementIntentCreate
from services import financial_corrections as corrections, financial_reconciliation, settlement_intents as workflow
from services import harmless_updates, receipt_versions, reviewed_adapters
from services.coverage_support import CoverageError
from services.historical_reconciliation import dry_run, stage_and_apply
from services.ledger_snapshot import load_ledger
from services.settlement_engine import SCALE
from tests.test_coverage_journal_mongo import isolated
from tests.test_expense_coverage import share
from tests.test_financial_corrections_mongo import setup, preview, create_body, action
from tests.test_settlement_intents_mongo import reviewed, approval, snapshot, setup_workflow, fake_upi_quote, leg_command


def test_recipient_profile_endpoint_cancels_unsent_and_retains_reported_money_atomically(monkeypatch):
    async def exercise():
        from routes import auth
        from utils import deps
        for reported in (False, True):
            async with isolated(monkeypatch) as (database, _, _):
                await setup(monkeypatch, database)
                monkeypatch.setattr(auth, "db", database)
                await fake_upi_quote(monkeypatch, database)
                _, body = await reviewed(database, method="upi")
                intent = await workflow.create("t", body, {"id": "u_b"})
                if reported:
                    intent = await workflow.leg_action("t", intent["id"], intent["cash_legs"][0]["id"],
                        leg_command(intent, "report_paid"), {"id": "u_b"})
                original_legs = (await database.settlement_intents.find_one({"id": intent["id"]}))["cash_legs"]
                app = FastAPI()
                app.include_router(auth.router, prefix="/api")
                app.dependency_overrides[deps.get_current_user] = lambda: {"id": "u_a", "upi_id": "receiver@upi"}
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
                    result = await http.patch("/api/auth/me", json={"upi_id": "replacement@upi"})
                    assert result.status_code == 200, result.text
                retained = await database.settlement_intents.find_one({"id": intent["id"]})
                assert retained["status"] == ("needs_review" if reported else "canceled")
                assert retained["cash_legs"] == original_legs
                assert (await database.users.find_one({"id": "u_a"}))["recipient_account_revision"] == 1
                assert await database.notification_outbox.count_documents({"event_type": "settlement.review_required"}) == 1
                assert await database.payments.count_documents({}) == 0
                if reported:
                    current = await workflow.approve("t", intent["id"], approval(retained), {"id": "u_a"})
                    assert current["allocation_status"] == "needs_review"
                    assert (await database.payments.find_one({}))["amount"] == 100
                    assert (await snapshot(database)).remaining(share(await snapshot(database))["id"]) == 100 * SCALE
    asyncio.run(exercise())


def test_profile_invalidation_outbox_failure_rolls_back_every_binding(monkeypatch):
    async def exercise():
        from routes import auth
        from models.auth import UpiProfileUpdate
        from services import push_notifications
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            monkeypatch.setattr(auth, "db", database)
            _, body = await reviewed(database)
            intent = await workflow.create("t", body, {"id": "u_b"})
            before = await database.trips.find_one({})
            async def fail(**kwargs):
                raise RuntimeError("injected notification failure")
            monkeypatch.setattr(push_notifications, "enqueue_notification_event", fail)
            with pytest.raises(RuntimeError):
                await auth.update_me(UpiProfileUpdate(upi_id="changed@upi"), {"id": "u_a"})
            assert (await database.users.find_one({"id": "u_a"})).get("recipient_account_revision") is None
            assert (await database.settlement_intents.find_one({"id": intent["id"]}))["status"] == intent["status"]
            assert await database.trips.find_one({}) == before
            assert await database.settlement_intent_actions.count_documents({"operation": "settlement.binding.invalidated"}) == 0
    asyncio.run(exercise())


def test_malformed_version_two_history_returns_guarded_diagnostic_without_writes(monkeypatch):
    async def exercise():
        from services.historical_reconciliation import load_review_report
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            await database.financial_correction_events.insert_one({"id": "broken", "trip_id": "t", "schema_version": 2})
            before = await database.trips.find_one({})
            report = await load_review_report("t", database)
            assert report["activation_blocked"] and report["snapshot_id"] is None
            assert report["review_cases"][0]["code"] == "malformed_accounting_history"
            assert await database.trips.find_one({}) == before
            assert await database.reconciliation_runs.count_documents({}) == 0
    asyncio.run(exercise())


def test_review_case_resolution_and_new_backfill_keep_one_source_baseline(monkeypatch):
    async def exercise():
        from services.historical_reconciliation import load_review_report
        async with isolated(monkeypatch) as (database, _, client):
            await setup(monkeypatch, database)
            await database.payments.insert_one({"id": "historical", "trip_id": "t", "amount": 100,
                "from_member_id": "b", "to_member_id": "a"})
            report = await load_review_report("t", database)
            first = await stage_and_apply(database, client, "t", report["plan_hash"], "admin", "Retain history")
            assert first["status"] == "applied"
            assert await database.reconciliation_cases.count_documents({"status": "open"}) > 0
            current = await snapshot(database)
            review = await financial_reconciliation.preview("t", ReconciliationRequest(expected_snapshot_id=current.snapshot_id,
                source_ids=["payments:historical"], shares=[{"share_id": share(current)["id"], "amount": "100"}],
                reason="Review and allocate the evidenced money"), {"id": "admin"})
            await financial_reconciliation.apply("t", ReconciliationApply(preview_id=review["id"], preview_hash=review["preview_hash"],
                client_mutation_id=uuid4()), {"id": "admin"})
            assert await database.reconciliation_cases.count_documents({"status": "open"}) == 0
            renewed = await load_review_report("t", database)
            assert not renewed["activation_blocked"]
            await stage_and_apply(database, client, "t", renewed["plan_hash"], "admin", "Recheck reviewed history")
            assert await database.cash_source_versions.count_documents({"version_number": 0}) == 1
            assert await database.payments.count_documents({}) == 1
    asyncio.run(exercise())


def test_family_submember_adapter_rejects_a_preview_for_another_person(monkeypatch):
    async def exercise():
        from routes.members import delete_family_member
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            group = await database.trips.find_one({"id": "t"})
            group["members"].append({"id": "owner", "name": "Owner", "kind": "individual", "user_id": "admin"})
            for member in group["members"]:
                member["email"] = f"{member['user_id']}@gmail.com"
                await database.users.update_one({"id": member["user_id"]}, {"$set": {"email": member["email"]}})
            family = {"id": "family", "name": "Family", "kind": "family", "family_members": ["One", "Two", "Three"],
                "family_member_ids": ["one", "two", "three"], "family_member_emails": [None, None, None],
                "family_member_user_ids": [None, None, None]}
            await database.trips.update_one({"id": "t"}, {"$set": {"members": group["members"] + [family]}})
            from routes import members
            from utils import deps
            monkeypatch.setattr(members, "db", database)
            monkeypatch.setattr(deps, "db", database)
            review = await preview(database, "update_member", "family", {
                "family_members": ["Two", "Three"], "family_member_ids": ["two", "three"]})
            with pytest.raises(HTTPException) as conflict:
                await delete_family_member("t", "family", "two", {"id": "admin"}, create_body(review))
            assert conflict.value.detail["code"] == "correction_target_changed"
            result = await delete_family_member("t", "family", "one", {"id": "admin"}, create_body(review))
            assert result["status"] == "applied"
            assert await database.payments.count_documents({}) == 0
    asyncio.run(exercise())


def test_financial_preview_does_not_restore_newer_receipt_or_harmless_metadata(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            await database.expenses.update_one({"id": "dinner"}, {"$set": {"receipt_id": "old-blob", "time": "10:00"}})
            review = await preview(database)
            attachment = await receipt_versions.switch("t", "dinner", "new-blob", {"id": "u_a"})
            await harmless_updates.expense_metadata("t", "dinner", ExpenseUpdate(description="New description", time="12:00"), {"id": "u_a"})
            await corrections.create("t", create_body(review), {"id": "admin"})
            expense = await database.expenses.find_one({"id": "dinner"})
            assert expense["receipt_version_id"] == attachment["receipt_version_id"]
            assert expense["receipt_id"] == "new-blob" and expense["time"] == "12:00"
            assert expense["description"] == "New description" and expense["amount"] == 120
            assert await database.receipt_versions.count_documents({"receipt_id": "old-blob"}) == 1
    asyncio.run(exercise())


def test_guarded_upgrade_allows_corrective_review_before_new_starts_are_activated(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            await database.trips.update_one({"id": "t"}, {"$unset": {"expense_settlement_activation_version": ""}})
            result = await corrections.create("t", create_body(await preview(database)), {"id": "admin"})
            assert result["status"] == "applied"
            with pytest.raises(HTTPException) as blocked:
                await reviewed(database)
            assert blocked.value.detail["code"] == "group_not_ready"
            assert await database.payments.count_documents({}) == 0
            assert not (await database.trips.find_one({"id": "t"})).get("expense_settlement_activation_version")
    asyncio.run(exercise())


def test_effective_report_xlsx_and_pdf_use_compensated_money_and_current_revisions(monkeypatch):
    async def exercise():
        import io
        from openpyxl import load_workbook
        from pypdf import PdfReader
        from routes import reports
        from utils import deps
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            await database.trips.update_one({"id": "t"}, {"$set": {"name": "Correction export", "travel_date": "01-10-26"}})
            await database.expenses.update_one({"id": "dinner"}, {"$set": {"category": "Food", "description": "Meal"}})
            await received(database)
            cash = await database.payments.find_one({})
            await corrections.create("t", create_body(await preview(database, "replace_cash", f"payments:{cash['id']}", {"amount": "60"})), {"id": "admin"})
            await corrections.create("t", create_body(await preview(database)), {"id": "admin"})
            monkeypatch.setattr(reports, "db", database)
            monkeypatch.setattr(deps, "db", database)
            monkeypatch.setattr(reports, "decode_token", lambda token: {"sub": "admin"})
            data = await reports.report("t", {"id": "admin"})
            assert data["total_expense"] == 120 and data["balances"]["net"]["a"] == 60
            xlsx = await reports.report_xlsx("t", "local-test-token")
            pdf = await reports.report_pdf("t", "local-test-token")
            async def content(response):
                return b"".join([part if isinstance(part, bytes) else part.encode() async for part in response.body_iterator])
            book = load_workbook(io.BytesIO(await content(xlsx)), data_only=True)
            review = " ".join(str(cell.value or "") for row in book["Financial Review"] for cell in row)
            pdf_text = " ".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(await content(pdf))).pages)
            assert "replace_cash" in review and "replace_expense" in review and "60 INR" in review
            assert "replace_cash" in pdf_text and "replace_expense" in pdf_text and "60 INR" in pdf_text
            payment_values = [cell.value for row in book["Payments"] for cell in row]
            assert 60 in payment_values and 100 not in payment_values
            assert await database.payments.count_documents({}) == 1
            assert (await database.payments.find_one({}))["amount"] == 100
    asyncio.run(exercise())


async def received(database):
    _, body = await reviewed(database)
    intent = await workflow.create("t", body, {"id": "u_b"})
    return await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a"})


def test_covered_deletion_and_compensating_reversal_keep_receipts_and_new_revision(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            await received(database)
            payment = await database.payments.find_one({}, {"_id": 0})
            old_revision = await database.expense_share_revisions.find_one({}, {"_id": 0})
            result = await corrections.create("t", create_body(await preview(database, "void_expense", changes={})), {"id": "admin"})
            empty = await snapshot(database)
            assert not empty.shares and empty.precise_net["a"] == -100 * SCALE
            assert (await database.expenses.find_one({}))["deleted_at"]
            inverse = await corrections.create("t", create_body(await preview(database, "reverse_correction", result["id"], {})), {"id": "admin"})
            final = await snapshot(database)
            assert inverse["status"] == "applied"
            assert final.remaining(share(final)["id"]) == 100 * SCALE
            assert final.revisions[0]["id"] != old_revision["id"]
            assert await database.payments.find_one({}, {"_id": 0}) == payment
            assert await database.expense_share_revisions.find_one({"id": old_revision["id"]}, {"_id": 0}) == old_revision
            with pytest.raises(HTTPException):
                await preview(database, "reverse_correction", result["id"], {})
    asyncio.run(exercise())


def test_harmless_updates_with_pending_and_confirmed_reports_keep_reservations_and_receipt_versions(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            _, body = await reviewed(database)
            intent = await workflow.create("t", body, {"id": "u_b"})
            for confirmed in (False, True):
                before = await snapshot(database)
                revisions = await database.expense_share_revisions.find({}, {"_id": 0}).to_list(None)
                await harmless_updates.expense_metadata("t", "dinner", ExpenseUpdate(amount=100, currency="INR", description=f"Updated {confirmed}"), {"id": "u_a"})
                await database.expenses.update_one({"id": "dinner"}, {"$set": {"receipt_id": "old-blob"}})
                first = await receipt_versions.switch("t", "dinner", "new-blob", {"id": "u_a"})
                await receipt_versions.switch("t", "dinner", None, {"id": "u_a"})
                assert await database.receipt_versions.count_documents({"receipt_id": "old-blob"}) >= 1
                assert (await database.receipt_versions.find_one({"id": first["receipt_version_id"]}))["receipt_id"] == "new-blob"
                after = await snapshot(database)
                assert after.shares == before.shares and after.claimed == before.claimed
                assert await database.expense_share_revisions.find({}, {"_id": 0}).to_list(None) == revisions
                if not confirmed:
                    intent = await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a"})
            assert await database.payments.count_documents({}) == 1
    asyncio.run(exercise())


def test_offset_view_has_no_effect_and_reversal_requires_current_person_quorum(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch, reverse=True) as (database, _, _):
            await database.expenses.update_one({"id": "reverse"}, {"$set": {"amount": 100}})
            from services.expense_coverage import make_share_revision
            row = await database.expenses.find_one({"id": "reverse"}, {"_id": 0})
            trip = await database.trips.find_one({"id": "t"}, {"_id": 0})
            await database.expense_share_revisions.delete_one({"expense_id": "reverse"})
            await database.expense_share_revisions.insert_one(make_share_revision(row, trip["members"], "t"))
            await setup(monkeypatch, database)
            current = await snapshot(database)
            quote = await workflow.quote("t", SettlementQuoteRequest(mode="offset", method="offset", expected_snapshot_id=current.snapshot_id,
                shares=[{"share_id": share(current)["id"], "amount": "100"}]), {"id": "u_b"})
            assert (await snapshot(database)).shares == current.shares
            assert await database.expense_coverage_events.count_documents({}) == 0
            intent = await workflow.create("t", SettlementIntentCreate(quote_id=quote["id"], quote_hash=quote["quote_hash"], client_mutation_id=uuid4()), {"id": "u_b"})
            for pid in ("a", "b"):
                intent = await workflow.approve("t", intent["id"], approval(intent, "consent", person_id=pid), {"id": f"u_{pid}"})
            assert intent["allocation_status"] == "applied"
            proposal = await corrections.create("t", create_body(await preview(database, "reverse_allocation", intent["coverage_event_id"], {}, "u_b")), {"id": "u_b"})
            proposal = await corrections.action("t", proposal["id"], action(proposal, "consent", person_id="a"), {"id": "u_a"})
            assert proposal["status"] == "awaiting_approval"
            # Account removal invalidates prior consent even if an obsolete trip link still exists.
            await database.users.delete_one({"id": "u_a"})
            proposal = await corrections.action("t", proposal["id"], action(proposal, "consent", person_id="b"), {"id": "u_b"})
            assert proposal["status"] == "awaiting_approval"
            proposal = await corrections.action("t", proposal["id"], action(proposal), {"id": "admin"})
            assert proposal["status"] == "applied"
            assert await database.payments.count_documents({}) == 0
            final = await snapshot(database)
            assert all(final.remaining(row["id"]) == 100 * SCALE for row in final.shares.values())
    asyncio.run(exercise())


def test_removal_then_reversal_reopens_archived_identity_without_access(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            roster = (await database.trips.find_one({"id": "t"}))["members"]
            roster.append({"id": "owner", "name": "Owner", "kind": "individual", "user_id": "admin"})
            for member in roster:
                member["email"] = f"{member['user_id']}@gmail.com"
                await database.users.update_one({"id": member["user_id"]}, {"$set": {"email": member["email"]}})
            await database.trips.update_one({"id": "t"}, {"$set": {"members": roster}})
            await received(database)
            removed = await corrections.create("t", create_body(await preview(database, "remove_member", "b", {})), {"id": "admin"})
            trip = await database.trips.find_one({"id": "t"})
            assert removed["status"] == "applied" and "u_b" not in trip["user_ids"]
            event = await database.expense_coverage_events.find_one({"kind": "allocation"})
            await corrections.create("t", create_body(await preview(database, "reverse_allocation", event["id"], {})), {"id": "admin"})
            final = await snapshot(database)
            assert share(final)["wallet_id"] == "b" and final.remaining(share(final)["id"]) == 100 * SCALE
            historical = next(row for row in final.ledger.accounting_members if row["id"] == "b")
            assert historical["archived"] and historical["user_id"] is None
            with pytest.raises(HTTPException) as denied:
                await corrections.history("t", {"id": "u_b"})
            assert denied.value.status_code == 403
    asyncio.run(exercise())


def test_zero_net_gross_positions_and_owner_operations_are_guarded(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            await database.payments.insert_one({"id": "credit", "trip_id": "t", "amount": 100, "from_member_id": "b", "to_member_id": "a"})
            assert (await snapshot(database)).precise_net["b"] == 0
            with pytest.raises(HTTPException) as blocked:
                await preview(database, "leave_group", "b", {}, "u_b")
            assert blocked.value.detail["code"] == "financial_departure_blocked"
            await database.users.insert_one({"id": "ordinary_admin", "name": "Reviewer"})
            await database.trips.update_one({"id": "t"}, {"$addToSet": {"admin_ids": "ordinary_admin", "user_ids": "ordinary_admin"}})
            with pytest.raises(HTTPException) as denied:
                await preview(database, "transfer_owner", "u_b", {}, "ordinary_admin")
            assert denied.value.status_code == 403
    asyncio.run(exercise())


def test_group_reconciliation_combines_sources_once_and_reversal_preserves_cash(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch, reverse=True) as (database, _, _):
            await setup(monkeypatch, database)
            for pid, amount in (("one", 8), ("two", 12)):
                await database.payments.insert_one({"id": pid, "trip_id": "t", "from_member_id": "b", "to_member_id": "a", "amount": amount})
            current = await snapshot(database)
            review = await financial_reconciliation.preview("t", ReconciliationRequest(mode="group", expected_snapshot_id=current.snapshot_id,
                source_ids=["payments:one", "payments:two"], cash_legs=[{"from_member_id": "b", "to_member_id": "a", "amount": "20"}], reason="Review both retained sources and the offset"), {"id": "admin"})
            body = ReconciliationApply(preview_id=review["id"], preview_hash=review["preview_hash"], client_mutation_id=uuid4())
            first = await financial_reconciliation.apply("t", body, {"id": "admin"})
            assert first == await financial_reconciliation.apply("t", body, {"id": "admin"})
            final = await snapshot(database)
            assert all(final.remaining(row["id"]) == 0 for row in final.shares.values())
            assert final.claimed == {"payments:one": 8 * SCALE, "payments:two": 12 * SCALE}
            event = await database.expense_coverage_events.find_one({"kind": "allocation"})
            await corrections.create("t", create_body(await preview(database, "reverse_allocation", event["id"], {})), {"id": "admin"})
            reopened = await snapshot(database)
            assert reopened.remaining(share(reopened)["id"]) == 100 * SCALE
            assert reopened.remaining(share(reopened, "reverse", "a")["id"]) == 80 * SCALE
            assert await database.payments.count_documents({}) == 2
    asyncio.run(exercise())


def test_historical_staging_resumes_and_does_not_publish_partial_records(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, client):
            await setup_workflow(monkeypatch, database)
            await corrections.ensure_indexes(database)
            report = dry_run(await load_ledger("t", database, coverage=True))
            original = type(database.reconciliation_staging).update_one
            writes = 0
            async def interrupt(collection, *args, **kwargs):
                nonlocal writes
                if collection.name == "reconciliation_staging":
                    writes += 1
                    if writes == 2:
                        raise RuntimeError("Interrupted staging")
                return await original(collection, *args, **kwargs)
            monkeypatch.setattr(type(database.reconciliation_staging), "update_one", interrupt)
            with pytest.raises(RuntimeError):
                await stage_and_apply(database, client, "t", report["plan_hash"], "admin", "Reviewed baseline", batch_size=1)
            assert await database.reconciliation_staging.count_documents({}) == 1
            assert (await database.trips.find_one({}))["financial_write_guard_version"] == 1
            monkeypatch.setattr(type(database.reconciliation_staging), "update_one", original)
            result = await stage_and_apply(database, client, "t", report["plan_hash"], "admin", "Reviewed baseline", batch_size=1)
            assert result["status"] == "applied"
            assert (await database.reconciliation_runs.find_one({}))["staged_count"] == 5
            assert (await stage_and_apply(database, client, "t", report["plan_hash"], "admin", "Reviewed baseline"))["status"] == "already_applied"
    asyncio.run(exercise())


def test_missing_indexes_malformed_duplicates_and_stale_backfill_fail_closed(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, client):
            await setup_workflow(monkeypatch, database)
            report = dry_run(await load_ledger("t", database, coverage=True))
            with pytest.raises(CoverageError) as missing:
                await stage_and_apply(database, client, "t", report["plan_hash"], "admin", "Review")
            assert missing.value.code == "correction_indexes_required"
            await database.financial_corrections.insert_many([{"id": "duplicate"}, {"id": "duplicate"}, {"status": "bad"}])
            issues = await corrections.inspect_index_data(database)
            assert any(row["duplicate_key_count"] and row["malformed_count"] for row in issues)
            with pytest.raises(CoverageError):
                await corrections.ensure_indexes(database)
            await database.financial_corrections.delete_many({})
            await corrections.ensure_indexes(database)
            await database.trips.update_one({"id": "t"}, {"$inc": {"version": 1}})
            with pytest.raises(CoverageError) as stale:
                await stage_and_apply(database, client, "t", report["plan_hash"], "admin", "Review")
            assert stale.value.code == "historical_snapshot_changed"
            assert await database.reconciliation_runs.count_documents({}) == 0
    asyncio.run(exercise())


def test_authenticated_legacy_cash_routes_cannot_bypass_and_reviewed_transition_is_one_alias(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            from routes import expenses, members, balances, payments, trips, expense_settlement
            from utils import deps, security
            import jwt
            from datetime import datetime, timezone, timedelta
            monkeypatch.setattr(deps, "db", database)
            monkeypatch.setattr(security, "JWT_SECRET", "disposable-correction-http-key-2026")
            app = FastAPI()
            for module in (expenses, members, balances, payments, trips, expense_settlement):
                monkeypatch.setattr(module, "db", database)
                app.include_router(module.router, prefix="/api")
            token = jwt.encode({"sub": "admin", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}, security.JWT_SECRET, algorithm="HS256")
            await database.settlements.insert_one({"id": "old", "trip_id": "t", "status": "pending", "amount": 100, "from_member_id": "b", "to_member_id": "a"})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"Authorization": f"Bearer {token}"}) as client:
                cash = {"amount": 100, "from_member_id": "b", "to_member_id": "a"}
                blocked = [("POST", "/payments", cash), ("POST", "/settle", cash), ("POST", "/settlements", cash),
                    ("PATCH", "/settlements/old", {"status": "paid"}), ("PATCH", "/expenses/dinner", {"amount": 120}),
                    ("DELETE", "/expenses/dinner", None), ("PATCH", "/members/b", {"name": "New"}),
                    ("DELETE", "/members/b", None), ("DELETE", "", None)]
                for method, path, body in blocked:
                    result = await client.request(method, f"/api/trips/t{path}", json=body)
                    assert result.status_code in {409, 428}, (path, result.text)
                assert await database.payments.count_documents({}) == 0
                assert await database.expense_coverage_events.count_documents({}) == 0
                quote, body = await reviewed(database)
                payer_token = jwt.encode({"sub": "u_b", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}, security.JWT_SECRET, algorithm="HS256")
                contract = ReviewedWrite(quote_id=quote["id"], quote_hash=quote["quote_hash"], client_mutation_id=body.client_mutation_id).model_dump(mode="json")
                result = await client.patch("/api/trips/t/settlements/old", json=contract, headers={"Authorization": f"Bearer {payer_token}"})
                assert result.status_code == 200, result.text
                intent = result.json()
                assert (await database.settlements.find_one({"id": "old"}))["reviewed_intent_id"] == intent["id"]
                # Other aliases cannot be smuggled into the same permanent mutation.
                altered = await client.patch("/api/trips/t/settlements/other", json=contract, headers={"Authorization": f"Bearer {payer_token}"})
                assert altered.status_code == 409
                await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a"})
                final = await snapshot(database)
                assert final.remaining(share(final)["id"]) == 0
                assert final.precise_net["a"] == 0
                assert await database.payments.count_documents({}) == 1
                assert (await database.settlements.find_one({"id": "old"}))["status"] == "pending"
    asyncio.run(exercise())


def test_reviewed_admin_revocation_endpoint_preserves_applied_evidence_and_denies_pending_approval(monkeypatch):
    async def exercise():
        from routes import trips, expense_settlement
        from utils import deps
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            await database.trips.update_one({"id": "t"}, {"$addToSet": {"admin_ids": "u_c"}})
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            await workflow.approve("t", intent["id"], approval(intent), {"id": "u_c"})
            receipt = await database.payments.find_one({})
            applied = await database.expense_coverage_events.find_one({"kind": "allocation"})
            proposal = await corrections.create("t", create_body(await preview(database, actor="u_a")), {"id": "u_a"})
            assert proposal["status"] == "awaiting_approval"
            review = await preview(database, "revoke_admin", "u_c", {})
            app = FastAPI()
            for module in (trips, expense_settlement):
                monkeypatch.setattr(module, "db", database)
                app.include_router(module.router, prefix="/api")
            app.dependency_overrides[deps.get_current_user] = lambda: {"id": "admin"}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                result = await client.request("DELETE", "/api/trips/t/admins/u_c", json=create_body(review).model_dump(mode="json"))
                assert result.status_code == 200, result.text
                assert result.json()["status"] == "applied"
                app.dependency_overrides[deps.get_current_user] = lambda: {"id": "u_c", "role": "admin"}
                denied = await client.post(f"/api/trips/t/corrections/{proposal['id']}/actions", json=action(proposal).model_dump(mode="json"))
                assert denied.status_code == 403, denied.text
            assert "u_c" not in (await database.trips.find_one({"id": "t"}))["admin_ids"]
            assert await database.payments.find_one({}) == receipt
            assert await database.expense_coverage_events.find_one({"kind": "allocation"}) == applied
            assert applied["approval_evidence"][0]["actor_user_id"] == "u_c"
            assert await database.expense_coverage_events.count_documents({"kind": "reversal"}) == 0
            assert (await database.financial_corrections.find_one({"id": proposal["id"]}))["status"] == "awaiting_approval"
            with pytest.raises(HTTPException) as stale:
                await corrections.action("t", proposal["id"], action(proposal), {"id": "admin"})
            assert stale.value.detail["code"] == "correction_dependencies_changed"
    asyncio.run(exercise())


@pytest.mark.parametrize("reported", [False, True])
def test_reviewed_relink_endpoint_keeps_person_identity_and_obsolete_recipient_evidence(monkeypatch, reported):
    async def exercise():
        from routes import expense_settlement
        from utils import deps
        async with isolated(monkeypatch) as (database, _, _):
            await setup(monkeypatch, database)
            trip = await database.trips.find_one({"id": "t"})
            for member in trip["members"]:
                member["email"] = f"{member['id']}@gmail.com"
                await database.users.update_one({"id": member["user_id"]}, {"$set": {"email": member["email"]}})
            trip["members"].append({"id": "owner", "name": "Owner", "kind": "individual", "user_id": "admin", "email": "owner@gmail.com"})
            await database.users.update_one({"id": "admin"}, {"$set": {"email": "owner@gmail.com"}})
            await database.users.insert_one({"id": "replacement", "email": "replacement@gmail.com"})
            await database.trips.update_one({"id": "t"}, {"$set": {"members": trip["members"]}})
            await fake_upi_quote(monkeypatch, database)
            _, request = await reviewed(database, method="upi")
            intent = await workflow.create("t", request, {"id": "u_b"})
            if reported:
                intent = await workflow.leg_action("t", intent["id"], intent["cash_legs"][0]["id"], leg_command(intent, "report_paid"), {"id": "u_b"})
            before = await database.settlement_intents.find_one({"id": intent["id"]})
            revisions = await database.expense_share_revisions.find({}).to_list(None)
            review = await preview(database, "link_person", "a", {"person_id": "a", "user_id": "replacement"})
            monkeypatch.setattr(expense_settlement, "db", database)
            app = FastAPI()
            app.include_router(expense_settlement.router, prefix="/api")
            app.dependency_overrides[deps.get_current_user] = lambda: {"id": "admin"}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                result = await client.post("/api/trips/t/corrections", json=create_body(review).model_dump(mode="json"))
                assert result.status_code == 200, result.text
                assert result.json()["status"] == "applied"
                app.dependency_overrides[deps.get_current_user] = lambda: {"id": "u_a"}
                denied = await client.get("/api/trips/t/corrections")
                assert denied.status_code == 403, denied.text
            current = await database.trips.find_one({"id": "t"})
            assert next(m for m in current["members"] if m["id"] == "a")["user_id"] == "replacement"
            assert "u_a" not in current["user_ids"] and "replacement" in current["user_ids"]
            assert await database.expense_share_revisions.find({}).to_list(None) == revisions
            retained = await database.settlement_intents.find_one({"id": intent["id"]})
            assert retained["cash_legs"] == before["cash_legs"]
            assert retained["status"] == ("needs_review" if reported else "canceled")
            assert retained["cash_legs"][0]["recipient"]["user_id"] == "u_a"
            assert await database.notification_outbox.count_documents({"event_type": "settlement.review_required"}) == 1
            if reported:
                with pytest.raises(HTTPException) as denied:
                    await workflow.approve("t", intent["id"], approval(retained), {"id": "u_a"})
                assert denied.value.status_code == 403
                confirmed = await workflow.approve("t", intent["id"], approval(retained), {"id": "admin"})
                assert confirmed["allocation_status"] == "needs_review"
                assert (await database.payments.find_one({}))["amount"] == 100
                assert (await snapshot(database)).remaining(share(await snapshot(database))["id"]) == 100 * SCALE
            assert await database.expense_coverage_events.count_documents({}) == 0
    asyncio.run(exercise())
