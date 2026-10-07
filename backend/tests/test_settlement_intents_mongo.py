"""Real Mongo transactions and authenticated HTTP; no serialization-lock substitutes."""
import asyncio
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
import httpx

from models.settlement_intent import SettlementQuoteRequest, SettlementIntentCreate, IntentApproval, IntentAction
from routes import expense_settlement
from services import settlement_intents as workflow, payment_idempotency, push_notifications
from services.coverage_support import CoverageError
from services.expense_coverage import build_coverage_snapshot
from services.ledger_snapshot import load_ledger
from services.settlement_engine import SCALE
from tests.test_coverage_journal_mongo import isolated
from tests.test_expense_coverage import expense, share, make_share_revision


async def setup_workflow(monkeypatch, database):
    monkeypatch.setattr(workflow, "db", database)
    monkeypatch.setattr(workflow, "EXPENSE_SETTLEMENT_ENABLED", True)
    monkeypatch.setattr(payment_idempotency, "_transaction_verified", True)
    monkeypatch.setattr(push_notifications, "db", database)
    monkeypatch.setattr(push_notifications, "PUSH_NOTIFICATIONS_ENABLED", True)
    await database.payment_mutation_receipts.create_index(
        [("actor_user_id", 1), ("operation", 1), ("client_mutation_id", 1)], unique=True)
    await database.expense_mutation_receipts.create_index(
        [("actor_user_id", 1), ("operation", 1), ("client_mutation_id", 1)], unique=True)
    await database.payment_attempts.create_index("id", unique=True)
    await database.payments.create_index("payment_attempt_id", unique=True,
        partialFilterExpression={"payment_attempt_id": {"$type": "string"}})
    await database.notification_outbox.create_index("event_key", unique=True)
    await workflow.ensure_indexes(database)


async def snapshot(database):
    return build_coverage_snapshot(await load_ledger("t", database, coverage=True))


async def reviewed(database, amount="100", mode="direct", method="cash"):
    current = await snapshot(database)
    body = {"mode": mode, "method": method, "expected_snapshot_id": current.snapshot_id,
            "parties": [{"from_member_id": "b", "to_member_id": "a", "payer_person_id": "b", "recipient_person_id": "a"}]}
    if mode == "direct":
        body["shares"] = [{"share_id": share(current)["id"], "amount": amount}]
    else:
        body["cash_legs"] = [{"from_member_id": "b", "to_member_id": "a", "amount": amount}]
    quote = await workflow.quote("t", SettlementQuoteRequest(**body), {"id": "u_b"})
    request = SettlementIntentCreate(quote_id=quote["id"], quote_hash=quote["quote_hash"],
        client_mutation_id=uuid4(), transaction_reference="private-evidence-123")
    return quote, request


def approval(intent, action="confirm_received", **extra):
    return IntentApproval(client_mutation_id=uuid4(), expected_intent_version=intent["version"],
        plan_hash=intent["plan"]["plan_hash"], action=action,
        leg_id=intent["cash_legs"][0]["id"] if intent["cash_legs"] else None, **extra)


def test_direct_gross_partial_and_simultaneous_receiver_admin_approval(monkeypatch):
    async def exercise():
        for reverse in (True, False):
            async with isolated(monkeypatch, reverse=reverse) as (database, _, _client):
                await setup_workflow(monkeypatch, database)
                _, request = await reviewed(database, "40")
                first, replay = await asyncio.gather(workflow.create("t", request, {"id": "u_b"}),
                    workflow.create("t", request, {"id": "u_b"}))
                assert first == replay
                assert await database.payments.count_documents({}) == 0
                with pytest.raises(HTTPException) as denied:
                    await workflow.approve("t", first["id"], approval(first), {"id": "u_b"})
                assert denied.value.status_code == 403
                a, b = await asyncio.gather(workflow.approve("t", first["id"], approval(first), {"id": "u_a"}),
                    workflow.approve("t", first["id"], approval(first), {"id": "admin"}))
                assert a == b and a["allocation_status"] == "applied"
                assert await database.payments.count_documents({}) == 1
                assert await database.expense_coverage_events.count_documents({}) == 1
                assert (await snapshot(database)).remaining(share(await snapshot(database))["id"]) == 60 * SCALE
                assert await database.notification_outbox.count_documents({}) == 3
                notices = await database.notification_outbox.find({}).to_list(None)
                for notice in notices:
                    assert "u_c" not in notice["recipient_user_ids"]
                    payload = push_notifications.build_expo_message(notice, {"token": "ExponentPushToken[test]"})
                    assert payload["data"]["payloadVersion"] == 2
                    assert payload["data"]["eventId"] == notice["event_id"]
                    if notice["event_type"] == "settlement.allocation_applied":
                        assert notice["source_id"] == first["id"]
                        assert payload["data"]["intentId"] == first["id"]
                    else:
                        assert notice["source_id"] == first["cash_legs"][0]["payment_attempt_id"]
                        assert payload["data"]["paymentAttemptId"] == notice["source_id"]
                    assert "UPI" not in payload["title"]
                assert "private-evidence-123" not in str(a)
                forged = request.model_copy(update={"transaction_reference": "different"})
                with pytest.raises(HTTPException) as changed:
                    await workflow.create("t", forged, {"id": "u_b"})
                assert changed.value.detail["code"] == "client_mutation_conflict"
    asyncio.run(exercise())


def test_group_receipt_is_credit_until_person_consent_and_reversal(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch, reverse=True) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            _, request = await reviewed(database, "20", "group")
            intent = await workflow.create("t", request, {"id": "u_b"})
            received = await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a"})
            assert received["allocation_status"] == "awaiting_consent"
            assert await database.payments.count_documents({}) == 1
            assert await database.expense_coverage_events.count_documents({}) == 0
            for pid in received["plan"]["required_person_ids"]:
                received = await workflow.approve("t", intent["id"], approval(received, "consent", person_id=pid), {"id": f"u_{pid}"})
            assert received["allocation_status"] == "applied"
            assert await database.payments.count_documents({}) == 1
            final = await snapshot(database)
            assert all(final.remaining(row["id"]) == 0 for row in final.shares.values())
            reversed_result = await workflow.approve("t", intent["id"], approval(received, "reverse_allocation", reason="Allocation corrected"), {"id": "admin"})
            assert reversed_result["allocation_status"] == "reversed"
            assert await database.payments.count_documents({}) == 1
            assert await database.expense_coverage_events.count_documents({"kind": "reversal"}) == 1
    asyncio.run(exercise())


def test_direct_group_competing_quotes_reserve_one_obligation(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch, reverse=True) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            _, direct = await reviewed(database)
            _, group = await reviewed(database, "20", "group")
            results = await asyncio.gather(workflow.create("t", direct, {"id": "u_b"}),
                workflow.create("t", group, {"id": "u_b"}), return_exceptions=True)
            assert sum(isinstance(r, dict) for r in results) == 1
            assert sum(isinstance(r, HTTPException) for r in results) == 1
            assert await database.settlement_intents.count_documents({}) == 1
            assert await database.payments.count_documents({}) == 0
    asyncio.run(exercise())


