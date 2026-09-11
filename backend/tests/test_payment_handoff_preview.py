import asyncio
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from bson.decimal128 import Decimal128
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from config import SUPER_ADMIN_EMAIL
from models.payment import PaymentHandoffPreviewRequest
from routes import payments as payment_routes
from server import app
from services.exchange_rates import ExchangeRateError
from utils.common import now_utc
from utils.deps import get_current_user


TRIP = {
    "id": "trip-1",
    "name": "Goa Weekend",
    "currency": "INR",
    "owner_id": "owner-user",
    "admin_ids": ["owner-user", "admin-user"],
    "user_ids": [
        "owner-user", "admin-user", "payer-user", "recipient-user", "other-user",
    ],
    "members": [
        {
            "id": "payer",
            "name": "Payer Person",
            "kind": "individual",
            "user_id": "payer-user",
        },
        {
            "id": "recipient",
            "name": "Recipient Person",
            "kind": "individual",
            "user_id": "recipient-user",
        },
    ],
}


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, _length):
        return [dict(row) for row in self.rows]


def _collection(*, rows=(), found=None):
    return SimpleNamespace(
        find=MagicMock(return_value=_Cursor(rows)),
        find_one=AsyncMock(return_value=found),
        insert_one=AsyncMock(),
        update_one=AsyncMock(),
        update_many=AsyncMock(),
        delete_one=AsyncMock(),
        delete_many=AsyncMock(),
    )


def _created_quote(**overrides):
    return {
        "quote_id": "quote-new",
        "rate": "1",
        "effective_rate_date": None,
        "provider": "identity",
        "stale": False,
        "expires_at": (now_utc() + timedelta(minutes=30)).isoformat(),
        "target_amount": "25.00",
        **overrides,
    }


def _stored_quote(**overrides):
    return {
        "id": "quote-existing",
        "user_id": "payer-user",
        "mode": "automatic",
        "source_amount": Decimal128("25.00"),
        "source_currency": "INR",
        "target_amount": Decimal128("25.00"),
        "target_currency": "INR",
        "rate": Decimal128("1"),
        "effective_rate_date": None,
        "provider": "identity",
        "stale": False,
        "expires_at": now_utc() + timedelta(minutes=10),
        "payment_handoff": {
            "trip_id": "trip-1",
            "from_member_id": "payer",
            "to_member_id": "recipient",
            "current_payable": "50.00",
        },
        **overrides,
    }


def _install(monkeypatch, *, trip=None, amount=50, transfers=None, quote=None,
             create_result=None, create_error=None, profiles=None):
    trip = deepcopy(trip or TRIP)
    users = _collection(rows=profiles or [{
        "id": "recipient-user",
        "upi_id": "recipient@upi",
        "upi_updated_at": "2026-09-11T10:00:00+00:00",
    }])
    quotes = _collection(found=quote)
    fake_db = SimpleNamespace(
        users=users,
        exchange_rate_quotes=quotes,
        payments=_collection(),
        settlements=_collection(),
        trips=_collection(),
        notification_outbox=_collection(),
        admin_audit_logs=_collection(),
    )
    balances = AsyncMock(return_value={
        "transfers": transfers if transfers is not None else [{
            "from_member_id": "payer", "to_member_id": "recipient", "amount": amount,
        }],
    })
    creator = AsyncMock(
        side_effect=create_error,
        return_value=create_result or _created_quote(),
    )
    monkeypatch.setattr(payment_routes, "db", fake_db)
    monkeypatch.setattr(payment_routes, "_trip_or_404", AsyncMock(return_value=trip))
    monkeypatch.setattr(payment_routes, "_compute_balances", balances)
    monkeypatch.setattr(payment_routes, "create_quote", creator)
    return fake_db, balances, creator


def _run(awaitable):
    return asyncio.run(awaitable)


def _preview(user=None, **body):
    payload = PaymentHandoffPreviewRequest(
        from_member_id=body.pop("from_member_id", "payer"),
        to_member_id=body.pop("to_member_id", "recipient"),
        amount=body.pop("amount", "25.00"),
        quote_id=body.pop("quote_id", None),
    )
    assert not body
    return _run(payment_routes.preview_payment_handoff(
        "trip-1", payload, user=user or {"id": "payer-user"},
    ))


@pytest.fixture
def client():
    return TestClient(app)


