import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from config import SUPER_ADMIN_EMAIL
from routes import payments as payment_routes
from server import app
from utils.deps import get_current_user


ACTIVE_TRANSFER = {
    "from_member_id": "payer",
    "to_member_id": "recipient",
    "amount": 50,
}

INDIVIDUAL_TRIP = {
    "id": "trip-1",
    "owner_id": "owner-user",
    "admin_ids": ["owner-user", "admin-user"],
    "user_ids": [
        "owner-user", "admin-user", "payer-user", "recipient-user", "bystander-user",
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


def _fake_db(profiles):
    users = SimpleNamespace(
        find=MagicMock(return_value=_Cursor(profiles)),
        insert_one=AsyncMock(),
        update_one=AsyncMock(),
        update_many=AsyncMock(),
        delete_one=AsyncMock(),
        delete_many=AsyncMock(),
    )
    return SimpleNamespace(users=users)


def _install_route_state(monkeypatch, *, trip=None, profiles=(), transfers=None):
    trip = deepcopy(trip or INDIVIDUAL_TRIP)
    fake_db = _fake_db(profiles)
    trip_guard = AsyncMock(return_value=trip)
    balances = AsyncMock(return_value={
        "transfers": [ACTIVE_TRANSFER] if transfers is None else transfers,
    })
    monkeypatch.setattr(payment_routes, "db", fake_db)
    monkeypatch.setattr(payment_routes, "_trip_or_404", trip_guard)
    monkeypatch.setattr(payment_routes, "_compute_balances", balances)
    return fake_db, trip_guard, balances


def _run(awaitable):
    return asyncio.run(awaitable)


def _lookup(user, *, from_member_id="payer", to_member_id="recipient"):
    return _run(payment_routes.payment_recipient_details(
        "trip-1",
        from_member_id,
        to_member_id,
        user=user,
    ))


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def as_user():
    def _set(user):
        app.dependency_overrides[get_current_user] = lambda: dict(user)

    yield _set
    app.dependency_overrides.pop(get_current_user, None)


def test_payment_recipient_details_requires_authentication(client):
    response = client.get(
        "/api/trips/trip-1/payment-recipient-details",
        params={"from_member_id": "payer", "to_member_id": "recipient"},
    )

    assert response.status_code == 401


def test_individual_recipient_returns_only_roster_identity_and_fresh_upi_fields(
    client, as_user, monkeypatch,
):
    fake_db, _guard, balances = _install_route_state(monkeypatch, profiles=[{
        "id": "recipient-user",
        "email": "private@gmail.com",
        "name": "Private account name",
        "role": "user",
        "upi_id": "recipient@bank",
        "upi_updated_at": "2026-09-11T10:00:00+00:00",
    }])
    as_user({"id": "payer-user", "email": "payer@gmail.com", "role": "user"})

    response = client.get(
        "/api/trips/trip-1/payment-recipient-details",
        params={"from_member_id": "payer", "to_member_id": "recipient"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "trip_id": "trip-1",
        "from_member_id": "payer",
        "to_member_id": "recipient",
        "recipients": [{
            "person_id": "recipient",
            "name": "Recipient Person",
            "family_id": None,
            "family_name": None,
            "account_linked": True,
            "upi_id": "recipient@bank",
            "upi_updated_at": "2026-09-11T10:00:00+00:00",
        }],
    }
    fake_db.users.find.assert_called_once_with(
        {"id": {"$in": ["recipient-user"]}},
        {"_id": 0, "id": 1, "upi_id": 1, "upi_updated_at": 1},
    )
    assert "private@gmail.com" not in response.text
    assert "recipient-user" not in response.text
    balances.assert_awaited_once_with("trip-1", diagnostic=False)


def test_family_recipient_returns_every_person_in_roster_order_including_unavailable(
    monkeypatch,
):
    trip = deepcopy(INDIVIDUAL_TRIP)
    trip["members"][1] = {
        "id": "recipient",
        "name": "Recipient Family",
        "kind": "family",
        "family_members": ["First", "Unlinked", "No UPI"],
        "family_member_ids": ["person-1", "person-2", "person-3"],
        "family_member_user_ids": ["family-user-1", None, "family-user-3"],
    }
    fake_db, _guard, _balances = _install_route_state(
        monkeypatch,
        trip=trip,
        profiles=[
            {
                "id": "family-user-1",
                "upi_id": "first@bank",
                "upi_updated_at": "2026-09-11T09:00:00+00:00",
            },
            {"id": "family-user-3"},
        ],
    )

    result = _lookup({"id": "payer-user"})

    assert result["recipients"] == [
        {
            "person_id": "person-1",
            "name": "First",
            "family_id": "recipient",
            "family_name": "Recipient Family",
            "account_linked": True,
            "upi_id": "first@bank",
            "upi_updated_at": "2026-09-11T09:00:00+00:00",
        },
        {
            "person_id": "person-2",
            "name": "Unlinked",
            "family_id": "recipient",
            "family_name": "Recipient Family",
            "account_linked": False,
            "upi_id": None,
            "upi_updated_at": None,
        },
        {
            "person_id": "person-3",
            "name": "No UPI",
            "family_id": "recipient",
            "family_name": "Recipient Family",
            "account_linked": True,
            "upi_id": None,
            "upi_updated_at": None,
        },
    ]
    queried_ids = fake_db.users.find.call_args.args[0]["id"]["$in"]
    assert queried_ids == ["family-user-1", "family-user-3"]


def test_unlinked_individual_is_returned_as_unavailable_without_a_user_query(monkeypatch):
    trip = deepcopy(INDIVIDUAL_TRIP)
    trip["members"][1]["user_id"] = None
    fake_db, _guard, _balances = _install_route_state(monkeypatch, trip=trip)

    result = _lookup({"id": "payer-user"})

    assert result["recipients"][0] == {
        "person_id": "recipient",
        "name": "Recipient Person",
        "family_id": None,
        "family_name": None,
        "account_linked": False,
        "upi_id": None,
        "upi_updated_at": None,
    }
    fake_db.users.find.assert_not_called()


@pytest.mark.parametrize("user", [
    {"id": "owner-user"},
    {"id": "admin-user"},
    {"id": "root", "email": SUPER_ADMIN_EMAIL, "role": "super_admin"},
])
def test_owner_admin_and_super_admin_may_inspect_an_active_pair(user, monkeypatch):
    _install_route_state(monkeypatch, profiles=[{"id": "recipient-user"}])

    result = _lookup(user)

    assert result["to_member_id"] == "recipient"


def test_unrelated_trip_member_is_denied_before_balance_or_profile_lookup(monkeypatch):
    fake_db, _guard, balances = _install_route_state(monkeypatch)

    with pytest.raises(HTTPException) as error:
        _lookup({"id": "bystander-user"})

    assert error.value.status_code == 403
    balances.assert_not_awaited()
    fake_db.users.find.assert_not_called()


def test_outsider_is_denied_by_trip_membership_guard(monkeypatch):
    fake_db, trip_guard, balances = _install_route_state(monkeypatch)
    trip_guard.side_effect = HTTPException(403, "Not a member of this trip")

    with pytest.raises(HTTPException) as error:
        _lookup({"id": "outsider-user"})

    assert error.value.status_code == 403
    balances.assert_not_awaited()
    fake_db.users.find.assert_not_called()


@pytest.mark.parametrize("from_member_id,to_member_id", [
    ("missing-payer", "recipient"),
    ("payer", "missing-recipient"),
])
def test_unknown_member_ids_return_404(from_member_id, to_member_id, monkeypatch):
    fake_db, _guard, balances = _install_route_state(monkeypatch)

    with pytest.raises(HTTPException) as error:
        _lookup(
            {"id": "owner-user"},
            from_member_id=from_member_id,
            to_member_id=to_member_id,
        )

    assert error.value.status_code == 404
    balances.assert_not_awaited()
    fake_db.users.find.assert_not_called()


@pytest.mark.parametrize("transfers", [
    [],
    [{"from_member_id": "recipient", "to_member_id": "payer", "amount": 50}],
    [{"from_member_id": "payer", "to_member_id": "someone-else", "amount": 50}],
])
def test_inactive_or_rerouted_pair_returns_409_without_profile_lookup(transfers, monkeypatch):
    fake_db, _guard, _balances = _install_route_state(monkeypatch, transfers=transfers)

    with pytest.raises(HTTPException) as error:
        _lookup({"id": "payer-user"})

    assert error.value.status_code == 409
    fake_db.users.find.assert_not_called()


def test_lookup_performs_no_writes(monkeypatch):
    fake_db, _guard, _balances = _install_route_state(
        monkeypatch,
        profiles=[{"id": "recipient-user", "upi_id": "recipient@bank"}],
    )

    _lookup({"id": "payer-user"})

    for method in (
        fake_db.users.insert_one,
        fake_db.users.update_one,
        fake_db.users.update_many,
        fake_db.users.delete_one,
        fake_db.users.delete_many,
    ):
        method.assert_not_awaited()