def test_changed_expense_and_revoked_membership_preserve_report(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            await database.expenses.update_one({"id": "dinner"}, {"$set": {"amount": 30}})
            await database.trips.update_one({"id": "t"}, {"$inc": {"version": 1}})
            received = await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a"})
            assert received["allocation_status"] == "needs_review"
            assert (await database.payments.find_one({}))["amount"] == 100
            assert await database.expense_coverage_events.count_documents({}) == 0
            await database.trips.update_one({"id": "t"}, {"$pull": {"user_ids": "u_a"}, "$inc": {"version": 1}})
            with pytest.raises(HTTPException) as denied:
                await workflow.approve("t", intent["id"], approval(received), {"id": "u_a"})
            assert denied.value.status_code == 403
            assert (await database.payment_attempts.find_one({}))["transaction_reference"] == "private-evidence-123"
    asyncio.run(exercise())


def test_atomic_failure_then_retry_and_kill_switch_resolution(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            command = approval(intent)
            original = workflow.append_coverage_event
            async def fail_after_journal(*args, **kwargs):
                await original(*args, **kwargs)
                raise RuntimeError("injected after journal write")
            monkeypatch.setattr(workflow, "append_coverage_event", fail_after_journal)
            with pytest.raises(RuntimeError):
                await workflow.approve("t", intent["id"], command, {"id": "u_a"})
            assert await database.payments.count_documents({}) == 0
            assert await database.expense_coverage_events.count_documents({}) == 0
            assert (await database.settlement_intents.find_one({}))["version"] == 0
            monkeypatch.setattr(workflow, "append_coverage_event", original)
            monkeypatch.setattr(workflow, "EXPENSE_SETTLEMENT_ENABLED", False)
            result = await workflow.approve("t", intent["id"], command, {"id": "u_a"})
            assert result["allocation_status"] == "applied"
            assert await workflow.approve("t", intent["id"], command, {"id": "u_a"}) == result
            with pytest.raises(HTTPException) as disabled:
                await reviewed(database, "20")
            assert disabled.value.detail["code"] == "feature_disabled"
    asyncio.run(exercise())


def test_authenticated_http_report_review_and_evidence_visibility(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            from utils import deps, security
            monkeypatch.setattr(deps, "db", database)
            monkeypatch.setattr(security, "JWT_SECRET", "disposable-settlement-http-key-2026")
            import jwt
            from datetime import datetime, timedelta, timezone
            def headers(uid):
                token = jwt.encode({"sub": uid, "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
                    "disposable-settlement-http-key-2026", algorithm="HS256")
                return {"Authorization": f"Bearer {token}"}
            app = FastAPI()
            app.include_router(expense_settlement.router, prefix="/api")
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated") as client:
                _, request = await reviewed(database, "40")
                response = await client.post("/api/trips/t/settlement-intents", headers=headers("u_b"), json=request.model_dump(mode="json"))
                assert response.status_code == 200, response.text
                intent = response.json()
                view = await client.get(f"/api/trips/t/settlement-intents/{intent['id']}", headers=headers("u_c"))
                assert view.status_code == 200 and view.json()["reports"] == [] and view.json()["action_history"] == []
                stale = approval(intent).model_copy(update={"expected_intent_version": 99})
                rejected = await client.post(f"/api/trips/t/settlement-intents/{intent['id']}/approvals", headers=headers("u_a"), json=stale.model_dump(mode="json"))
                assert rejected.status_code == 409 and rejected.json()["detail"]["code"] == "intent_changed"
                payer_view = await client.get(f"/api/trips/t/settlement-intents/{intent['id']}", headers=headers("u_b"))
                assert "private-evidence-123" in payer_view.text
                denied = await client.post(f"/api/trips/t/settlement-intents/{intent['id']}/approvals", headers=headers("u_b"), json=approval(intent).model_dump(mode="json"))
                assert denied.status_code == 403
                received = await client.post(f"/api/trips/t/settlement-intents/{intent['id']}/approvals", headers=headers("u_a"), json=approval(intent).model_dump(mode="json"))
                assert received.status_code == 200 and received.json()["allocation_status"] == "applied", received.text
                missing = await client.get("/api/trips/t/settlement-intents")
                assert missing.status_code == 401
                other = await database.trips.find_one({"id": "t"}, {"_id": 0})
                other["id"] = "other"
                await database.trips.insert_one(other)
                cross_trip = await client.post(f"/api/trips/other/settlement-intents/{intent['id']}/approvals", headers=headers("u_a"), json=approval(intent).model_dump(mode="json"))
                assert cross_trip.status_code == 404
    asyncio.run(exercise())


async def fake_upi_quote(monkeypatch, database):
    from services import exchange_rates
    from utils.common import now_utc
    from datetime import timedelta
    await database.users.update_one({"id": "u_a"}, {"$set": {"upi_id": "receiver@upi", "upi_updated_at": "v1"}})
    async def fx(**kwargs):
        return {"quote_id": str(uuid4()), "rate": "1", "provider": "identity", "stale": False,
                "target_amount": kwargs["source_amount"], "expires_at": (now_utc() + timedelta(minutes=30)).isoformat()}
    monkeypatch.setattr(exchange_rates, "create_quote", fx)


def leg_command(intent, action, **extra):
    return IntentAction(client_mutation_id=uuid4(), action=action, plan_hash=intent["plan"]["plan_hash"],
                       expected_intent_version=intent["version"], **extra)


def test_upi_expiry_late_report_and_no_duplicate_coverage(monkeypatch):
    async def exercise():
        from services import payment_attempts
        from utils.common import now_utc
        from datetime import timedelta
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            monkeypatch.setattr(payment_attempts, "db", database)
            await fake_upi_quote(monkeypatch, database)
            _, request = await reviewed(database, method="upi")
            intent = await workflow.create("t", request, {"id": "u_b"})
            leg_id = intent["cash_legs"][0]["id"]
            past = now_utc() - timedelta(days=2)
            await database.settlement_intents.update_one({"id": intent["id"]}, {"$set": {"expires_at": past.isoformat()}})
            await payment_attempts.expire_settlement_intents()
            expired = await workflow.detail("t", intent["id"], {"id": "u_b"})
            assert expired["status"] == "expired"
            assert await database.settlement_intent_actions.count_documents({"intent_id": intent["id"], "event": "expired"}) == 1
            _, replacement_request = await reviewed(database)
            replacement = await workflow.create("t", replacement_request, {"id": "u_b"})
            reported = await workflow.leg_action("t", intent["id"], leg_id,
                leg_command(expired, "report_paid", transaction_reference="late-sent-reference"), {"id": "u_b"})
            assert reported["status"] == "needs_review" and "late_payment_report" in reported["review_reasons"]
            assert replacement["id"] in reported["overlapping_intent_ids"]
            await payment_attempts.expire_settlement_intents(timestamp=now_utc() + timedelta(days=20))
            assert (await database.settlement_intents.find_one({"id": intent["id"]}))["status"] == "needs_review"
            first = await workflow.approve("t", replacement["id"], approval(replacement), {"id": "u_a"})
            late = await workflow.approve("t", reported["id"], approval(reported), {"id": "u_a"})
            assert first["allocation_status"] == "needs_review" and late["allocation_status"] == "needs_review"
            assert await database.payments.count_documents({}) == 2
            assert await database.expense_coverage_events.count_documents({}) == 0
            # Both external receipts exist; neither can masquerade as a second allocation.
            cash_rows = await database.payments.find({}).to_list(None)
            assert sum(row["amount"] for row in cash_rows) == 200
    asyncio.run(exercise())


def test_upi_recipient_changes_and_sender_authority(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            await fake_upi_quote(monkeypatch, database)
            _, request = await reviewed(database, method="upi")
            intent = await workflow.create("t", request, {"id": "u_b"})
            leg_id = intent["cash_legs"][0]["id"]
            with pytest.raises(HTTPException) as wrong:
                await workflow.leg_action("t", intent["id"], leg_id, leg_command(intent, "start"), {"id": "admin"})
            assert wrong.value.status_code == 403
            await database.users.update_one({"id": "u_a"}, {"$set": {"upi_id": "changed@upi", "upi_updated_at": "v2"}})
            with pytest.raises(HTTPException) as stale:
                await workflow.leg_action("t", intent["id"], leg_id, leg_command(intent, "start"), {"id": "u_b"})
            assert stale.value.detail["code"] == "recipient_changed"
            reported = await workflow.leg_action("t", intent["id"], leg_id, leg_command(intent, "report_paid"), {"id": "u_b"})
            assert reported["allocation_status"] == "needs_review"
            received = await workflow.approve("t", intent["id"], approval(reported), {"id": "u_a"})
            assert received["allocation_status"] == "needs_review"
            assert (await database.payment_attempts.find_one({}))["upi_id_snapshot"] == "receiver@upi"
            assert (await database.payments.find_one({}))["amount"] == 100
    asyncio.run(exercise())


def test_report_expiry_cancel_race_retains_sent_claim(monkeypatch):
    async def exercise():
        from services import payment_attempts
        from utils.common import now_utc
        from datetime import timedelta
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            monkeypatch.setattr(payment_attempts, "db", database)
            await fake_upi_quote(monkeypatch, database)
            _, request = await reviewed(database, method="upi")
            intent = await workflow.create("t", request, {"id": "u_b"})
            leg_id = intent["cash_legs"][0]["id"]
            report = leg_command(intent, "report_paid", transaction_reference="sent-before-timeout")
            await asyncio.gather(workflow.leg_action("t", intent["id"], leg_id, report, {"id": "u_b"}),
                payment_attempts.expire_settlement_intents(timestamp=now_utc() + timedelta(days=2)), return_exceptions=True)
            fresh = await workflow.detail("t", intent["id"], {"id": "u_b"})
            if fresh["status"] == "expired":
                fresh = await workflow.leg_action("t", intent["id"], leg_id,
                    leg_command(fresh, "report_paid", transaction_reference="sent-before-timeout"), {"id": "u_b"})
            assert fresh["status"] in {"awaiting_confirmation", "needs_review"}
            with pytest.raises(HTTPException):
                await workflow.leg_action("t", intent["id"], leg_id, leg_command(fresh, "cancel"), {"id": "u_b"})
            assert (await database.payment_attempts.find_one({}))["transaction_reference"] == "sent-before-timeout"
    asyncio.run(exercise())


def test_rejected_report_requires_explicit_resolution_and_history_is_retained(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            disputed = await workflow.approve("t", intent["id"], approval(intent, "reject", reason="No money arrived"), {"id": "u_a"})
            assert disputed["status"] == "needs_review"
            with pytest.raises(HTTPException):
                await reviewed(database)
            resolved = await workflow.approve("t", intent["id"], approval(disputed, "resolve_not_sent", reason="Payer and receiver resolved the mistaken report"), {"id": "u_a"})
            assert resolved["status"] == "rejected"
            await reviewed(database)
            assert await database.settlement_intent_actions.count_documents({}) == 3
            assert (await database.payment_attempts.find_one({}))["transaction_reference"] == "private-evidence-123"
    asyncio.run(exercise())


@pytest.mark.parametrize("stage", ["status", "outbox", "cash", "audit", "receipt"])
def test_failure_at_financial_status_and_outbox_boundaries_rolls_back(monkeypatch, stage):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            command = approval(intent)
            version = (await database.trips.find_one({"id": "t"}))["version"]
            async def fail(*args, **kwargs):
                raise RuntimeError("injected transaction boundary failure")
            if stage == "outbox":
                monkeypatch.setattr(workflow, "enqueue_notification_event", fail)
            elif stage == "status":
                original = workflow.save_intent
                async def after_save(*args, **kwargs):
                    await original(*args, **kwargs)
                    await fail()
                monkeypatch.setattr(workflow, "save_intent", after_save)
            elif stage == "cash":
                monkeypatch.setattr(workflow, "try_apply", fail)
            else:
                collection = database.settlement_intent_actions if stage == "audit" else database.payment_mutation_receipts
                monkeypatch.setattr(database, "settlement_intent_actions" if stage == "audit" else "payment_mutation_receipts", collection)
                original = collection.insert_one
                async def after_insert(*args, **kwargs):
                    await original(*args, **kwargs)
                    await fail()
                monkeypatch.setattr(collection, "insert_one", after_insert)
            with pytest.raises(RuntimeError):
                await workflow.approve("t", intent["id"], command, {"id": "u_a"})
            assert await database.payments.count_documents({}) == 0
            assert await database.expense_coverage_events.count_documents({}) == 0
            assert await database.payment_mutation_receipts.count_documents({}) == 1
            assert (await database.trips.find_one({"id": "t"}))["version"] == version
            assert (await database.payment_attempts.find_one({}))["status"] == "awaiting_confirmation"
    asyncio.run(exercise())


def test_only_sender_cancel_asserts_unsent_for_expired_or_admin_withdrawn_upi(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            await fake_upi_quote(monkeypatch, database)
            _, request = await reviewed(database, method="upi")
            intent = await workflow.create("t", request, {"id": "u_b"})
            withdrawn = await workflow.approve("t", intent["id"], approval(intent, "cancel"), {"id": "admin"})
            assert not withdrawn.get("unsent_resolved")
            resolved = await workflow.leg_action("t", intent["id"], intent["cash_legs"][0]["id"],
                leg_command(withdrawn, "cancel"), {"id": "u_b"})
            assert resolved["unsent_resolved"] is True
            assert await database.payments.count_documents({}) == 0
            assert await database.expense_coverage_events.count_documents({}) == 0
    asyncio.run(exercise())


def test_offset_decline_is_person_scoped_durable_and_never_expires(monkeypatch):
    async def exercise():
        from services import payment_attempts
        from utils.common import now_utc
        from datetime import timedelta
        async with isolated(monkeypatch, reverse=True) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            monkeypatch.setattr(payment_attempts, "db", database)
            current = await snapshot(database)
            quote = await workflow.quote("t", SettlementQuoteRequest(mode="offset", method="offset",
                expected_snapshot_id=current.snapshot_id,
                shares=[{"share_id": share(current)["id"], "amount": "80"}], parties=[]), {"id": "u_b"})
            intent = await workflow.create("t", SettlementIntentCreate(quote_id=quote["id"],
                quote_hash=quote["quote_hash"], client_mutation_id=uuid4(), submission_action="propose"), {"id": "u_b"})
            assert intent["expires_at"] is None
            # Even a pre-upgrade offset with an old unreported-payment deadline survives.
            await database.settlement_intents.update_one({"id": intent["id"]},
                {"$set": {"expires_at": (now_utc() - timedelta(days=2)).isoformat()}})
            await payment_attempts.expire_settlement_intents()
            assert (await database.settlement_intents.find_one({"id": intent["id"]}))["status"] == "initiated"
            assert all(not row["reservations"] for row in (await snapshot(database)).shares.values())
            with pytest.raises(HTTPException):
                await workflow.approve("t", intent["id"], approval(intent, "decline_allocation",
                    person_id="b", reason="Not agreed"), {"id": "u_a"})
            with pytest.raises(HTTPException):
                await workflow.approve("t", intent["id"], approval(intent, "decline_allocation", person_id="b"), {"id": "u_b"})
            command = approval(intent, "decline_allocation", person_id="b", reason="Keep separate debts")
            declined = await workflow.approve("t", intent["id"], command, {"id": "u_b"})
            assert await workflow.approve("t", intent["id"], command, {"id": "u_b"}) == declined
            assert declined["allocation_status"] == "needs_review"
            assert declined["approvals"][-1]["actor_role"] == "member"
            with pytest.raises(HTTPException) as reconsidered:
                await workflow.approve("t", intent["id"], approval(declined, "admin_override", reason="Admin review"), {"id": "admin"})
            assert reconsidered.value.detail["code"] == "offset_declined_new_review_required"
            assert await database.payments.count_documents({}) == 0
            assert await database.expense_coverage_events.count_documents({}) == 0
            detail = await workflow.detail("t", intent["id"], {"id": "u_b"})
            assert detail["can_withdraw"] is True
            withdrawn = await workflow.approve("t", intent["id"], approval(declined, "cancel"), {"id": "u_b"})
            assert withdrawn["status"] == "canceled"
            assert await database.notification_outbox.count_documents({"event_type": "settlement.allocation_declined"}) == 1
    asyncio.run(exercise())


def test_review_context_preserves_original_expense_and_participant_labels(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            await database.expenses.update_one({"id": "dinner"}, {"$set": {
                "description": "Original dinner", "category": "Food", "date": "01-10-26"}})
            _, request = await reviewed(database, "40")
            intent = await workflow.create("t", request, {"id": "u_b"})
            await database.expenses.update_one({"id": "dinner"}, {"$set": {"description": "Corrected dinner"}})
            detail = await workflow.detail("t", intent["id"], {"id": "u_a"})
            assert detail["review_context"][0] == {
                "share_id": intent["plan"]["allocation_lines"][0]["share_id"],
                "revision_id": intent["plan"]["allocation_lines"][0]["revision_id"],
                "expense_id": "dinner", "expense_description": "Original dinner", "category": "Food", "date": "01-10-26",
                "person_id": "b", "person_name": "B", "original_share": "100", "amount": "40", "kind": "direct"}
            # Older work still identifies people from retained revisions when the bill is gone.
            await database.settlement_intents.update_one({"id": intent["id"]}, {"$unset": {"review_context": ""}})
            await database.expenses.delete_one({"id": "dinner"})
            old = await workflow.detail("t", intent["id"], {"id": "u_a"})
            assert old["review_context"][0]["person_name"] == "B"
            assert old["review_context"][0]["expense_description"] is None
    asyncio.run(exercise())


def test_group_start_revalidates_pair_but_sent_claim_keeps_exact_money(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch, reverse=True) as (database, data, _client):
            await setup_workflow(monkeypatch, database)
            await fake_upi_quote(monkeypatch, database)
            _, request = await reviewed(database, "20", "group", "upi")
            intent = await workflow.create("t", request, {"id": "u_b"})
            changed = expense("new-reverse", 20, "b", ("a",))
            await database.expenses.insert_one(deepcopy(changed))
            await database.expense_share_revisions.insert_one(make_share_revision(changed, data.trip["members"], "t", recorded_at=changed["created_at"]))
            await database.trips.update_one({"id": "t"}, {"$inc": {"version": 1}})
            leg = intent["cash_legs"][0]["id"]
            with pytest.raises(HTTPException) as stale:
                await workflow.leg_action("t", intent["id"], leg, leg_command(intent, "start"), {"id": "u_b"})
            assert stale.value.detail["code"] == "recommendation_changed"
            reported = await workflow.leg_action("t", intent["id"], leg, leg_command(intent, "report_paid"), {"id": "u_b"})
            received = await workflow.approve("t", intent["id"], approval(reported), {"id": "u_a"})
            assert received["allocation_status"] == "awaiting_consent"
            assert (await database.payments.find_one({}))["amount"] == 20
    asyncio.run(exercise())


def test_dependent_group_legs_wait_for_every_receipt_and_person_consent(monkeypatch):
    async def exercise():
        from services.settlement_engine import build_settlement_projection
        from services import exchange_rates, payment_attempts
        from utils.common import now_utc
        from datetime import timedelta
        async with isolated(monkeypatch) as (database, data, _client):
            await setup_workflow(monkeypatch, database)
            monkeypatch.setattr(payment_attempts, "db", database)
            # Stable recommendation matching crosses the original obligation directions.
            bills = [expense("ad", 100, "d", ("a",)), expense("bc", 100, "c", ("b",))]
            await database.expenses.delete_many({})
            await database.expense_share_revisions.delete_many({})
            await database.expenses.insert_many(deepcopy(bills))
            await database.expense_share_revisions.insert_many([make_share_revision(row, data.trip["members"], "t", recorded_at=row["created_at"]) for row in bills])
            current = await snapshot(database)
            recommended, _ = build_settlement_projection(current.precise_net, "INR", whole_unit_enabled=True)
            assert {(row["from_member_id"], row["to_member_id"]) for row in recommended} == {("a", "c"), ("b", "d")}
            await database.users.update_many({"id": {"$in": ["u_c", "u_d"]}}, {"$set": {"upi_id": "receiver@upi"}})
            async def fx(**kwargs):
                return {"quote_id": str(uuid4()), "target_amount": kwargs["source_amount"], "rate": "1",
                    "expires_at": (now_utc() + timedelta(minutes=30)).isoformat()}
            monkeypatch.setattr(exchange_rates, "create_quote", fx)
            quoted = await workflow.quote("t", SettlementQuoteRequest(mode="group", method="upi", expected_snapshot_id=current.snapshot_id,
                cash_legs=[{"from_member_id": "a", "to_member_id": "c", "amount": "50"}],
                parties=[{"from_member_id": f, "to_member_id": t, "payer_person_id": f, "recipient_person_id": t} for f, t in [("a", "c"), ("b", "d")]]), {"id": "u_a"})
            intent = await workflow.create("t", SettlementIntentCreate(quote_id=quoted["id"], quote_hash=quoted["quote_hash"], client_mutation_id=uuid4()), {"id": "u_a"})
            assert len(intent["cash_legs"]) == 2
            assert sum(leg["dependency"] for leg in intent["cash_legs"]) == 1
            for leg_index, payer in [(0, "u_a"), (1, "u_b")]:
                leg = intent["cash_legs"][leg_index]
                assert f"u_{leg['from_member_id']}" == payer
                intent = await workflow.leg_action("t", intent["id"], leg["id"], leg_command(intent, "start"), {"id": payer})
                intent = await workflow.leg_action("t", intent["id"], leg["id"], leg_command(intent, "report_paid"), {"id": payer})
                command = approval(intent).model_copy(update={"leg_id": leg["id"]})
                intent = await workflow.approve("t", intent["id"], command, {"id": f"u_{leg['to_member_id']}"})
                assert await database.expense_coverage_events.count_documents({}) == 0
                assert await database.payments.count_documents({}) == leg_index + 1
                await payment_attempts.expire_settlement_intents(timestamp=now_utc() + timedelta(days=2))
                assert (await database.settlement_intents.find_one({"id": intent["id"]}))["status"] != "expired"
            for pid in intent["plan"]["required_person_ids"]:
                intent = await workflow.approve("t", intent["id"], approval(intent, "consent", person_id=pid), {"id": f"u_{pid}"})
            assert intent["allocation_status"] == "applied"
            assert await database.payments.count_documents({}) == 2
            assert await database.expense_coverage_events.count_documents({}) == 1
            final = await snapshot(database)
            assert sorted(final.remaining(row["id"]) for row in final.shares.values()) == [50 * SCALE, 50 * SCALE]
    asyncio.run(exercise())


def test_pure_offset_is_unreserved_until_all_people_consent(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, data, _client):
            await setup_workflow(monkeypatch, database)
            opposite = expense("reverse", 100, "b", ("a",))
            await database.expenses.insert_one(deepcopy(opposite))
            await database.expense_share_revisions.insert_one(make_share_revision(opposite, data.trip["members"], "t", recorded_at=opposite["created_at"]))
            current = await snapshot(database)
            quoted = await workflow.quote("t", SettlementQuoteRequest(mode="offset", method="offset", expected_snapshot_id=current.snapshot_id,
                shares=[{"share_id": share(current)["id"], "amount": "100"}]), {"id": "u_b"})
            intent = await workflow.create("t", SettlementIntentCreate(quote_id=quoted["id"], quote_hash=quoted["quote_hash"], client_mutation_id=uuid4()), {"id": "u_b"})
            assert (await snapshot(database)).available(share(current)["id"]) == 100 * SCALE
            canceled = await workflow.approve("t", intent["id"], approval(intent, "cancel"), {"id": "u_b"})
            assert canceled["status"] == "canceled"
            current = await snapshot(database)
            quoted = await workflow.quote("t", SettlementQuoteRequest(mode="offset", method="offset", expected_snapshot_id=current.snapshot_id,
                shares=[{"share_id": share(current)["id"], "amount": "100"}]), {"id": "u_b"})
            intent = await workflow.create("t", SettlementIntentCreate(quote_id=quoted["id"], quote_hash=quoted["quote_hash"], client_mutation_id=uuid4()), {"id": "u_b"})
            for pid in intent["plan"]["required_person_ids"]:
                intent = await workflow.approve("t", intent["id"], approval(intent, "consent", person_id=pid), {"id": f"u_{pid}"})
            assert intent["allocation_status"] == "applied"
            assert await database.payments.count_documents({}) == 0
            final = await snapshot(database)
            assert all(final.remaining(sid) == 0 for sid in current.shares)
    asyncio.run(exercise())


def test_expired_legacy_sent_report_recovery_keeps_conflicting_newer_attempt(monkeypatch):
    async def exercise():
        from services import payment_attempts
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            monkeypatch.setattr(payment_attempts, "db", database)
            await database.payment_attempts.insert_many([
                {"id": "old", "trip_id": "t", "from_member_id": "b", "to_member_id": "a", "status": "expired",
                 "sender_reported_by": "u_b", "transaction_reference": "sent-old", "source_amount": "100"},
                {"id": "new", "trip_id": "t", "from_member_id": "b", "to_member_id": "a", "status": "initiated",
                 "active_key": "t:b:a", "source_amount": "100"}])
            await payment_attempts.recover_expired_sent_reports()
            old = await database.payment_attempts.find_one({"id": "old"})
            assert old["status"] == "needs_review" and old["expires_at"] is None and "active_key" not in old
            assert old["transaction_reference"] == "sent-old"
            assert (await database.payment_attempts.find_one({"id": "new"}))["active_key"] == "t:b:a"
            with pytest.raises(HTTPException) as blocked:
                await reviewed(database)
            assert blocked.value.detail["code"] == "reconciliation_required"
    asyncio.run(exercise())


def test_revoked_admin_during_approval_aborts_financial_post(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            # Keep the owner separate from the administrator being revoked.
            await database.trips.update_one({"id": "t"}, {"$set": {"owner_id": "u_d", "admin_ids": ["u_d", "admin"]}})
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            reached, release = asyncio.Event(), asyncio.Event()
            original = workflow.allocation_issue
            first = True
            async def hold(*args, **kwargs):
                nonlocal first
                result = await original(*args, **kwargs)
                if first:
                    first = False
                    reached.set()
                    await release.wait()
                return result
            monkeypatch.setattr(workflow, "allocation_issue", hold)
            pending = asyncio.create_task(workflow.approve("t", intent["id"], approval(intent), {"id": "admin"}))
            await asyncio.wait_for(reached.wait(), timeout=5)
            await database.trips.update_one({"id": "t"}, {"$pull": {"admin_ids": "admin"}, "$inc": {"version": 1}})
            release.set()
            with pytest.raises(HTTPException) as revoked:
                await pending
            assert revoked.value.status_code == 403
            assert await database.payments.count_documents({}) == 0
            assert (await database.payment_attempts.find_one({}))["transaction_reference"] == "private-evidence-123"
    asyncio.run(exercise())


@pytest.mark.parametrize("amount", [80, 100])
def test_gross_payment_when_net_smaller_or_zero(monkeypatch, amount):
    async def exercise():
        async with isolated(monkeypatch) as (database, data, _client):
            await setup_workflow(monkeypatch, database)
            opposite = expense("reverse", amount, "b", ("a",))
            await database.expenses.insert_one(deepcopy(opposite))
            await database.expense_share_revisions.insert_one(make_share_revision(opposite, data.trip["members"], "t", recorded_at=opposite["created_at"]))
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            result = await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a"})
            assert result["allocation_status"] == "applied"
            final = await snapshot(database)
            assert final.remaining(share(final)["id"]) == 0
            assert final.remaining(share(final, "reverse", "a")["id"]) == amount * SCALE
    asyncio.run(exercise())


def test_linked_family_can_cover_sibling_share_and_receiver_family_can_review(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, data, _client):
            await setup_workflow(monkeypatch, database)
            group = deepcopy(data.trip)
            group["members"][:2] = [
                {"id": "a", "name": "Receiver family", "kind": "family", "family_members": ["A1", "A2"],
                 "family_member_ids": ["a1", "a2"], "family_member_user_ids": ["u_a", "u_a2"]},
                {"id": "b", "name": "Payer family", "kind": "family", "family_members": ["B1", "B2"],
                 "family_member_ids": ["b1", "b2"], "family_member_user_ids": ["u_b", "u_b2"]}]
            group["user_ids"] += ["u_a2", "u_b2"]
            await database.trips.replace_one({"id": "t"}, group)
            await database.users.insert_many([{"id": "u_a2"}, {"id": "u_b2"}])
            await database.expense_share_revisions.delete_many({})
            await database.expense_share_revisions.insert_one(make_share_revision(data.expenses[0], group["members"], "t", recorded_at=data.expenses[0]["created_at"]))
            current = await snapshot(database)
            quote = await workflow.quote("t", SettlementQuoteRequest(mode="direct", method="bank", expected_snapshot_id=current.snapshot_id,
                shares=[{"share_id": share(current, person="b2")["id"], "amount": "40"}],
                parties=[{"from_member_id": "b", "to_member_id": "a", "payer_person_id": "b1", "recipient_person_id": "a1"}]), {"id": "u_b"})
            intent = await workflow.create("t", SettlementIntentCreate(quote_id=quote["id"], quote_hash=quote["quote_hash"], client_mutation_id=uuid4()), {"id": "u_b"})
            with pytest.raises(HTTPException) as wrong:
                await workflow.approve("t", intent["id"], approval(intent), {"id": "u_b2"})
            assert wrong.value.status_code == 403
            received = await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a2"})
            assert received["allocation_status"] == "applied"
            payment = await database.payments.find_one({})
            assert payment["actual_payer_person_id"] == "b1" and payment["actual_receiver_person_id"] == "a1"
            final = await snapshot(database)
            assert final.remaining(share(final, person="b2")["id"]) == 10 * SCALE
            assert final.remaining(share(final, person="b1")["id"]) == 50 * SCALE
            notice = await database.notification_outbox.find_one({"event_type": "settlement.allocation_applied"})
            assert set(notice["recipient_user_ids"]) == {"u_b", "u_b2", "u_a"}
    asyncio.run(exercise())


def test_refund_obligation_and_unlinked_receiver_admin_receipt(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, data, _client):
            await setup_workflow(monkeypatch, database)
            bill = expense(amount=-50)
            await database.expenses.replace_one({"id": "dinner"}, bill)
            await database.expense_share_revisions.delete_many({})
            await database.expense_share_revisions.insert_one(make_share_revision(bill, data.trip["members"], "t", recorded_at=bill["created_at"]))
            await database.trips.update_one({"id": "t", "members.id": "b"}, {"$set": {"members.$.user_id": None}})
            current = await snapshot(database)
            quote = await workflow.quote("t", SettlementQuoteRequest(mode="direct", method="cash", expected_snapshot_id=current.snapshot_id,
                shares=[{"share_id": share(current)["id"], "amount": "50"}],
                parties=[{"from_member_id": "a", "to_member_id": "b", "payer_person_id": "a", "recipient_person_id": "b"}]), {"id": "u_a"})
            intent = await workflow.create("t", SettlementIntentCreate(quote_id=quote["id"], quote_hash=quote["quote_hash"], client_mutation_id=uuid4()), {"id": "u_a"})
            with pytest.raises(HTTPException):
                await workflow.approve("t", intent["id"], approval(intent), {"id": "u_b"})
            result = await workflow.approve("t", intent["id"], approval(intent), {"id": "admin"})
            assert result["allocation_status"] == "applied"
            cash = await database.payments.find_one({})
            assert cash["amount"] == 50 and cash["from_member_id"] == "a" and cash["to_member_id"] == "b"
    asyncio.run(exercise())


def test_admin_override_is_reasoned_and_consent_is_person_specific(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch, reverse=True) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            _, request = await reviewed(database, "20", "group")
            intent = await workflow.create("t", request, {"id": "u_b"})
            received = await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a"})
            with pytest.raises(HTTPException):
                await workflow.approve("t", intent["id"], approval(received, "consent", person_id="b"), {"id": "u_a"})
            with pytest.raises(HTTPException):
                await workflow.approve("t", intent["id"], approval(received, "admin_override"), {"id": "admin"})
            applied = await workflow.approve("t", intent["id"], approval(received, "admin_override", reason="Reviewed with unavailable participants"), {"id": "admin"})
            assert applied["allocation_status"] == "applied"
            assert await database.payments.count_documents({}) == 1
    asyncio.run(exercise())


def test_standalone_mongo_rejects_mutations_without_partial_writes(monkeypatch):
    import os
    from urllib.parse import urlparse
    from motor.motor_asyncio import AsyncIOMotorClient
    from services import ledger_transactions
    async def exercise():
        url = os.environ.get("SETTLEMENT_TEST_STANDALONE_URL")
        if not url:
            pytest.skip("Set SETTLEMENT_TEST_STANDALONE_URL to a disposable loopback standalone MongoDB")
        assert urlparse(url).hostname in {"localhost", "127.0.0.1"}
        client = AsyncIOMotorClient(url, serverSelectionTimeoutMS=1500)
        database = client[f"trip_splitter_standalone_test_{uuid4().hex}"]
        try:
            assert not (await client.admin.command("hello")).get("setName")
            await setup_workflow(monkeypatch, database)
            monkeypatch.setattr(ledger_transactions, "client", client)
            with pytest.raises(HTTPException) as unavailable:
                await workflow.create("t", SettlementIntentCreate(quote_id=uuid4(), quote_hash="unused", client_mutation_id=uuid4()), {"id": "u_b"})
            assert unavailable.value.status_code == 503
            for collection in ("payments", "settlement_intents", "expense_coverage_events", "payment_mutation_receipts", "settlement_intent_actions"):
                assert await database[collection].count_documents({}) == 0
        finally:
            await client.drop_database(database.name)
            client.close()
    asyncio.run(exercise())


def test_two_family_accounts_compete_for_the_same_selected_share(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, data, _client):
            await setup_workflow(monkeypatch, database)
            group = deepcopy(data.trip)
            group["members"][1] = {"id": "b", "name": "Family", "kind": "family", "family_members": ["B1", "B2"],
                "family_member_ids": ["b1", "b2"], "family_member_user_ids": ["u_b", "u_b2"]}
            group["user_ids"].append("u_b2")
            await database.trips.replace_one({"id": "t"}, group)
            await database.users.insert_one({"id": "u_b2"})
            await database.expense_share_revisions.delete_many({})
            await database.expense_share_revisions.insert_one(make_share_revision(data.expenses[0], group["members"], "t", recorded_at=data.expenses[0]["created_at"]))
            current = await snapshot(database)
            requests = []
            for person_id, actor in [("b1", "u_b"), ("b2", "u_b2")]:
                quoted = await workflow.quote("t", SettlementQuoteRequest(mode="direct", method="bank", expected_snapshot_id=current.snapshot_id,
                    shares=[{"share_id": share(current, person="b2")["id"], "amount": "40"}],
                    parties=[{"from_member_id": "b", "to_member_id": "a", "payer_person_id": person_id, "recipient_person_id": "a"}]), {"id": actor})
                requests.append((SettlementIntentCreate(quote_id=quoted["id"], quote_hash=quoted["quote_hash"], client_mutation_id=uuid4()), actor))
            results = await asyncio.gather(*(workflow.create("t", request, {"id": actor}) for request, actor in requests), return_exceptions=True)
            assert sum(isinstance(result, dict) for result in results) == 1
            assert sum(isinstance(result, HTTPException) for result in results) == 1
            assert await database.settlement_intents.count_documents({}) == 1
            assert await database.payment_attempts.count_documents({}) == 1
            assert (await snapshot(database)).available(share(current, person="b2")["id"]) == 10 * SCALE
    asyncio.run(exercise())


@pytest.mark.parametrize("reviewer", ["owner", "trip_admin", "super_admin", "outsider"])
def test_current_reviewer_roles_and_outsider_access(monkeypatch, reviewer):
    async def exercise():
        from config import SUPER_ADMIN_EMAIL
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            await database.trips.update_one({"id": "t"}, {"$set": {"owner_id": "u_d", "admin_ids": ["u_d", "u_c"]}})
            await database.users.insert_many([{"id": "operator", "role": "super_admin", "email": SUPER_ADMIN_EMAIL}, {"id": "outsider"}])
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            actor = {"owner": "u_d", "trip_admin": "u_c", "super_admin": "operator", "outsider": "outsider"}[reviewer]
            if reviewer == "outsider":
                with pytest.raises(HTTPException) as denied:
                    await workflow.approve("t", intent["id"], approval(intent), {"id": actor})
                assert denied.value.status_code == 403
                assert await database.payments.count_documents({}) == 0
            else:
                result = await workflow.approve("t", intent["id"], approval(intent), {"id": actor})
                assert result["allocation_status"] == "applied"
                assert await database.payments.count_documents({}) == 1
    asyncio.run(exercise())


def test_upi_sibling_and_revoked_sender_link_require_current_authority(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, data, _client):
            await setup_workflow(monkeypatch, database)
            group = deepcopy(data.trip)
            group["members"][1] = {"id": "b", "name": "Family", "kind": "family", "family_members": ["B1", "B2"],
                "family_member_ids": ["b1", "b2"], "family_member_user_ids": ["u_b", "u_b2"]}
            group["user_ids"].append("u_b2")
            await database.trips.replace_one({"id": "t"}, group)
            await database.users.insert_one({"id": "u_b2"})
            await database.expense_share_revisions.delete_many({})
            await database.expense_share_revisions.insert_one(make_share_revision(data.expenses[0], group["members"], "t", recorded_at=data.expenses[0]["created_at"]))
            await fake_upi_quote(monkeypatch, database)
            current = await snapshot(database)
            quoted = await workflow.quote("t", SettlementQuoteRequest(mode="direct", method="upi", expected_snapshot_id=current.snapshot_id,
                shares=[{"share_id": share(current, person="b2")["id"], "amount": "50"}],
                parties=[{"from_member_id": "b", "to_member_id": "a", "payer_person_id": "b1", "recipient_person_id": "a"}]), {"id": "u_b"})
            request = SettlementIntentCreate(quote_id=quoted["id"], quote_hash=quoted["quote_hash"], client_mutation_id=uuid4())
            intent = await workflow.create("t", request, {"id": "u_b"})
            leg = intent["cash_legs"][0]["id"]
            for action in ("start", "report_paid"):
                with pytest.raises(HTTPException) as wrong:
                    await workflow.leg_action("t", intent["id"], leg, leg_command(intent, action), {"id": "u_b2"})
                assert wrong.value.status_code == 403
            await database.trips.update_one({"id": "t", "members.id": "b"}, {"$set": {"members.$.family_member_user_ids.0": None}, "$inc": {"version": 1}})
            with pytest.raises(HTTPException) as revoked:
                await workflow.leg_action("t", intent["id"], leg, leg_command(intent, "report_paid"), {"id": "u_b"})
            assert revoked.value.status_code == 403
            reported = await workflow.leg_action("t", intent["id"], leg, leg_command(intent, "report_paid", note="Former payer reports sending money"), {"id": "admin"})
            assert reported["allocation_status"] == "needs_review"
            stored = await database.payment_attempts.find_one({})
            assert stored["reported_by"] == "admin" and stored["initiating_payer_user_id"] == "u_b"
    asyncio.run(exercise())


def test_activated_legacy_routes_fail_before_financial_or_membership_writes(monkeypatch):
    async def exercise():
        import database as database_module
        from routes import balances, expenses, payments, members, trips
        from services import join_requests, reallocation, whole_unit_migration
        from utils import deps
        from models.expense import ExpenseUpdate
        from models.payment import PaymentCreate, PaymentPatch
        from models.settlement import SettleIn, SettlementCreate
        from models.member import MemberIn
        from models.join import JoinRequest
        from fastapi import BackgroundTasks
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            for module in (database_module, balances, expenses, payments, members, trips, join_requests, whole_unit_migration, deps):
                monkeypatch.setattr(module, "db", database)
            await database.payments.insert_one({"id": "receipt", "trip_id": "t", "from_member_id": "b", "to_member_id": "a", "amount": 10,
                "settlement_intent_id": "historical-contract"})
            await database.join_requests.insert_one({"id": "join", "trip_id": "t", "status": "pending", "requester_user_id": "unlinked"})
            async def credential(*_args):
                return await database.trips.find_one({"id": "t"}, {"_id": 0}), None
            monkeypatch.setattr(trips, "resolve_join_credential", credential)
            actor = {"id": "admin"}
            pair = {"from_member_id": "b", "to_member_id": "a", "amount": 10}
            callbacks = [
                lambda: payments.record_payment("t", PaymentCreate(**pair), BackgroundTasks(), actor),
                lambda: balances.settle("t", SettleIn(**pair), BackgroundTasks(), actor),
                lambda: balances.create_settlement("t", SettlementCreate(**pair), actor),
                lambda: payments.edit_payment("t", "receipt", PaymentPatch(amount=11), actor),
                lambda: payments.delete_payment("t", "receipt", actor),
                lambda: expenses.update_expense("t", "dinner", ExpenseUpdate(amount=200), actor),
                lambda: expenses.delete_expense("t", "dinner", actor),
                lambda: members.add_member("t", MemberIn(name="Another"), actor),
                lambda: trips.join_trip(JoinRequest(code="fixture", action="claim", member_id="c"), {"id": "unlinked", "email": "person@gmail.com"}),
                lambda: join_requests.approve_request("join", "admin"),
                lambda: reallocation.apply_reallocation("t", {}),
                lambda: whole_unit_migration.apply_trip_migration("t"),
            ]
            for callback in callbacks:
                with pytest.raises(HTTPException) as guarded:
                    await callback()
                assert guarded.value.status_code in {409, 428}
            assert await database.payments.count_documents({}) == 1
            assert await database.expenses.count_documents({}) == 1
            assert (await database.join_requests.find_one({"id": "join"}))["status"] == "pending"
            assert (await database.trips.find_one({"id": "t"}))["version"] == 0
    asyncio.run(exercise())


def test_activated_expense_creation_freezes_revision_with_retry_receipt(monkeypatch):
    async def exercise():
        from routes import expenses
        from services import expense_idempotency
        from utils import deps
        from models.expense import ExpenseIn
        from fastapi import BackgroundTasks
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            for module in (expenses, expense_idempotency, deps):
                monkeypatch.setattr(module, "db", database)
            monkeypatch.setattr(expense_idempotency, "_transaction_verified", True)
            await database.expense_mutation_receipts.create_index([("actor_user_id", 1), ("operation", 1), ("client_mutation_id", 1)], unique=True)
            args = {"amount": 60, "currency": "INR", "category": expenses.CATEGORIES[0], "date": "06-10-26",
                "paid_by_member_id": "a", "split_member_ids": ["b"]}
            with pytest.raises(HTTPException) as legacy:
                await expenses.add_expense("t", ExpenseIn(**args), BackgroundTasks(), user={"id": "u_a"})
            assert legacy.value.status_code == 428
            body = ExpenseIn(**args, client_mutation_id=uuid4(), expected_roster={"currency": "INR", "members": [
                {"id": "a", "kind": "individual"}, {"id": "b", "kind": "individual"}]})
            original = expenses.store_new_share_revision
            async def after_revision(*args, **kwargs):
                await original(*args, **kwargs)
                raise RuntimeError("Injected after new revision")
            monkeypatch.setattr(expenses, "store_new_share_revision", after_revision)
            with pytest.raises(RuntimeError):
                await expenses.add_expense("t", body, BackgroundTasks(), user={"id": "u_a"})
            assert await database.expenses.count_documents({}) == 1
            assert await database.expense_share_revisions.count_documents({}) == 1
            assert await database.expense_mutation_receipts.count_documents({}) == 0
            monkeypatch.setattr(expenses, "store_new_share_revision", original)
            first = await expenses.add_expense("t", body, BackgroundTasks(), user={"id": "u_a"})
            replay = await expenses.add_expense("t", body, BackgroundTasks(), user={"id": "u_a"})
            assert first == replay
            assert await database.expenses.count_documents({}) == 2
            revision = await database.expense_share_revisions.find_one({"expense_id": first["expense"]["id"]})
            assert revision["evidence"] == "recorded_at_creation"
            assert await database.expense_mutation_receipts.count_documents({}) == 1
    asyncio.run(exercise())


def test_existing_upi_action_routes_delegate_to_one_reviewed_receipt(monkeypatch):
    async def exercise():
        from routes import payment_attempts as attempt_routes
        from services import payment_attempts as attempt_service
        from models.payment_attempt import PaymentAttemptSenderPatch, PaymentAttemptRecipientPatch
        from utils import deps
        from fastapi import BackgroundTasks
        async with isolated(monkeypatch) as (database, _, _client):
            await setup_workflow(monkeypatch, database)
            for module in (attempt_routes, attempt_service, deps):
                monkeypatch.setattr(module, "db", database)
            await fake_upi_quote(monkeypatch, database)
            _, request = await reviewed(database, method="upi")
            intent = await workflow.create("t", request, {"id": "u_b"})
            attempt_id = intent["cash_legs"][0]["payment_attempt_id"]
            with pytest.raises(HTTPException) as refresh:
                await attempt_routes.update_payment_attempt_sender("t", attempt_id, PaymentAttemptSenderPatch(action="report_paid"), BackgroundTasks(), {"id": "u_b"})
            assert refresh.value.status_code == 428
            report = PaymentAttemptSenderPatch(action="report_paid", client_mutation_id=uuid4(),
                expected_intent_version=intent["version"], plan_hash=intent["plan"]["plan_hash"], transaction_reference="delegated-sent-ref")
            reported = await attempt_routes.update_payment_attempt_sender("t", attempt_id, report, BackgroundTasks(), {"id": "u_b"})
            confirm = PaymentAttemptRecipientPatch(action="confirm_received", client_mutation_id=uuid4(),
                expected_intent_version=reported["version"], plan_hash=reported["plan"]["plan_hash"])
            received = await attempt_routes.update_payment_attempt_recipient("t", attempt_id, confirm, BackgroundTasks(), {"id": "u_a"})
            replay = await attempt_routes.update_payment_attempt_recipient("t", attempt_id, confirm, BackgroundTasks(), {"id": "u_a"})
            assert received == replay and received["allocation_status"] == "applied"
            assert await database.payments.count_documents({}) == 1
            assert await database.expense_coverage_events.count_documents({}) == 1
            assert (await database.payment_attempts.find_one({"id": attempt_id}))["transaction_reference"] == "delegated-sent-ref"
    asyncio.run(exercise())
