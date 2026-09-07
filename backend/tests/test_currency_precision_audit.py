import asyncio

from bson.decimal128 import Decimal128

from scripts.audit_currency_precision import build_parser
from services.currency_precision_audit import audit_database, audit_currency_precision


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, length=None):
        return list(self.rows)


class FakeCollection:
    def __init__(self, rows):
        self.rows = rows
        self.reads = 0

    def find(self, query, projection):
        assert query == {}
        assert projection == {"_id": 0}
        self.reads += 1
        return FakeCursor(self.rows)


class FakeDatabase:
    def __init__(self, *, trips=(), expenses=(), settlements=(), payments=()):
        self.trips = FakeCollection(trips)
        self.expenses = FakeCollection(expenses)
        self.settlements = FakeCollection(settlements)
        self.payments = FakeCollection(payments)


def test_audit_cli_accepts_explicit_dry_run_mode():
    assert build_parser().parse_args(["--dry-run"]).dry_run is True


def test_clean_zero_two_and_three_decimal_documents_pass():
    violations = audit_currency_precision(
        trips=[
            {"id": "jpy", "currency": "JPY", "budget": 1000},
            {"id": "usd", "currency": "USD", "budget": 10.25},
            {"id": "kwd", "currency": "KWD", "budget": Decimal128("1.234")},
        ],
        expenses=[
            {
                "id": "e1", "trip_id": "kwd", "currency": "KWD", "amount": 1.234,
                "original_currency": "JPY", "original_amount": Decimal128("150"),
                "custom_amounts": {"a": 0.617, "b": 0.617},
                "original_custom_amounts": {
                    "a": Decimal128("75"), "b": Decimal128("75")
                },
            },
        ],
        settlements=[{"id": "s1", "trip_id": "jpy", "amount": 10}],
        payments=[{"id": "p1", "trip_id": "usd", "amount": 2.50}],
    )
    assert violations == []


def test_every_persisted_money_location_is_reported_without_mutation():
    database = FakeDatabase(
        trips=[{"id": "jpy", "currency": "JPY", "budget": 100.5}],
        expenses=[{
            "id": "e1", "trip_id": "jpy", "currency": "JPY", "amount": 10.1,
            "original_currency": "USD", "original_amount": Decimal128("5.001"),
            "custom_amounts": {"a": 10.1},
            "original_custom_amounts": {"a": Decimal128("5.001")},
        }],
        settlements=[{"id": "s1", "trip_id": "jpy", "amount": 1.5}],
        payments=[{"id": "p1", "trip_id": "jpy", "amount": 2.25}],
    )

    violations = asyncio.run(audit_database(database))

    assert {(row["record_type"], row["field"]) for row in violations} == {
        ("trip", "budget"),
        ("expense", "amount"),
        ("expense", "original_amount"),
        ("expense", "custom_amounts.a"),
        ("expense", "original_custom_amounts.a"),
        ("settlement", "amount"),
        ("payment", "amount"),
    }
    assert all(row["reason"] == "excess_precision" for row in violations)
    assert all(row["allowed_digits"] in (0, 2) for row in violations)
    assert database.trips.reads == database.expenses.reads == 1
    assert database.settlements.reads == database.payments.reads == 1


def test_trip_currency_is_audited_even_when_the_budget_is_empty():
    violations = audit_currency_precision(
        trips=[{"id": "bad", "currency": "XYZ", "budget": None}],
        expenses=[],
        settlements=[],
        payments=[],
    )
    assert violations == [{
        "record_type": "trip",
        "record_id": "bad",
        "trip_id": "bad",
        "field": "currency",
        "currency": "XYZ",
        "value": "XYZ",
        "allowed_digits": None,
        "reason": "unsupported_currency",
    }]
