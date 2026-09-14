import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import BackgroundTasks

from models.expense import ExpenseUpdate
from models.member import MemberUpdate
from models.payment import PaymentPatch
from models.settlement import SettlementCreate, SettlementPatch
from models.trip import TripIn
from routes import balances as balance_routes
from routes import expenses as expense_routes
from routes import members as member_routes
from routes import payments as payment_routes
from routes import trips as trip_routes
from services import reallocation
from services.trip_activity import (
    activity_update,
    backfill_trip_activity,
    reconstructed_activity_at,
    touch_trip_activity,
    touch_trip_activity_safely,
    with_trip_activity,
)


def run(awaitable):
    return asyncio.run(awaitable)


def _matches(row, query):
    for key, expected in query.items():
        actual = row.get(key)
        if key == "user_ids":
            if expected not in (actual or []):
                return False
        elif isinstance(expected, dict) and "$ne" in expected:
            if actual == expected["$ne"]:
                return False
        elif actual != expected:
            return False
    return True


def _project(row, projection):
    result = deepcopy(row)
    if not projection:
        return result
    included = [key for key, enabled in projection.items() if enabled and key != "_id"]
    if included:
        result = {key: result[key] for key in included if key in result}
    for key, enabled in projection.items():
        if not enabled:
            result.pop(key, None)
    return result


class MemoryCursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, fields, direction=None):
        specs = [(fields, direction)] if isinstance(fields, str) else list(fields)
        for field, order in reversed(specs):
            self.rows.sort(key=lambda row: row.get(field) or "", reverse=order < 0)
        return self

    async def to_list(self, length=None):
        rows = self.rows if length is None else self.rows[:length]
        return deepcopy(rows)

    def __aiter__(self):
        self._index = 0
        return self

    async def __anext__(self):
        if self._index >= len(self.rows):
            raise StopAsyncIteration
        row = deepcopy(self.rows[self._index])
        self._index += 1
        return row


class MemoryCollection:
    def __init__(self, rows=()):
        self.rows = [deepcopy(row) for row in rows]
        self.updates = []

    def find(self, query, projection=None):
        return MemoryCursor([
            _project(row, projection) for row in self.rows if _matches(row, query)
        ])

    async def find_one(self, query, projection=None, **_options):
        row = next((row for row in self.rows if _matches(row, query)), None)
        return _project(row, projection) if row is not None else None

    async def insert_one(self, document, **_options):
        self.rows.append(deepcopy(document))
        return SimpleNamespace(inserted_id=document.get("id"))

    async def update_one(self, query, update, **_options):
        self.updates.append((deepcopy(query), deepcopy(update)))
        row = next((row for row in self.rows if _matches(row, query)), None)
        if row is None:
            return SimpleNamespace(matched_count=0, modified_count=0)
        before = deepcopy(row)
        row.update(deepcopy(update.get("$set", {})))
        for key, value in update.get("$inc", {}).items():
            row[key] = row.get(key, 0) + value
        for key, value in update.get("$max", {}).items():
            if key not in row or row[key] < value:
                row[key] = value
        return SimpleNamespace(matched_count=1, modified_count=int(before != row))

    async def delete_one(self, query, **_options):
        for index, row in enumerate(self.rows):
            if _matches(row, query):
                self.rows.pop(index)
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)


def test_activity_update_is_monotonic_and_composes_with_version_guard():
    trips = MemoryCollection([{
        "id": "t1", "version": 2, "last_activity_at": "2026-09-10T10:00:00+00:00",
    }])
    database = SimpleNamespace(trips=trips)

    run(touch_trip_activity(database, "t1", timestamp="2026-09-11T10:00:00Z"))
    run(touch_trip_activity(database, "t1", timestamp="2026-09-09T10:00:00-04:00"))

    assert trips.rows[0]["last_activity_at"] == "2026-09-11T10:00:00+00:00"
    mutation = with_trip_activity(
        {"$inc": {"version": 1}}, "2026-09-12T10:00:00+00:00",
    )
    assert mutation == {
        "$inc": {"version": 1},
        "$max": {"last_activity_at": "2026-09-12T10:00:00+00:00"},
    }
    assert activity_update("2026-09-08T10:00:00Z")["$max"]["last_activity_at"].endswith(
        "+00:00"
    )


