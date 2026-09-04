import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from models.payment import PaymentCreate, PaymentPatch
from models.settlement import SettlementCreate, SettlementPatch
from routes import balances as balance_routes
from routes import payments as payment_routes
from utils import settlement_gate


TRIP = {
    "id": "t1", "currency": "LKR", "version": 7,
    "owner_id": "admin", "admin_ids": ["admin"], "user_ids": ["admin"],
    "members": [
        {"id": "a", "kind": "individual", "user_id": "admin"},
        {"id": "b", "kind": "individual", "user_id": "receiver"},
    ],
}


def run(awaitable):
    return asyncio.run(awaitable)


@pytest.fixture(autouse=True)
def whole_units(monkeypatch):
    monkeypatch.setattr(settlement_gate, "WHOLE_UNIT_SETTLEMENTS_ENABLED", True)


def _payment_db(modified_count=1):
    return SimpleNamespace(
        trips=SimpleNamespace(update_one=AsyncMock(
            return_value=SimpleNamespace(modified_count=modified_count)
        )),
        payments=SimpleNamespace(insert_one=AsyncMock(), update_one=AsyncMock(), delete_one=AsyncMock()),
    )


def test_new_payment_is_whole_and_carries_policy_audit(monkeypatch):
    fake_db = _payment_db()
    monkeypatch.setattr(payment_routes, "db", fake_db)
    monkeypatch.setattr(payment_routes, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(payment_routes, "can_record_payment", lambda *_args: True)
    monkeypatch.setattr(payment_routes, "_compute_balances", AsyncMock(return_value={
        "transfers": [{"from_member_id": "a", "to_member_id": "b", "amount": 1250}]
    }))
    monkeypatch.setattr(payment_routes, "enqueue_notification_event", AsyncMock())
    doc = run(payment_routes.record_payment(
        "t1", PaymentCreate(from_member_id="a", to_member_id="b", amount="1250"),
        BackgroundTasks(), user={"id": "admin"},
    ))
    assert doc["amount"] == 1250
    assert isinstance(doc["amount"], int)
    assert doc["settlement_policy_version"] == "whole_unit_v1"
    assert doc["settlement_increment"] == "1"


def test_large_whole_payment_is_stored_without_a_binary_float_round_trip(monkeypatch):
    amount = 9_007_199_254_740_993
    fake_db = _payment_db()
    monkeypatch.setattr(payment_routes, "db", fake_db)
    monkeypatch.setattr(payment_routes, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(payment_routes, "can_record_payment", lambda *_args: True)
    monkeypatch.setattr(payment_routes, "_compute_balances", AsyncMock(return_value={
        "transfers": [{"from_member_id": "a", "to_member_id": "b", "amount": amount}]
    }))
    monkeypatch.setattr(payment_routes, "enqueue_notification_event", AsyncMock())

    doc = run(payment_routes.record_payment(
        "t1", PaymentCreate(from_member_id="a", to_member_id="b", amount=str(amount)),
        BackgroundTasks(), user={"id": "admin"},
    ))

    assert doc["amount"] == amount
    assert isinstance(doc["amount"], int)


def test_exact_one_cent_recommendation_can_be_recorded(monkeypatch):
    trip = {**TRIP, "currency": "INR"}
    fake_db = _payment_db()
    monkeypatch.setattr(payment_routes, "db", fake_db)
    monkeypatch.setattr(payment_routes, "_trip_or_404", AsyncMock(return_value=trip))
    monkeypatch.setattr(payment_routes, "can_record_payment", lambda *_args: True)
    monkeypatch.setattr(payment_routes, "_compute_balances", AsyncMock(return_value={
        "transfers": [{"from_member_id": "a", "to_member_id": "b", "amount": 0.01}]
    }))
    monkeypatch.setattr(payment_routes, "enqueue_notification_event", AsyncMock())

    doc = run(payment_routes.record_payment(
        "t1", PaymentCreate(from_member_id="a", to_member_id="b", amount="0.01"),
        BackgroundTasks(), user={"id": "admin"},
    ))

    assert doc["amount"] == 0.01


def test_decimal_new_or_amount_edited_payment_is_rejected_but_note_only_legacy_edit_works(monkeypatch):
    monkeypatch.setattr(payment_routes, "db", _payment_db())
    monkeypatch.setattr(payment_routes, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(payment_routes, "can_record_payment", lambda *_args: True)
    with pytest.raises(HTTPException, match="whole-rupee"):
        run(payment_routes.record_payment(
            "t1", PaymentCreate(from_member_id="a", to_member_id="b", amount="10.25"),
            BackgroundTasks(), user={"id": "admin"},
        ))

    legacy = {"id": "p-old", "trip_id": "t1", "from_member_id": "a",
              "to_member_id": "b", "amount": 10.25, "note": "old"}
    monkeypatch.setattr(payment_routes, "_payment_or_403", AsyncMock(return_value=(TRIP, legacy)))
    edited = run(payment_routes.edit_payment(
        "t1", "p-old", PaymentPatch(note="kept precisely"), user={"id": "admin"},
    ))
    assert edited["amount"] == 10.25 and edited["note"] == "kept precisely"
    resent = run(payment_routes.edit_payment(
        "t1", "p-old", PaymentPatch(amount="10.25", note="old client"), user={"id": "admin"},
    ))
    assert resent["amount"] == 10.25 and resent["note"] == "old client"
    with pytest.raises(HTTPException, match="whole-rupee"):
        run(payment_routes.edit_payment(
            "t1", "p-old", PaymentPatch(amount="10.5"), user={"id": "admin"},
        ))


def test_stale_payment_write_keeps_version_conflict(monkeypatch):
    monkeypatch.setattr(payment_routes, "db", _payment_db(modified_count=0))
    monkeypatch.setattr(payment_routes, "_trip_or_404", AsyncMock(return_value=TRIP))
    monkeypatch.setattr(payment_routes, "can_record_payment", lambda *_args: True)
    monkeypatch.setattr(payment_routes, "_compute_balances", AsyncMock(return_value={
        "transfers": [{"from_member_id": "a", "to_member_id": "b", "amount": 10}]
    }))
    with pytest.raises(HTTPException) as error:
        run(payment_routes.record_payment(
            "t1", PaymentCreate(from_member_id="a", to_member_id="b", amount="10"),
            BackgroundTasks(), user={"id": "admin"},
        ))
    assert error.value.status_code == 409


def test_new_pending_settlement_is_whole_but_legacy_decimal_can_be_marked_paid(monkeypatch):
    db = SimpleNamespace(settlements=SimpleNamespace(insert_one=AsyncMock(), update_one=AsyncMock()))
    monkeypatch.setattr(balance_routes, "db", db)
    monkeypatch.setattr(balance_routes, "_trip_or_404", AsyncMock(return_value=TRIP))
    with pytest.raises(HTTPException, match="whole-rupee"):
        run(balance_routes.create_settlement(
            "t1", SettlementCreate(from_member_id="a", to_member_id="b", amount="9.5"),
            user={"id": "admin"},
        ))

    pending = {"id": "s-old", "trip_id": "t1", "from_member_id": "a",
               "to_member_id": "b", "amount": 9.5, "status": "pending"}
    monkeypatch.setattr(
        balance_routes, "_settlement_mark_paid_or_403", AsyncMock(return_value=(TRIP, pending))
    )
    monkeypatch.setattr(balance_routes, "enqueue_notification_event", AsyncMock())
    result = run(balance_routes.mark_settlement_paid(
        "t1", "s-old", SettlementPatch(status="paid"), BackgroundTasks(), user={"id": "admin"},
    ))
    assert result["amount"] == 9.5 and result["status"] == "paid"
