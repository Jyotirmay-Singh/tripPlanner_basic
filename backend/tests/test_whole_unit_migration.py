import asyncio
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from bson.decimal128 import Decimal128

from services import departure, whole_unit_migration as migration
from services.ledger_transactions import TransactionUnavailableError
from services.settlement_engine import SCALE, apply_migration_adjustments, build_precise_net
from utils import balances


class _Result:
    matched_count = 1


def _matches(document, query):
    for field, expected in query.items():
        actual = document.get(field)
        if isinstance(expected, dict):
            if "$in" in expected and actual not in expected["$in"]:
                return False
            if "$ne" in expected and actual == expected["$ne"]:
                return False
        elif actual != expected:
            return False
    return True


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    async def to_list(self, length=None):
        rows = self._rows if length is None else self._rows[:length]
        return deepcopy(rows)


class _Collection:
    def __init__(self, rows=()):
        self.rows = deepcopy(list(rows))
        self.mutations = []

    def find(self, query, projection, **_options):
        return _Cursor([row for row in self.rows if _matches(row, query)])

    async def find_one(self, query, projection=None, **_options):
        return next(
            (deepcopy(row) for row in self.rows if _matches(row, query)),
            None,
        )

    async def update_one(self, query, mutation, **options):
        row = next((row for row in self.rows if _matches(row, query)), None)
        if row is None:
            result = _Result()
            result.matched_count = 0
            return result
        for field, value in mutation.get("$set", {}).items():
            row[field] = deepcopy(value)
        for field in mutation.get("$unset", {}):
            row.pop(field, None)
        for field, value in mutation.get("$inc", {}).items():
            row[field] = row.get(field, 0) + value
        self.mutations.append(("update_one", deepcopy(query), deepcopy(mutation), options.get("session")))
        return _Result()

    async def replace_one(self, query, document, upsert=False, **options):
        index = next((i for i, row in enumerate(self.rows) if _matches(row, query)), None)
        if index is None:
            if not upsert:
                result = _Result()
                result.matched_count = 0
                return result
            self.rows.append(deepcopy(document))
        else:
            self.rows[index] = deepcopy(document)
        self.mutations.append(("replace_one", deepcopy(query), deepcopy(document), options.get("session")))
        return _Result()

    async def insert_one(self, document, **options):
        self.rows.append(deepcopy(document))
        self.mutations.append(("insert_one", deepcopy(document), options.get("session")))
        return _Result()

    async def delete_one(self, query, **options):
        self.rows = [row for row in self.rows if not _matches(row, query)]
        self.mutations.append(("delete_one", deepcopy(query), options.get("session")))
        return _Result()


class _Database:
    def __init__(self, *, trip, expenses=(), settlements=(), payments=(), attempts=()):
        self.trips = _Collection([trip])
        self.expenses = _Collection(expenses)
        self.settlements = _Collection(settlements)
        self.payments = _Collection(payments)
        self.payment_attempts = _Collection(attempts)
        self.money_migration_adjustments = _Collection()
        self.money_migration_audits = _Collection()

    @property
    def mutations(self):
        collections = (
            self.trips,
            self.expenses,
            self.settlements,
            self.payments,
            self.payment_attempts,
            self.money_migration_adjustments,
            self.money_migration_audits,
        )
        return [mutation for collection in collections for mutation in collection.mutations]


def _ledger_fixture():
    trip = {
        "id": "trip-1",
        "currency": "KWD",
        "budget": Decimal128("100.49"),
        "version": 7,
        "members": [
            {"id": "a", "name": "Ann", "kind": "individual"},
            {"id": "b", "name": "Bob", "kind": "individual"},
        ],
    }
    expenses = [
        {
            "id": "automatic",
            "trip_id": "trip-1",
            "amount": Decimal128("10.5"),
            "paid_by_member_id": "a",
            "split_member_ids": ["a", "b"],
            "split_mode": "PER_FAMILY",
            "conversion_history": [{
                "canonical_amount": Decimal128("10.5"),
                "rate": Decimal128("1.234567"),
            }],
        },
        {
            "id": "exact",
            "trip_id": "trip-1",
            "amount": Decimal128("3.5"),
            "original_amount": Decimal128("7.49"),
            "exchange_rate": Decimal128("0.467289719626"),
            "paid_by_member_id": "b",
            "split_member_ids": ["a", "b"],
            "split_mode": "EXACT",
            "custom_amounts": {
                "a": Decimal128("1.25"),
                "b": Decimal128("2.25"),
            },
            "original_custom_amounts": {
                "a": Decimal128("2.49"),
                "b": Decimal128("5.00"),
            },
            "conversion_history": [{
                "submitted_original_amount": Decimal128("7.49"),
                "canonical_amount": Decimal128("3.5"),
                "rate": Decimal128("0.467289719626"),
            }],
        },
    ]
    settlements = [{
        "id": "settlement",
        "trip_id": "trip-1",
        "from_member_id": "a",
        "to_member_id": "b",
        "amount": Decimal128("0.49"),
        "status": "paid",
    }]
    payments = [{
        "id": "payment",
        "trip_id": "trip-1",
        "from_member_id": "b",
        "to_member_id": "a",
        "amount": Decimal128("1.5"),
        "source": "upi_recipient_confirmed",
    }]
    attempts = [{
        "id": "terminal-attempt",
        "trip_id": "trip-1",
        "status": "settled_recipient_confirmed",
        "amount_paise": 149,
        "quote_rate_snapshot": "1.234567",
    }]
    return trip, expenses, settlements, payments, attempts