def test_reconstruction_uses_financial_activity_and_ignores_pending_settlements():
    reconstructed = reconstructed_activity_at(
        {"created_at": "2026-01-01T00:00:00Z"},
        expenses=[{"created_at": "2026-01-03T00:00:00Z"}],
        payments=[{"created_at": "2026-01-04T00:00:00Z"}],
        settlements=[
            {
                "status": "pending",
                "created_at": "2026-01-20T00:00:00Z",
                "paid_at": None,
            },
            {
                "status": "paid",
                "created_at": "2026-01-02T00:00:00Z",
                "paid_at": "2026-01-05T00:00:00Z",
            },
            {
                "status": "cancelled",
                "created_at": "2026-01-30T00:00:00Z",
                "paid_at": "2026-01-30T00:00:00Z",
            },
        ],
    )

    assert reconstructed == "2026-01-05T00:00:00+00:00"
    assert reconstructed_activity_at({"created_at": "2026-02-01T00:00:00Z"}) == (
        "2026-02-01T00:00:00+00:00"
    )


def test_backfill_is_idempotent_repairs_values_and_preserves_newer_activity():
    trips = MemoryCollection([
        {"id": "financial", "created_at": "2026-01-01T00:00:00Z"},
        {
            "id": "newer",
            "created_at": "2026-01-01T00:00:00Z",
            "last_activity_at": "2026-09-01T00:00:00+00:00",
        },
        {
            "id": "legacy",
            "created_at": "2026-01-02T00:00:00Z",
            "last_activity_at": "not-a-date",
        },
    ])
    database = SimpleNamespace(
        trips=trips,
        expenses=MemoryCollection([
            {"trip_id": "financial", "created_at": "2026-01-03T00:00:00Z"},
        ]),
        payments=MemoryCollection([
            {"trip_id": "financial", "created_at": "2026-01-04T00:00:00Z"},
        ]),
        settlements=MemoryCollection([
            {
                "trip_id": "financial", "status": "pending",
                "created_at": "2026-01-30T00:00:00Z", "paid_at": None,
            },
            {
                "trip_id": "financial", "status": "paid",
                "created_at": "2026-01-02T00:00:00Z",
                "paid_at": "2026-01-06T00:00:00Z",
            },
            {
                "trip_id": "financial", "status": "cancelled",
                "created_at": "2026-02-01T00:00:00Z",
                "paid_at": "2026-02-01T00:00:00Z",
            },
            {
                "trip_id": "legacy", "created_at": "2026-01-07T00:00:00Z",
            },
        ]),
    )

    assert run(backfill_trip_activity(database)) == 2
    by_id = {trip["id"]: trip for trip in trips.rows}
    assert by_id["financial"]["last_activity_at"] == "2026-01-06T00:00:00+00:00"
    assert by_id["newer"]["last_activity_at"] == "2026-09-01T00:00:00+00:00"
    assert by_id["legacy"]["last_activity_at"] == "2026-01-07T00:00:00+00:00"
    assert run(backfill_trip_activity(database)) == 0


def test_best_effort_touch_never_masks_a_committed_child_write(caplog):
    database = SimpleNamespace(
        trips=SimpleNamespace(update_one=AsyncMock(side_effect=RuntimeError("offline"))),
    )

    assert run(touch_trip_activity_safely(database, "t1")) is False
    assert "after a committed mutation" in caplog.text


