import asyncio
import os
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import ServerSelectionTimeoutError

from config import MONGO_URL
from models.payment import PaymentCreate
from routes import payments
from services import (
    admin_audit, ledger_transactions, money_audit, payment_idempotency,
    push_notifications,
)
from utils import balances


def test_manual_payment_receipt_and_ledger_share_real_transaction(monkeypatch):
    test_url = os.environ.get("PAYMENT_TEST_MONGO_URL")
    if test_url is None:
        if urlparse(MONGO_URL).hostname not in {"localhost", "127.0.0.1"}:
            pytest.skip("Set PAYMENT_TEST_MONGO_URL to an isolated test MongoDB")
        test_url = MONGO_URL

    async def exercise():
        client = AsyncIOMotorClient(test_url, serverSelectionTimeoutMS=1200)
        database = client[f"trip_splitter_payment_retry_test_{uuid4().hex}"]
        database_created = False
        try:
            try:
                await client.admin.command("ping")
            except ServerSelectionTimeoutError:
                pytest.skip("Configured MongoDB is not reachable")

            database_created = True
            await database.payment_mutation_receipts.create_index(
                [("actor_user_id", 1), ("operation", 1), ("client_mutation_id", 1)],
                unique=True,
            )
            await database.notification_outbox.create_index("event_key", unique=True)
            monkeypatch.setattr(ledger_transactions, "client", client)
            monkeypatch.setattr(payment_idempotency, "db", database)
            if not await payment_idempotency.verify_payment_transactions():
                pytest.skip("Configured MongoDB has no verified write transactions")

            for module in (payments, admin_audit, money_audit, push_notifications, balances):
                monkeypatch.setattr(module, "db", database)
            monkeypatch.setattr(push_notifications, "PUSH_NOTIFICATIONS_ENABLED", True)
            await database.trips.insert_one({
                "id": "t1", "name": "Test", "currency": "INR", "version": 0,
                "owner_id": "u1", "admin_ids": ["u1"], "user_ids": ["u1", "u2"],
                "members": [
                    {"id": "m1", "kind": "individual", "name": "Receiver", "user_id": "u1"},
                    {"id": "m2", "kind": "individual", "name": "Payer", "user_id": "u2"},
                ],
            })
            await database.expenses.insert_one({
                "id": "e1", "trip_id": "t1", "amount": 200, "currency": "INR",
                "paid_by_member_id": "m1", "split_member_ids": ["m1", "m2"],
                "split_mode": "PER_CAPITA",
            })
            user = {"id": "u1"}

            async def create(request):
                return await payments.record_payment(
                    "t1", request, BackgroundTasks(), user=user,
                )

            request = PaymentCreate(
                from_member_id="m2", to_member_id="m1", amount="60.6",
                client_mutation_id=str(uuid4()), expected_payable=100,
                expected_currency="INR",
            )
            first, same = await asyncio.gather(create(request), create(request))
            assert first == same
            assert first["amount"] == 61
            assert await database.payments.count_documents({}) == 1
            assert await database.payment_mutation_receipts.count_documents({}) == 1
            assert await database.notification_outbox.count_documents({}) == 1
            assert await database.money_normalization_audits.count_documents({}) == 1

            next_requests = [PaymentCreate(
                from_member_id="m2", to_member_id="m1", amount=20,
                client_mutation_id=str(uuid4()), expected_payable=39,
                expected_currency="INR",
            ) for _ in range(2)]
            results = await asyncio.gather(
                *(create(item) for item in next_requests), return_exceptions=True,
            )
            assert sum(isinstance(item, dict) for item in results) == 1
            errors = [item for item in results if isinstance(item, HTTPException)]
            assert len(errors) == 1
            assert errors[0].status_code == 409
            assert await database.payments.count_documents({}) == 2
            assert await database.payment_mutation_receipts.count_documents({}) == 2
            assert await database.notification_outbox.count_documents({}) == 2

            await database.payments.delete_one({"id": first["id"]})
            await database.trips.delete_one({"id": "t1"})
            assert await create(request) == first
            assert await database.payments.count_documents({}) == 1
            assert await database.notification_outbox.count_documents({}) == 2
        finally:
            payment_idempotency.disable_payment_protocol()
            try:
                if database_created:
                    await client.drop_database(database.name)
            finally:
                client.close()

    asyncio.run(exercise())
