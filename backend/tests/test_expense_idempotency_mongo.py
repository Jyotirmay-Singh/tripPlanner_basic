import asyncio
import os
from copy import deepcopy
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import ServerSelectionTimeoutError

from config import MONGO_URL
from models.expense import ExpenseIn
from routes import expenses
from services import admin_audit, expense_idempotency, ledger_transactions, money_audit, push_notifications


def test_expense_receipt_and_side_effects_share_real_transaction(monkeypatch):
    test_url = os.environ.get("EXPENSE_TEST_MONGO_URL")
    if test_url is None:
        if urlparse(MONGO_URL).hostname not in {"localhost", "127.0.0.1"}:
            pytest.skip("Set EXPENSE_TEST_MONGO_URL to an isolated test MongoDB")
        test_url = MONGO_URL

    async def exercise():
        client = AsyncIOMotorClient(test_url, serverSelectionTimeoutMS=1200)
        database = client[f"trip_splitter_expense_test_{uuid4().hex}"]
        database_created = False
        try:
            try:
                await client.admin.command("ping")
            except ServerSelectionTimeoutError:
                pytest.skip("Configured MongoDB is not reachable")

            database_created = True
            await database.expense_mutation_receipts.create_index(
                [("actor_user_id", 1), ("operation", 1), ("client_mutation_id", 1)], unique=True,
            )
            await database.notification_outbox.create_index("event_key", unique=True)
            await database.admin_audit_logs.create_index("id", unique=True)
            monkeypatch.setattr(ledger_transactions, "client", client)
            monkeypatch.setattr(expense_idempotency, "db", database)
            if not await expense_idempotency.verify_expense_transactions():
                pytest.skip("Configured MongoDB has no verified write transactions")

            monkeypatch.setattr(expenses, "db", database)
            monkeypatch.setattr(admin_audit, "db", database)
            monkeypatch.setattr(money_audit, "db", database)
            monkeypatch.setattr(push_notifications, "db", database)
            monkeypatch.setattr(push_notifications, "PUSH_NOTIFICATIONS_ENABLED", True)

            trip = {
                "id": "t1", "currency": "INR", "version": 0, "user_ids": ["u1"],
                "members": [
                    {"id": "m1", "kind": "individual", "name": "One", "user_id": "u1"},
                    {"id": "m2", "kind": "individual", "name": "Two", "user_id": "u2"},
                ],
            }
            await database.trips.insert_one(deepcopy(trip))

            async def authorized_trip(_trip_id, _user):
                current = await database.trips.find_one({"id": "t1"}, {"_id": 0})
                if current is None:
                    raise HTTPException(404, "Trip not found")
                return current

            monkeypatch.setattr(expenses, "_trip_or_404", authorized_trip)
            user = {"id": "u1", "email": "one@gmail.com"}
            request = ExpenseIn(
                amount=10.6, category="Food", date="25-09-26", paid_by_member_id="m1",
                split_member_ids=["m1", "m2"], client_mutation_id=str(uuid4()),
                expected_roster={"currency": "INR", "members": [
                    {"id": "m1", "kind": "individual"},
                    {"id": "m2", "kind": "individual"},
                ]},
            )

            async def create(body):
                return await expenses.add_expense("t1", body, BackgroundTasks(), user=user)

            first, second = await asyncio.gather(create(request), create(request))
            assert first == second
            assert await database.expenses.count_documents({}) == 1
            assert await database.expense_mutation_receipts.count_documents({}) == 1
            assert await database.notification_outbox.count_documents({}) == 1
            assert await database.money_normalization_audits.count_documents({}) == 1

            stale = request.model_copy(update={"client_mutation_id": uuid4()})
            await database.trips.update_one({"id": "t1"}, {"$set": {"members.1.kind": "family"}})
            with pytest.raises(HTTPException) as conflict:
                await create(stale)
            assert conflict.value.detail["code"] == "expense_roster_changed"
            assert await database.expense_mutation_receipts.count_documents({}) == 1

            await database.expenses.delete_one({"id": first["expense"]["id"]})
            await database.trips.delete_one({"id": "t1"})
            assert await create(request) == first
            assert await database.expenses.count_documents({}) == 0
            assert await database.notification_outbox.count_documents({}) == 1
        finally:
            expense_idempotency.disable_expense_protocol()
            try:
                if database_created:
                    await client.drop_database(database.name)
            finally:
                client.close()

    asyncio.run(exercise())