def test_trip_creation_initializes_activity_and_list_is_scoped_and_deterministic(monkeypatch):
    trips = MemoryCollection()
    database = SimpleNamespace(trips=trips)
    monkeypatch.setattr(trip_routes, "db", database)
    monkeypatch.setattr(trip_routes, "record_money_normalizations", AsyncMock())
    monkeypatch.setattr(trip_routes, "record_admin_action", AsyncMock())
    monkeypatch.setattr(trip_routes, "gen_trip_code", lambda: "ABC123")

    created = run(trip_routes.create_trip(
        TripIn(name="First"),
        user={"id": "u1", "name": "Ada", "email": "ada@gmail.com"},
    ))
    assert created["last_activity_at"] == created["created_at"]
    assert datetime.fromisoformat(created["last_activity_at"]).tzinfo == timezone.utc
    trips.rows[0]["last_activity_at"] = "2026-07-01T00:00:00+00:00"

    trips.rows.extend([
        {
            "id": "b", "name": "B", "currency": "INR", "members": [],
            "user_ids": ["u1"], "created_at": "2026-01-01T00:00:00+00:00",
            "last_activity_at": "2026-08-01T00:00:00+00:00",
        },
        {
            "id": "c", "name": "C", "currency": "INR", "members": [],
            "user_ids": ["u1"], "created_at": "2026-01-01T00:00:00+00:00",
            "last_activity_at": "2026-08-01T00:00:00+00:00",
        },
        {
            "id": "private", "name": "Private", "currency": "INR", "members": [],
            "user_ids": ["u2"], "created_at": "2026-12-01T00:00:00+00:00",
            "last_activity_at": "2026-12-01T00:00:00+00:00",
        },
    ])

    listed = run(trip_routes.list_trips(user={"id": "u1"}))
    assert [trip["id"] for trip in listed] == ["c", "b", created["id"]]
    assert all("last_activity_at" in trip for trip in listed)


def test_expense_description_activity_requires_a_stored_change(monkeypatch):
    trip_collection = MemoryCollection([{
        "id": "t1", "last_activity_at": "2026-01-01T00:00:00+00:00",
    }])
    expense_collection = MemoryCollection([{
        "id": "e1", "trip_id": "t1", "amount": 10, "currency": "INR",
        "description": "Before", "date": "01-01-26", "category": "Food",
        "paid_by_member_id": "m1", "split_member_ids": ["m1"],
        "split_mode": "PER_CAPITA", "created_by": "u1",
    }])
    database = SimpleNamespace(trips=trip_collection, expenses=expense_collection)
    trip = {
        "id": "t1", "currency": "INR",
        "members": [{"id": "m1", "kind": "individual"}],
    }
    monkeypatch.setattr(expense_routes, "db", database)
    monkeypatch.setattr(
        expense_routes,
        "_expense_modify_or_403",
        AsyncMock(return_value=(trip, deepcopy(expense_collection.rows[0]))),
    )
    monkeypatch.setattr(expense_routes, "record_money_normalizations", AsyncMock())
    monkeypatch.setattr(expense_routes, "record_admin_action", AsyncMock())

    changed = run(expense_routes.update_expense(
        "t1", "e1", ExpenseUpdate(description="After"), user={"id": "u1"},
    ))
    first_activity = trip_collection.rows[0]["last_activity_at"]
    assert changed["description"] == "After"
    assert first_activity > "2026-01-01T00:00:00+00:00"

    monkeypatch.setattr(
        expense_routes,
        "_expense_modify_or_403",
        AsyncMock(return_value=(trip, deepcopy(expense_collection.rows[0]))),
    )
    unchanged = run(expense_routes.update_expense(
        "t1", "e1", ExpenseUpdate(description="After"), user={"id": "u1"},
    ))
    assert unchanged["description"] == "After"
    assert trip_collection.rows[0]["last_activity_at"] == first_activity


def test_direct_claim_is_activity_but_an_idempotent_reclaim_is_not(monkeypatch):
    trip = {
        "id": "t1", "user_ids": ["owner"],
        "members": [{
            "id": "m1", "kind": "individual", "email": "ada@gmail.com", "user_id": None,
        }],
    }
    joined = deepcopy(trip)
    joined["user_ids"].append("u1")
    joined["members"][0]["user_id"] = "u1"
    trips = SimpleNamespace(
        update_one=AsyncMock(return_value=SimpleNamespace(modified_count=1)),
        find_one=AsyncMock(return_value=joined),
    )
    monkeypatch.setattr(trip_routes, "db", SimpleNamespace(trips=trips))
    body = SimpleNamespace(member_id="m1", family_member_id=None)

    result = run(trip_routes._claim_member(
        trip, trip["members"], {"id": "u1"}, "ada@gmail.com", body,
    ))
    assert result == joined
    mutation = trips.update_one.await_args.args[1]
    assert mutation["$max"]["last_activity_at"].endswith("+00:00")

    trips.update_one.reset_mock()
    run(trip_routes._claim_member(
        joined, joined["members"], {"id": "u1"}, "ada@gmail.com", body,
    ))
    trips.update_one.assert_not_awaited()


