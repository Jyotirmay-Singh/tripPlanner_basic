import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import BackgroundTasks

from models.expense import ExpenseIn
from models.payment import PaymentCreate
from models.settlement import SettleIn, SettlementCreate, SettlementPatch
from routes import balances, expenses, payments


TRIP = {
    "id": "t1",
    "currency": "INR",
    "version": 0,
    "user_ids": ["u1", "u2"],
    "members": [
        {"id": "m1", "kind": "individual", "name": "One", "user_id": "u1"},
        {"id": "m2", "kind": "individual", "name": "Two", "user_id": "u2"},
    ],
}


def run(awaitable):
    return asyncio.run(awaitable)


def test_successful_expense_enqueues_after_insert(monkeypatch):
    expense_collection = SimpleNamespace(insert_one=AsyncMock())
    enqueue = AsyncMock()
    monkeypatch.setattr(expenses, "db", SimpleNamespace(expenses=expense_collection))
    monkeypatch.setattr(expenses, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(expenses, "enqueue_financial_event", enqueue)

    result = run(expenses.add_expense(
        "t1",
        ExpenseIn(
            amount=-25, category="Food", description="Refund", date="25-08-26",
            paid_by_member_id="m1", split_member_ids=[],
        ),
        BackgroundTasks(),
        user={"id": "u1"},
    ))

    assert result["expense"]["amount"] == -25
    expense_collection.insert_one.assert_awaited_once()
    kwargs = enqueue.await_args.kwargs
    assert kwargs["event_key"].startswith("expense.created:")
    assert kwargs["target"] == "trip_expenses"
    assert kwargs["actor_user_id"] == "u1"


def test_budget_confirmation_does_not_enqueue(monkeypatch):
    class Aggregate:
        async def to_list(self, _length):
            return [{"sum": 90}]

    expense_collection = SimpleNamespace(
        aggregate=lambda *_args, **_kwargs: Aggregate(), insert_one=AsyncMock(),
    )
    enqueue = AsyncMock()
    monkeypatch.setattr(expenses, "db", SimpleNamespace(expenses=expense_collection))
    monkeypatch.setattr(expenses, "_trip_or_404", AsyncMock(return_value={**TRIP, "budget": 100}))
    monkeypatch.setattr(expenses, "enqueue_financial_event", enqueue)

    result = run(expenses.add_expense(
        "t1",
        ExpenseIn(
            amount=20, category="Food", date="25-08-26",
            paid_by_member_id="m1", split_member_ids=[],
        ),
        BackgroundTasks(),
        user={"id": "u1"},
    ))

    assert result["requires_confirmation"] is True
    expense_collection.insert_one.assert_not_awaited()
    enqueue.assert_not_awaited()


def test_successful_payment_enqueues_only_after_guard_and_insert(monkeypatch):
    trips = SimpleNamespace(update_one=AsyncMock(return_value=SimpleNamespace(modified_count=1)))
    payment_collection = SimpleNamespace(insert_one=AsyncMock())
    enqueue = AsyncMock()
    monkeypatch.setattr(payments, "db", SimpleNamespace(trips=trips, payments=payment_collection))
    monkeypatch.setattr(payments, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(payments, "can_record_payment", lambda *_args: True)
    monkeypatch.setattr(payments, "_compute_balances", AsyncMock(return_value={
        "transfers": [{"from_member_id": "m2", "to_member_id": "m1", "amount": 100}],
    }))
    monkeypatch.setattr(payments, "enqueue_financial_event", enqueue)

    result = run(payments.record_payment(
        "t1",
        PaymentCreate(from_member_id="m2", to_member_id="m1", amount=25),
        BackgroundTasks(),
        user={"id": "u1"},
    ))

    assert result["amount"] == 25
    payment_collection.insert_one.assert_awaited_once()
    kwargs = enqueue.await_args.kwargs
    assert kwargs["event_key"].startswith("payment.recorded:")
    assert kwargs["target"] == "settle_up"


def test_pending_settlement_never_enqueues_paid_activity(monkeypatch):
    settlement_collection = SimpleNamespace(insert_one=AsyncMock())
    enqueue = AsyncMock()
    monkeypatch.setattr(balances, "db", SimpleNamespace(settlements=settlement_collection))
    monkeypatch.setattr(balances, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(balances, "enqueue_financial_event", enqueue)

    result = run(balances.create_settlement(
        "t1",
        SettlementCreate(from_member_id="m2", to_member_id="m1", amount=25),
        user={"id": "u1"},
    ))

    assert result["status"] == "pending"
    enqueue.assert_not_awaited()


def test_paid_settlement_paths_enqueue_once_and_idempotent_patch_does_not(monkeypatch):
    settlements = SimpleNamespace(insert_one=AsyncMock(), update_one=AsyncMock())
    enqueue = AsyncMock()
    monkeypatch.setattr(balances, "db", SimpleNamespace(settlements=settlements))
    monkeypatch.setattr(balances, "can_record_payment", lambda *_args: True)
    monkeypatch.setattr(balances, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(balances, "enqueue_financial_event", enqueue)

    run(balances.settle(
        "t1", SettleIn(from_member_id="m2", to_member_id="m1", amount=25),
        BackgroundTasks(), user={"id": "u1"},
    ))
    assert enqueue.await_args.kwargs["event_key"].startswith("settlement.paid:")

    enqueue.reset_mock()
    monkeypatch.setattr(balances, "_settlement_mark_paid_or_403", AsyncMock(return_value=(
        TRIP, {"id": "s1", "trip_id": "t1", "status": "pending"},
    )))
    run(balances.mark_settlement_paid(
        "t1", "s1", SettlementPatch(status="paid"), BackgroundTasks(), user={"id": "u1"},
    ))
    enqueue.assert_awaited_once()
    assert enqueue.await_args.kwargs["event_key"] == "settlement.paid:s1"

    enqueue.reset_mock()
    monkeypatch.setattr(balances, "_settlement_mark_paid_or_403", AsyncMock(return_value=(
        TRIP, {"id": "s1", "trip_id": "t1", "status": "paid"},
    )))
    run(balances.mark_settlement_paid(
        "t1", "s1", SettlementPatch(status="paid"), BackgroundTasks(), user={"id": "u1"},
    ))
    enqueue.assert_not_awaited()
