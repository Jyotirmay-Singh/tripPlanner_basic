import asyncio
from copy import deepcopy
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException
from pymongo.errors import DuplicateKeyError

from models.expense import ExpenseIn
from routes import expenses, meta
from services import expense_idempotency
from services.ledger_transactions import TransactionUnavailableError


class MemoryStore:
    def __init__(self, *, budget=None):
        self.trip = {
            "id": "t1", "currency": "INR", "budget": budget, "version": 0,
            "user_ids": ["u1"],
            "members": [
                {"id": "m1", "kind": "individual", "name": "One", "user_id": "u1"},
                {"id": "m2", "kind": "individual", "name": "Two", "user_id": "u2"},
            ],
        }
        self.receipts = []
        self.expenses = []
        self.audit = []
        self.notifications = []
        self.lock = asyncio.Lock()
        self.db = SimpleNamespace(
            trips=SimpleNamespace(find_one=self.find_trip, update_one=self.update_trip),
            expenses=SimpleNamespace(insert_one=self.insert_expense, aggregate=self.aggregate),
            expense_mutation_receipts=SimpleNamespace(
                find_one=self.find_receipt, insert_one=self.insert_receipt,
            ),
        )

    async def find_trip(self, _query, _projection, *, session):
        return deepcopy(self.trip)

    async def update_trip(self, query, _update, *, session):
        if self.trip is None or self.trip["version"] != query.get("version"):
            return SimpleNamespace(matched_count=0)
        self.trip["version"] += 1
        return SimpleNamespace(matched_count=1)

    async def find_receipt(self, key):
        return next(
            (deepcopy(row) for row in self.receipts if all(row.get(k) == v for k, v in key.items())),
            None,
        )

    async def insert_receipt(self, row, *, session):
        key = expense_idempotency.receipt_key(row["actor_user_id"], row["client_mutation_id"])
        if await self.find_receipt(key):
            raise DuplicateKeyError("duplicate mutation")
        self.receipts.append(deepcopy(row))

    async def insert_expense(self, row, *, session):
        self.expenses.append(deepcopy(row))

    def aggregate(self, pipeline, **kwargs):
        total = sum(row["amount"] for row in self.expenses)
        return SimpleNamespace(to_list=AsyncMock(return_value=[{"sum": total}]))

    async def transact(self, callback):
        async with self.lock:
            state = deepcopy((self.trip, self.receipts, self.expenses, self.audit, self.notifications))
            try:
                return await callback(object())
            except Exception:
                self.trip, self.receipts, self.expenses, self.audit, self.notifications = state
                raise


def setup(monkeypatch, *, budget=None):
    store = MemoryStore(budget=budget)
    monkeypatch.setattr(expenses, "db", store.db)
    monkeypatch.setattr(expenses, "expense_protocol_ready", lambda: True)
    monkeypatch.setattr(expenses, "run_required_transaction", store.transact)

    async def authorized_trip(_trip_id, _user):
        if store.trip is None:
            raise HTTPException(404, "Trip not found")
        if "u1" not in store.trip["user_ids"]:
            raise HTTPException(403, "Not a member of this trip")
        return deepcopy(store.trip)

    async def audit(*_args, **kwargs):
        assert kwargs["session"] is not None
        store.audit.append(kwargs["resource_id"])

    async def notification(**kwargs):
        assert kwargs["session"] is not None
        store.notifications.append(kwargs["source_id"])

    async def normalization(*_args, **kwargs):
        assert kwargs["session"] is not None

    monkeypatch.setattr(expenses, "_trip_or_404", authorized_trip)
    monkeypatch.setattr(expenses, "record_admin_action", audit)
    monkeypatch.setattr(expenses, "record_money_normalizations", normalization)
    monkeypatch.setattr(expenses, "enqueue_notification_event", notification)
    return store


def body(store, *, mutation_id=None, **overrides):
    data = {
        "amount": 10, "category": "Food", "date": "25-09-26",
        "paid_by_member_id": "m1", "split_member_ids": ["m1", "m2"],
        "client_mutation_id": mutation_id or str(uuid4()),
        "expected_roster": {
            "currency": "INR",
            "members": [
                {"id": "m1", "kind": "individual"},
                {"id": "m2", "kind": "individual"},
            ],
        },
    }
    data.update(overrides)
    return ExpenseIn(**data)


async def create(request, *, force=False):
    return await expenses.add_expense(
        "t1", request, BackgroundTasks(), force=force,
        user={"id": "u1", "email": "one@gmail.com"},
    )


def test_concurrent_retry_and_changed_intent(monkeypatch):
    store = setup(monkeypatch)
    request = body(store)

    async def exercise():
        first, second = await asyncio.gather(create(request), create(request))
        assert first == second
        with pytest.raises(HTTPException) as error:
            await create(body(store, mutation_id=str(request.client_mutation_id), amount=11))
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "client_mutation_conflict"

    asyncio.run(exercise())
    assert len(store.expenses) == len(store.receipts) == 1
    assert len(store.audit) == len(store.notifications) == 1


def test_lost_response_and_deleted_expense_replay(monkeypatch):
    store = setup(monkeypatch)
    request = body(store)
    accepted = asyncio.run(create(request))
    store.expenses.clear()
    store.trip = None
    replay = asyncio.run(create(request))
    assert replay == accepted
    assert store.expenses == []
    assert len(store.receipts) == len(store.audit) == len(store.notifications) == 1


def test_equivalent_decimal_spelling_replays_same_intent(monkeypatch):
    store = setup(monkeypatch)
    request = body(store, amount=Decimal("10.00"))
    accepted = asyncio.run(create(request))
    equivalent = body(store, mutation_id=str(request.client_mutation_id), amount=10)
    assert asyncio.run(create(equivalent)) == accepted
    assert len(store.expenses) == 1