def test_preview_requires_authentication(client):
    response = client.post("/api/trips/trip-1/payment-handoff/preview", json={
        "from_member_id": "payer",
        "to_member_id": "recipient",
        "amount": "25.00",
    })
    assert response.status_code == 401


def test_request_requires_decimal_string_boundary():
    with pytest.raises(ValidationError):
        PaymentHandoffPreviewRequest(
            from_member_id="payer", to_member_id="recipient", amount=25,
        )


def test_individual_payer_gets_identity_preview_with_fresh_recipient(monkeypatch):
    _fake_db, balances, creator = _install(monkeypatch)

    result = _preview()

    assert result == {
        "trip_id": "trip-1",
        "trip_name": "Goa Weekend",
        "from_member_id": "payer",
        "from_name": "Payer Person",
        "to_member_id": "recipient",
        "to_name": "Recipient Person",
        "source_amount": "25.00",
        "source_currency": "INR",
        "current_payable": "50.00",
        "inr_amount": "25.00",
        "quote": {
            "quote_id": "quote-new",
            "rate": "1",
            "effective_rate_date": None,
            "provider": "identity",
            "stale": False,
            "expires_at": creator.return_value["expires_at"],
        },
        "recipients": [{
            "person_id": "recipient",
            "name": "Recipient Person",
            "family_id": None,
            "family_name": None,
            "account_linked": True,
            "upi_id": "recipient@upi",
            "upi_updated_at": "2026-09-11T10:00:00+00:00",
        }],
    }
    balances.assert_awaited_once_with("trip-1", diagnostic=False)
    creator.assert_awaited_once()
    kwargs = creator.await_args.kwargs
    assert kwargs["source_currency"] == "INR"
    assert kwargs["target_currency"] == "INR"
    assert kwargs["mode"] == "automatic"
    assert kwargs["payment_handoff"]["current_payable"] == "50.00"


def test_linked_person_in_payer_family_is_authorized(monkeypatch):
    trip = deepcopy(TRIP)
    trip["user_ids"].append("family-user-2")
    trip["members"][0] = {
        "id": "payer",
        "name": "Payer Family",
        "kind": "family",
        "family_members": ["One", "Two"],
        "family_member_ids": ["p1", "p2"],
        "family_member_user_ids": [None, "family-user-2"],
    }
    _install(monkeypatch, trip=trip)

    result = _preview(user={"id": "family-user-2"})

    assert result["from_name"] == "Payer Family"


@pytest.mark.parametrize("user", [
    {"id": "owner-user"},
    {"id": "admin-user"},
    {"id": "other-user"},
    {"id": "root", "email": SUPER_ADMIN_EMAIL, "role": "super_admin"},
])
def test_unlinked_admins_and_members_cannot_initiate(user, monkeypatch):
    fake_db, balances, creator = _install(monkeypatch)

    with pytest.raises(HTTPException) as caught:
        _preview(user=user)

    assert caught.value.status_code == 403
    assert caught.value.detail["code"] == "wrong_payer"
    balances.assert_not_awaited()
    creator.assert_not_awaited()
    fake_db.users.find.assert_not_called()


@pytest.mark.parametrize("transfers", [
    [],
    [{"from_member_id": "recipient", "to_member_id": "payer", "amount": 50}],
    [{"from_member_id": "payer", "to_member_id": "other", "amount": 50}],
])
def test_inactive_or_rerouted_pair_is_structured(transfers, monkeypatch):
    fake_db, _balances, creator = _install(monkeypatch, transfers=transfers)
    with pytest.raises(HTTPException) as caught:
        _preview()
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payment_pair_inactive"
    creator.assert_not_awaited()
    fake_db.users.find.assert_not_called()


def test_partial_amount_cap_and_changed_payable(monkeypatch):
    _install(monkeypatch, amount=10)
    with pytest.raises(HTTPException) as caught:
        _preview(amount="10.01")
    assert caught.value.detail == {
        "code": "payable_changed",
        "message": "The payable changed; review the latest amount before continuing",
        "retryable": False,
        "current_payable": "10.00",
        "source_currency": "INR",
    }


@pytest.mark.parametrize("amount", ["0", "-1", "not-money", "NaN", "Infinity"])
def test_non_positive_or_non_finite_amount_is_structured(amount, monkeypatch):
    _install(monkeypatch)
    with pytest.raises(HTTPException) as caught:
        _preview(amount=amount)
    assert caught.value.detail["code"] == "invalid_amount"