async def _transaction(callback):
    return await callback("test-session")


def _active_values(database):
    trip = database.trips.rows[0]
    values = [trip["budget"]]
    for expense in database.expenses.rows:
        values.append(expense["amount"])
        if expense.get("original_amount") is not None:
            values.append(expense["original_amount"])
        values.extend((expense.get("custom_amounts") or {}).values())
        values.extend((expense.get("original_custom_amounts") or {}).values())
    values.extend(row["amount"] for row in database.settlements.rows)
    values.extend(row["amount"] for row in database.payments.rows)
    return values


def test_dry_run_is_pure_allows_zero_rounding_and_builds_a_zero_sum_adjustment(monkeypatch):
    trip, expenses, settlements, payments, attempts = _ledger_fixture()
    database = _Database(
        trip=trip,
        expenses=expenses,
        settlements=settlements,
        payments=payments,
        attempts=attempts,
    )
    before = deepcopy(database.__dict__)
    monkeypatch.setattr(migration, "db", database)

    plan = asyncio.run(migration.dry_run_trip("trip-1"))

    assert plan.status == "ready"
    assert plan.target_net == {"a": 3, "b": -3}
    assert plan.post_rounding_net == {"a": 2, "b": -2}
    assert plan.adjustment_vector == {"a": 1, "b": -1}
    assert sum(plan.adjustment_vector.values()) == 0
    adjusted = apply_migration_adjustments(
        {member_id: value * SCALE for member_id, value in plan.post_rounding_net.items()},
        plan.adjustment_vector,
    )
    assert {member_id: value // SCALE for member_id, value in adjusted.items()} == plan.target_net
    assert database.mutations == []
    assert database.trips.rows == before["trips"].rows
    assert database.expenses.rows == before["expenses"].rows
    settlement_update = next(
        update for update in plan.updates if update.collection == "settlements"
    )
    assert settlement_update.fields["amount"] == 0
    public = plan.public()
    assert public["changes"]
    assert all(not isinstance(change.get("before"), Decimal128) for change in public["changes"])


def test_active_upi_attempt_blocks_without_planning_or_writes(monkeypatch):
    trip, expenses, settlements, payments, _attempts = _ledger_fixture()
    database = _Database(
        trip=trip,
        expenses=expenses,
        settlements=settlements,
        payments=payments,
        attempts=[{
            "id": "active",
            "trip_id": "trip-1",
            "status": "awaiting_confirmation",
        }],
    )
    monkeypatch.setattr(migration, "db", database)
    monkeypatch.setattr(migration, "run_required_transaction", _transaction)

    result = asyncio.run(migration.apply_trip_migration("trip-1"))

    assert result["status"] == "blocked"
    assert result["reason"] == "active_upi_attempt"
    assert database.mutations == []


def test_apply_revert_are_idempotent_and_preserve_immutable_evidence(monkeypatch):
    trip, expenses, settlements, payments, attempts = _ledger_fixture()
    database = _Database(
        trip=trip,
        expenses=expenses,
        settlements=settlements,
        payments=payments,
        attempts=attempts,
    )
    original = {
        "trip": deepcopy(database.trips.rows[0]),
        "expenses": deepcopy(database.expenses.rows),
        "settlements": deepcopy(database.settlements.rows),
        "payments": deepcopy(database.payments.rows),
        "attempts": deepcopy(database.payment_attempts.rows),
    }
    monkeypatch.setattr(migration, "db", database)
    monkeypatch.setattr(migration, "run_required_transaction", _transaction)

    applied = asyncio.run(migration.apply_trip_migration("trip-1"))

    assert applied["status"] == "applied"
    assert database.trips.rows[0]["money_policy_version"] == "whole_unit_v1"
    assert database.trips.rows[0]["version"] == 8
    assert all(isinstance(value, int) for value in _active_values(database))
    assert database.money_migration_adjustments.rows == [{
        "trip_id": "trip-1",
        "policy_version": "whole_unit_v1",
        "vector": {"a": 1, "b": -1},
        "created_at": database.money_migration_adjustments.rows[0]["created_at"],
    }]
    assert database.expenses.rows[0]["conversion_history"] == original["expenses"][0]["conversion_history"]
    assert database.expenses.rows[1]["conversion_history"] == original["expenses"][1]["conversion_history"]
    assert database.expenses.rows[1]["exchange_rate"] == original["expenses"][1]["exchange_rate"]
    assert database.payment_attempts.rows == original["attempts"]
    assert len(database.money_migration_audits.rows) == 1
    apply_audit = deepcopy(database.money_migration_audits.rows[0])
    assert any(isinstance(change.get("before"), Decimal128) for change in apply_audit["changes"])
    assert all(mutation[-1] == "test-session" for mutation in database.mutations)

    again = asyncio.run(migration.apply_trip_migration("trip-1"))
    assert again["status"] == "already_applied"
    assert len(database.money_migration_audits.rows) == 1

    reverted = asyncio.run(migration.revert_trip_migration("trip-1"))
    assert reverted["status"] == "reverted"
    assert database.trips.rows[0] == {**original["trip"], "version": 9}
    assert database.expenses.rows == original["expenses"]
    assert database.settlements.rows == original["settlements"]
    assert database.payments.rows == original["payments"]
    assert database.payment_attempts.rows == original["attempts"]
    assert database.money_migration_adjustments.rows == []
    assert database.money_migration_audits.rows[0] == apply_audit
    assert len(database.money_migration_audits.rows) == 2

    again = asyncio.run(migration.revert_trip_migration("trip-1"))
    assert again["status"] == "already_reverted"
    assert len(database.money_migration_audits.rows) == 2


def test_originally_settled_trip_remains_settled_after_rounding():
    trip = {
        "id": "settled",
        "currency": "USD",
        "members": [
            {"id": "a", "kind": "individual"},
            {"id": "b", "kind": "individual"},
        ],
    }
    expense = {
        "id": "expense",
        "trip_id": "settled",
        "amount": Decimal128("10.5"),
        "paid_by_member_id": "a",
        "split_member_ids": ["a", "b"],
        "split_mode": "PER_FAMILY",
    }
    payment = {
        "id": "payment",
        "trip_id": "settled",
        "from_member_id": "b",
        "to_member_id": "a",
        "amount": Decimal128("5.25"),
    }

    plan = migration.plan_trip_migration(trip, [expense], [], [payment])

    assert plan.target_net == {"a": 0, "b": 0}
    assert plan.post_rounding_net == {"a": 0, "b": 0}
    assert plan.adjustment_vector == {"a": 0, "b": 0}


def test_fractional_family_residual_is_settled_and_eligible_after_migration(monkeypatch):
    trip = {
        "id": "family-residual", "name": "South India", "currency": "INR",
        "owner_id": "other", "user_ids": ["user-1", "other"], "admin_ids": ["other"],
        "members": [
            {
                "id": "family-1", "kind": "family", "name": "JY",
                "family_members": ["R", "J"], "family_member_ids": ["person-1", "person-2"],
                "family_member_user_ids": ["user-1", None],
            },
            {"id": "other-1", "kind": "individual", "name": "Other", "user_id": "other"},
        ],
    }
    expense = {
        "id": "legacy-expense", "trip_id": trip["id"],
        "amount": Decimal128("0.873333333334"),
        "paid_by_member_id": "family-1", "split_member_ids": ["family-1", "other-1"],
        "split_mode": "PER_FAMILY",
    }
    precise_before = build_precise_net(trip["members"], [expense])
    assert precise_before["family-1"] == 436_666_666_667
    plan = migration.plan_trip_migration(trip, [expense], [], [])
    assert plan.target_net == {"family-1": 0, "other-1": 0}
    assert sum(plan.adjustment_vector.values()) == 0

    database = _Database(trip=trip, expenses=[expense])
    monkeypatch.setattr(migration, "db", database)
    monkeypatch.setattr(balances, "db", database)
    monkeypatch.setattr(migration, "run_required_transaction", _transaction)
    monkeypatch.setattr(departure, "_ownership_outcome", AsyncMock(return_value={
        "is_owner": False, "transfer_required": False,
        "successor": None, "requires_trip_deletion": False,
    }))
    monkeypatch.setattr(departure, "_active_attempt_flags", AsyncMock(return_value=(False, False)))

    applied = asyncio.run(migration.apply_trip_migration(trip["id"]))
    impact = asyncio.run(departure.membership_leave_impact(database.trips.rows[0], "user-1"))

    assert applied["status"] == "applied"
    assert database.expenses.rows[0]["amount"] == 1
    assert impact["position"] == "0"
    assert impact["family_position"] == "0"
    assert impact["settled"] is True
    assert impact["leave_eligible"] is True
    assert impact["blockers"] == []
    assert asyncio.run(migration.apply_trip_migration(trip["id"]))["status"] == "already_applied"
    assert len(database.money_migration_audits.rows) == 1


def test_apply_fails_closed_when_transactions_are_unavailable(monkeypatch):
    async def unavailable(_callback):
        raise TransactionUnavailableError("standalone")

    monkeypatch.setattr(migration, "run_required_transaction", unavailable)

    with pytest.raises(TransactionUnavailableError, match="standalone"):
        asyncio.run(migration.apply_trip_migration("trip-1"))