def test_member_edit_write_carries_activity_and_repeated_values_skip_the_write(monkeypatch):
    update_one = AsyncMock(return_value=SimpleNamespace(modified_count=1))
    fake_db = SimpleNamespace(
        trips=SimpleNamespace(update_one=update_one),
        expenses=SimpleNamespace(),
    )
    import database as database_module

    monkeypatch.setattr(database_module, "db", fake_db)
    monkeypatch.setattr(reallocation, "_transactions_supported", AsyncMock(return_value=False))
    run(reallocation.run_member_update_with_reallocation(
        "t1", "m1", {"members.$.name": "After"}, 1, 1, True,
    ))
    mutation = update_one.await_args.args[1]
    assert mutation["$set"] == {"members.$.name": "After"}
    assert mutation["$max"]["last_activity_at"].endswith("+00:00")

    trip = {
        "id": "t1", "members": [{
            "id": "m1", "name": "After", "kind": "individual", "family_members": [],
        }],
    }
    route_db = SimpleNamespace(trips=SimpleNamespace(find_one=AsyncMock(return_value=trip)))
    monkeypatch.setattr(member_routes, "db", route_db)
    monkeypatch.setattr(member_routes, "_trip_admin_or_403", AsyncMock(return_value=trip))
    domain_write = AsyncMock()
    monkeypatch.setattr(member_routes, "run_member_update_with_reallocation", domain_write)
    monkeypatch.setattr(member_routes, "record_admin_action", AsyncMock())

    saved = run(member_routes.update_member(
        "t1", "m1", MemberUpdate(name="After"), user={"id": "owner"},
    ))
    assert saved["name"] == "After"
    domain_write.assert_not_awaited()


def test_pending_settlement_is_excluded_but_paid_transition_advances_activity(monkeypatch):
    trip = {
        "id": "t1", "currency": "INR", "version": 0,
        "members": [{"id": "a"}, {"id": "b"}],
        "last_activity_at": "2026-01-01T00:00:00+00:00",
    }
    trip_collection = MemoryCollection([trip])
    settlement_collection = MemoryCollection()
    database = SimpleNamespace(trips=trip_collection, settlements=settlement_collection)
    monkeypatch.setattr(balance_routes, "db", database)
    monkeypatch.setattr(balance_routes, "_trip_or_404", AsyncMock(return_value=trip))
    monkeypatch.setattr(balance_routes, "record_money_normalizations", AsyncMock())
    monkeypatch.setattr(balance_routes, "record_admin_action", AsyncMock())
    monkeypatch.setattr(balance_routes, "enqueue_notification_event", AsyncMock())

    pending = run(balance_routes.create_settlement(
        "t1", SettlementCreate(from_member_id="a", to_member_id="b", amount=10),
        user={"id": "u1"},
    ))
    assert trip_collection.rows[0]["last_activity_at"] == "2026-01-01T00:00:00+00:00"

    monkeypatch.setattr(
        balance_routes,
        "_settlement_mark_paid_or_403",
        AsyncMock(return_value=(trip, deepcopy(pending))),
    )

    async def standalone(_transactional, fallback):
        return await fallback()

    monkeypatch.setattr(balance_routes, "run_optional_transaction", standalone)
    paid = run(balance_routes.mark_settlement_paid(
        "t1", pending["id"], SettlementPatch(status="paid"), BackgroundTasks(),
        user={"id": "u1"},
    ))
    paid_activity = trip_collection.rows[0]["last_activity_at"]
    assert paid["status"] == "paid"
    assert paid_activity > "2026-01-01T00:00:00+00:00"

    monkeypatch.setattr(
        balance_routes,
        "_settlement_mark_paid_or_403",
        AsyncMock(return_value=(trip, deepcopy(paid))),
    )
    run(balance_routes.mark_settlement_paid(
        "t1", pending["id"], SettlementPatch(status="paid"), BackgroundTasks(),
        user={"id": "u1"},
    ))
    assert trip_collection.rows[0]["last_activity_at"] == paid_activity