def test_currency_precision_and_whole_unit_policy_are_enforced(monkeypatch):
    jpy = deepcopy(TRIP)
    jpy["currency"] = "JPY"
    _install(monkeypatch, trip=jpy)
    with pytest.raises(HTTPException) as precision:
        _preview(amount="1.1")
    assert precision.value.status_code == 422
    assert precision.value.detail["code"] == "invalid_currency_precision"

    lkr = deepcopy(TRIP)
    lkr["currency"] = "LKR"
    _install(monkeypatch, trip=lkr)
    monkeypatch.setattr("utils.settlement_gate.WHOLE_UNIT_SETTLEMENTS_ENABLED", True)
    with pytest.raises(HTTPException) as whole:
        _preview(amount="1.25")
    assert whole.value.detail["code"] == "whole_unit_required"


def test_non_inr_conversion_result_and_stale_marker_are_preserved(monkeypatch):
    usd = deepcopy(TRIP)
    usd["currency"] = "USD"
    _fake_db, _balances, creator = _install(
        monkeypatch,
        trip=usd,
        create_result=_created_quote(
            rate="83.4567",
            target_amount="2086.42",
            provider="frankfurter_v2_blended",
            effective_rate_date="2026-09-10",
            stale=True,
        ),
    )

    result = _preview()

    assert result["inr_amount"] == "2086.42"
    assert result["quote"]["stale"] is True
    assert creator.await_args.kwargs["source_currency"] == "USD"
    assert creator.await_args.kwargs["target_currency"] == "INR"


def test_existing_fresh_quote_is_revalidated_without_replacement(monkeypatch):
    fake_db, _balances, creator = _install(monkeypatch, quote=_stored_quote())

    result = _preview(quote_id="quote-existing")

    assert result["quote"]["quote_id"] == "quote-existing"
    assert result["inr_amount"] == "25.00"
    creator.assert_not_awaited()
    fake_db.exchange_rate_quotes.find_one.assert_awaited_once_with(
        {"id": "quote-existing"}, {"_id": 0}
    )


def test_stale_existing_quote_is_permitted(monkeypatch):
    _install(monkeypatch, quote=_stored_quote(stale=True))
    assert _preview(quote_id="quote-existing")["quote"]["stale"] is True


def test_expired_foreign_amount_mismatched_and_changed_payable_quotes(monkeypatch):
    cases = [
        (_stored_quote(expires_at=now_utc() - timedelta(seconds=1)), "quote_expired", 428),
        (_stored_quote(user_id="someone-else"), "quote_not_owned", 403),
        (_stored_quote(source_amount=Decimal128("24.00")), "quote_mismatch", 409),
        (_stored_quote(payment_handoff={
            "trip_id": "trip-1", "from_member_id": "payer",
            "to_member_id": "recipient", "current_payable": "49.00",
        }), "payable_changed", 409),
    ]
    for quote, code, status in cases:
        _install(monkeypatch, quote=quote)
        with pytest.raises(HTTPException) as caught:
            _preview(quote_id="quote-existing")
        assert caught.value.status_code == status
        assert caught.value.detail["code"] == code


def test_missing_quote_and_unavailable_conversion_are_structured(monkeypatch):
    _install(monkeypatch, quote=None)
    with pytest.raises(HTTPException) as missing:
        _preview(quote_id="quote-existing")
    assert missing.value.detail["code"] == "quote_expired"

    _install(monkeypatch, create_error=ExchangeRateError(
        "Provider timed out", code="exchange_rate_timeout", status_code=503,
    ))
    with pytest.raises(HTTPException) as unavailable:
        _preview()
    assert unavailable.value.status_code == 503
    assert unavailable.value.detail["code"] == "conversion_unavailable"
    assert unavailable.value.detail["conversion_code"] == "exchange_rate_timeout"


def test_preview_never_writes_payment_settlement_trip_notification_or_audit(monkeypatch):
    fake_db, _balances, _creator = _install(monkeypatch)

    _preview()

    for name in (
        "payments", "settlements", "trips", "notification_outbox", "admin_audit_logs",
    ):
        collection = getattr(fake_db, name)
        for method in (
            collection.insert_one,
            collection.update_one,
            collection.update_many,
            collection.delete_one,
            collection.delete_many,
        ):
            method.assert_not_awaited()