def test_changed_relevant_roster_rejected_but_unrelated_member_allowed(monkeypatch):
    store = setup(monkeypatch)
    request = body(store)
    store.trip["members"].append({"id": "m3", "kind": "individual"})
    asyncio.run(create(request))
    store.trip["members"][1]["kind"] = "family"
    store.trip["members"][1]["family_members"] = ["A", "B"]
    store.trip["members"][1]["family_member_ids"] = ["p1", "p2"]
    with pytest.raises(HTTPException) as error:
        asyncio.run(create(body(store)))
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "expense_roster_changed"
    assert len(store.expenses) == 1


def test_roster_change_between_validation_and_transaction_is_rejected(monkeypatch):
    store = setup(monkeypatch)
    request = body(store)

    async def change_before_transaction(callback):
        store.trip["members"][1]["kind"] = "family"
        store.trip["members"][1]["family_members"] = ["A"]
        store.trip["members"][1]["family_member_ids"] = ["p1"]
        return await store.transact(callback)

    monkeypatch.setattr(expenses, "run_required_transaction", change_before_transaction)
    with pytest.raises(HTTPException) as error:
        asyncio.run(create(request))
    assert error.value.detail["code"] == "expense_roster_changed"
    assert store.receipts == store.expenses == store.notifications == []


def test_failed_side_effect_rolls_back_receipt_and_allows_same_id_retry(monkeypatch):
    store = setup(monkeypatch)
    request = body(store)

    async def failed_notification(**_kwargs):
        raise RuntimeError("outbox unavailable")

    monkeypatch.setattr(expenses, "enqueue_notification_event", failed_notification)
    with pytest.raises(RuntimeError):
        asyncio.run(create(request))
    assert store.receipts == store.expenses == store.audit == []
    assert store.trip["version"] == 0

    async def notification(**kwargs):
        store.notifications.append(kwargs["source_id"])

    monkeypatch.setattr(expenses, "enqueue_notification_event", notification)
    asyncio.run(create(request))
    assert len(store.receipts) == len(store.expenses) == len(store.audit) == len(store.notifications) == 1


def test_budget_warning_consumes_no_id_and_force_can_reuse_it(monkeypatch):
    store = setup(monkeypatch, budget=5)
    request = body(store)
    warning = asyncio.run(create(request))
    assert warning["requires_confirmation"] is True
    assert store.receipts == store.expenses == []
    accepted = asyncio.run(create(request, force=True))
    assert accepted["warning"] == warning["warning"]
    assert asyncio.run(create(request)) == accepted
    assert len(store.receipts) == len(store.expenses) == 1


@pytest.mark.parametrize("overrides", [
    {"amount": 10.6},
    {"amount": 10, "split_mode": "EXACT", "custom_amounts": {"m1": 5, "m2": 5}},
    {"amount": -10},
])
def test_existing_money_modes_remain_retryable(monkeypatch, overrides):
    store = setup(monkeypatch)
    request = body(store, **overrides)
    accepted = asyncio.run(create(request))
    assert asyncio.run(create(request)) == accepted
    assert len(store.expenses) == len(store.notifications) == 1


def test_family_participants_preserved(monkeypatch):
    store = setup(monkeypatch)
    family = store.trip["members"][1]
    family.update(kind="family", family_members=["A", "B"], family_member_ids=["p1", "p2"])
    request = body(store, expected_roster={
        "currency": "INR", "members": [
            {"id": "m1", "kind": "individual"},
            {"id": "m2", "kind": "family", "family_member_ids": ["p1", "p2"]},
        ],
    }, family_participants={"m2": ["p1"]})
    accepted = asyncio.run(create(request))
    assert accepted["expense"]["family_participants"] == {"m2": ["p1"]}
    assert asyncio.run(create(request)) == accepted


def test_protocol_disabled_fails_closed_and_legacy_body_remains_valid(monkeypatch):
    store = setup(monkeypatch)
    monkeypatch.setattr(expenses, "expense_protocol_ready", lambda: False)
    with pytest.raises(HTTPException) as error:
        asyncio.run(create(body(store)))
    assert error.value.status_code == 503
    assert not store.receipts
    legacy = ExpenseIn(amount=10, category="Food", date="25-09-26", paid_by_member_id="m1")
    assert legacy.client_mutation_id is None
    monkeypatch.setattr(meta, "expense_protocol_ready", lambda: False)
    assert asyncio.run(meta.get_config())["expense_create_protocol_version"] == 0


def test_malformed_retry_request_requires_frozen_split():
    with pytest.raises(ValueError):
        ExpenseIn(amount=10, category="Food", date="25-09-26", paid_by_member_id="m1",
                  client_mutation_id=str(uuid4()), expected_roster={"currency": "INR", "members": []})


def test_capability_requires_successful_write_transaction_probe(monkeypatch):
    insert = AsyncMock()
    delete = AsyncMock()
    monkeypatch.setattr(expense_idempotency, "db", SimpleNamespace(
        command=AsyncMock(),
        expense_mutation_receipts=SimpleNamespace(insert_one=insert, delete_one=delete),
    ))

    async def unavailable(_callback):
        raise TransactionUnavailableError("standalone")

    monkeypatch.setattr(expense_idempotency, "run_required_transaction", unavailable)
    assert asyncio.run(expense_idempotency.verify_expense_transactions()) is False
    assert expense_idempotency.expense_protocol_ready() is False

    async def capable(callback):
        return await callback(object())

    monkeypatch.setattr(expense_idempotency, "run_required_transaction", capable)
    assert asyncio.run(expense_idempotency.verify_expense_transactions()) is True
    assert insert.await_count == delete.await_count == 1
    expense_idempotency.disable_expense_protocol()