def test_payment_note_edit_and_delete_touch_only_after_real_child_writes(monkeypatch):
    trip = {
        "id": "t1", "currency": "INR", "version": 4,
        "last_activity_at": "2026-01-01T00:00:00+00:00",
    }
    payment = {
        "id": "p1", "trip_id": "t1", "from_member_id": "a", "to_member_id": "b",
        "amount": 10, "note": "Before",
    }
    trips = MemoryCollection([trip])
    payments = MemoryCollection([payment])
    database = SimpleNamespace(trips=trips, payments=payments)
    monkeypatch.setattr(payment_routes, "db", database)
    monkeypatch.setattr(
        payment_routes, "_payment_or_403", AsyncMock(return_value=(trip, deepcopy(payment))),
    )
    monkeypatch.setattr(payment_routes, "record_money_normalizations", AsyncMock())
    monkeypatch.setattr(payment_routes, "record_admin_action", AsyncMock())

    edited = run(payment_routes.edit_payment(
        "t1", "p1", PaymentPatch(note="After"), user={"id": "u1"},
    ))
    edited_activity = trips.rows[0]["last_activity_at"]
    assert edited["note"] == "After"
    assert edited_activity > "2026-01-01T00:00:00+00:00"

    fresh_payment = deepcopy(payments.rows[0])
    monkeypatch.setattr(
        payment_routes, "_payment_or_403",
        AsyncMock(return_value=(deepcopy(trips.rows[0]), fresh_payment)),
    )
    run(payment_routes.edit_payment(
        "t1", "p1", PaymentPatch(note="After"), user={"id": "u1"},
    ))
    assert trips.rows[0]["last_activity_at"] == edited_activity

    async def standalone(_transactional, fallback):
        return await fallback()

    monkeypatch.setattr(payment_routes, "run_optional_transaction", standalone)
    run(payment_routes.delete_payment("t1", "p1", user={"id": "u1"}))
    assert payments.rows == []
    assert trips.rows[0]["version"] == 5
    assert trips.rows[0]["last_activity_at"] >= edited_activity


def test_transactional_payment_edit_touches_trip_only_after_child_changes(monkeypatch):
    trip = {
        "id": "t1", "currency": "INR", "version": 4,
        "members": [{"id": "a"}, {"id": "b"}],
    }
    payment = {
        "id": "p1", "trip_id": "t1", "from_member_id": "a", "to_member_id": "b",
        "amount": 10, "note": None,
    }
    trip_update = AsyncMock(return_value=SimpleNamespace(modified_count=1))
    payment_update = AsyncMock(return_value=SimpleNamespace(modified_count=0))
    database = SimpleNamespace(
        trips=SimpleNamespace(update_one=trip_update),
        payments=SimpleNamespace(update_one=payment_update),
    )
    monkeypatch.setattr(payment_routes, "db", database)
    monkeypatch.setattr(
        payment_routes, "_payment_or_403", AsyncMock(return_value=(trip, deepcopy(payment))),
    )
    monkeypatch.setattr(payment_routes, "_compute_balances", AsyncMock(return_value={
        "transfers": [{"from_member_id": "a", "to_member_id": "b", "amount": 10}],
    }))
    monkeypatch.setattr(payment_routes, "record_money_normalizations", AsyncMock())
    monkeypatch.setattr(payment_routes, "record_admin_action", AsyncMock())

    async def transactional(callback, _fallback):
        return await callback(object())

    monkeypatch.setattr(payment_routes, "run_optional_transaction", transactional)
    saved = run(payment_routes.edit_payment(
        "t1", "p1", PaymentPatch(amount=12), user={"id": "u1"},
    ))

    assert saved["amount"] == 10
    payment_update.assert_awaited_once()
    trip_update.assert_not_awaited()
