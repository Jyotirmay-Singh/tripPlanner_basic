import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
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
    inserted = False

    async def insert_one(_document):
        nonlocal inserted
        inserted = True

    async def enqueue_after_insert(**_kwargs):
        assert inserted is True

    expense_collection = SimpleNamespace(insert_one=AsyncMock(side_effect=insert_one))
    enqueue = AsyncMock(side_effect=enqueue_after_insert)
    monkeypatch.setattr(expenses, "db", SimpleNamespace(expenses=expense_collection))
    monkeypatch.setattr(expenses, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(expenses, "enqueue_notification_event", enqueue)

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
    assert kwargs["event_type"] == "expense.created"
    assert kwargs["source_id"] == result["expense"]["id"]
    assert kwargs["actor_user_id"] == "u1"
    assert kwargs["actor_name"] == "One"
    assert kwargs["expense_heading"] == "Refund"


@pytest.mark.parametrize(
    ("trip", "user", "paid_by_member_id", "expected_actor"),
    [
        (
            {
                **TRIP,
                "members": [
                    {"id": "m1", "kind": "individual", "name": "Ravi", "user_id": "u1"},
                    {"id": "m2", "kind": "individual", "name": "Ravi", "user_id": "u2"},
                ],
            },
            {"id": "u2"},
            "m2",
            "Ravi_2",
        ),
        (
            {
                **TRIP,
                "members": [{
                    "id": "family",
                    "kind": "family",
                    "name": "The Sharmas",
                    "family_members": ["Ravi", "Ravi"],
                    "family_member_ids": ["p1", "p2"],
                    "family_member_user_ids": [None, "u2"],
                }],
            },
            {"id": "u2"},
            "family",
            "Ravi_TheSharmas_2",
        ),
        (TRIP, {"id": "application-admin"}, "m1", "Application Admin"),
    ],
)
def test_expense_notification_uses_trip_specific_actor_identity(
    monkeypatch, trip, user, paid_by_member_id, expected_actor,
):
    expense_collection = SimpleNamespace(insert_one=AsyncMock())
    enqueue = AsyncMock()
    monkeypatch.setattr(expenses, "db", SimpleNamespace(expenses=expense_collection))
    monkeypatch.setattr(expenses, "_trip_or_404", AsyncMock(return_value=trip))
    monkeypatch.setattr(expenses, "enqueue_notification_event", enqueue)
    monkeypatch.setattr(
        expenses, "is_super_admin", lambda viewer: viewer["id"] == "application-admin",
    )

    run(expenses.add_expense(
        "t1",
        ExpenseIn(
            amount=25, category="Travel", description="  Airport\n taxi  ", date="25-08-26",
            paid_by_member_id=paid_by_member_id, split_member_ids=[],
        ),
        BackgroundTasks(),
        user=user,
    ))

    kwargs = enqueue.await_args.kwargs
    assert kwargs["actor_name"] == expected_actor
    assert kwargs["expense_heading"] == "Airport\n taxi"


def test_blank_expense_description_uses_category_for_notification(monkeypatch):
    expense_collection = SimpleNamespace(insert_one=AsyncMock())
    enqueue = AsyncMock()
    monkeypatch.setattr(expenses, "db", SimpleNamespace(expenses=expense_collection))
    monkeypatch.setattr(expenses, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(expenses, "enqueue_notification_event", enqueue)

    run(expenses.add_expense(
        "t1",
        ExpenseIn(
            amount=25, category="Food", description=" \n\t ", date="25-08-26",
            paid_by_member_id="m1", split_member_ids=[],
        ),
        BackgroundTasks(),
        user={"id": "u1"},
    ))

    assert enqueue.await_args.kwargs["expense_heading"] == "Food"


def test_failed_expense_insert_does_not_enqueue(monkeypatch):
    expense_collection = SimpleNamespace(
        insert_one=AsyncMock(side_effect=RuntimeError("write failed")),
    )
    enqueue = AsyncMock()
    monkeypatch.setattr(expenses, "db", SimpleNamespace(expenses=expense_collection))
    monkeypatch.setattr(expenses, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(expenses, "enqueue_notification_event", enqueue)

    with pytest.raises(RuntimeError, match="write failed"):
        run(expenses.add_expense(
            "t1",
            ExpenseIn(
                amount=25, category="Food", description="Dinner", date="25-08-26",
                paid_by_member_id="m1", split_member_ids=[],
            ),
            BackgroundTasks(),
            user={"id": "u1"},
        ))

    enqueue.assert_not_awaited()


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
    monkeypatch.setattr(expenses, "enqueue_notification_event", enqueue)

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
    monkeypatch.setattr(payments, "enqueue_notification_event", enqueue)

    result = run(payments.record_payment(
        "t1",
        PaymentCreate(from_member_id="m2", to_member_id="m1", amount=25),
        BackgroundTasks(),
        user={"id": "u1"},
    ))

    assert result["amount"] == 25
    payment_collection.insert_one.assert_awaited_once()
    kwargs = enqueue.await_args.kwargs
    assert kwargs["event_type"] == "payment.recorded"
    assert kwargs["source_id"] == result["id"]


def test_pending_settlement_never_enqueues_paid_activity(monkeypatch):
    settlement_collection = SimpleNamespace(insert_one=AsyncMock())
    enqueue = AsyncMock()
    monkeypatch.setattr(balances, "db", SimpleNamespace(settlements=settlement_collection))
    monkeypatch.setattr(balances, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(balances, "enqueue_notification_event", enqueue)

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
    monkeypatch.setattr(balances, "enqueue_notification_event", enqueue)

    run(balances.settle(
        "t1", SettleIn(from_member_id="m2", to_member_id="m1", amount=25),
        BackgroundTasks(), user={"id": "u1"},
    ))
    assert enqueue.await_args.kwargs["event_type"] == "settlement.paid"

    enqueue.reset_mock()
    monkeypatch.setattr(balances, "_settlement_mark_paid_or_403", AsyncMock(return_value=(
        TRIP, {"id": "s1", "trip_id": "t1", "status": "pending"},
    )))
    run(balances.mark_settlement_paid(
        "t1", "s1", SettlementPatch(status="paid"), BackgroundTasks(), user={"id": "u1"},
    ))
    enqueue.assert_awaited_once()
    assert enqueue.await_args.kwargs["event_type"] == "settlement.paid"
    assert enqueue.await_args.kwargs["source_id"] == "s1"

    enqueue.reset_mock()
    monkeypatch.setattr(balances, "_settlement_mark_paid_or_403", AsyncMock(return_value=(
        TRIP, {"id": "s1", "trip_id": "t1", "status": "paid"},
    )))
    run(balances.mark_settlement_paid(
        "t1", "s1", SettlementPatch(status="paid"), BackgroundTasks(), user={"id": "u1"},
    ))
    enqueue.assert_not_awaited()
