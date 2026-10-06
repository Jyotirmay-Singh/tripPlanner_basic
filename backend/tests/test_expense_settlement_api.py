import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import expense_settlement, meta
from services.coverage_journal import run_snapshot_transaction
from services.ledger_transactions import TransactionUnavailableError
from services.ledger_snapshot import load_ledger
from utils import deps
from tests.test_expense_coverage import expense, ledger, trip


class Cursor:
    def __init__(self, rows, projection):
        self.rows = rows
        self.projection = projection

    async def to_list(self, length):
        assert length is None
        return [{key: deepcopy(value) for key, value in row.items() if self.projection.get(key, 1) != 0}
                for row in self.rows]


class Collection:
    def __init__(self, database, name, rows):
        self.database, self.name, self.rows = database, name, rows

    def matches(self, row, query):
        for key, expected in query.items():
            if isinstance(expected, dict) and "$ne" in expected:
                if row.get(key) == expected["$ne"]:
                    return False
            elif row.get(key) != expected:
                return False
        return True

    async def find_one(self, query, projection, **options):
        self.database.reads.append((self.name, options.get("session")))
        return next((deepcopy(row) for row in self.rows if self.matches(row, query)), None)

    def find(self, query, projection, **options):
        self.database.reads.append((self.name, options.get("session")))
        return Cursor([row for row in self.rows if self.matches(row, query)], projection)


class FakeDB:
    def __init__(self, data):
        self.reads = []
        for name, rows in {"trips": [data.trip], "expenses": data.expenses, "settlements": data.settlements,
                           "payments": data.payments, "money_migration_adjustments": [],
                           "expense_share_revisions": data.revisions, "expense_coverage_events": data.events,
                           "settlement_intents": data.intents, "payment_attempts": data.attempts}.items():
            setattr(self, name, Collection(self, name, rows))


def client_for(monkeypatch, data, *, viewer="u_b", enabled=True):
    database = FakeDB(data)
    monkeypatch.setattr(expense_settlement, "db", database)
    monkeypatch.setattr(deps, "db", database)
    monkeypatch.setattr(expense_settlement, "EXPENSE_SETTLEMENT_ENABLED", enabled)
    async def transaction(callback):
        return await callback("snapshot-session")
    monkeypatch.setattr(expense_settlement, "run_snapshot_transaction", transaction)
    app = FastAPI()
    app.include_router(expense_settlement.router, prefix="/api")
    app.include_router(meta.router, prefix="/api")
    if viewer:
        app.dependency_overrides[deps.get_current_user] = lambda: {"id": viewer}
    return TestClient(app), database


def active_data(count=1):
    data = ledger([expense(f"e{index}") for index in range(count)])
    data.trip["expense_settlement_activation_version"] = 1
    return data


def test_disabled_unactivated_returns_unavailable_counts_without_heavy_queries(monkeypatch):
    client, database = client_for(monkeypatch, ledger(), enabled=False)
    result = client.get("/api/trips/t/expense-settlement")
    assert result.status_code == 200
    payload = result.json()
    assert payload["availability"]["status"] == "disabled"
    assert payload["expenses"] is None and payload["snapshot_id"] is None
    assert len(database.reads) == 1


def test_enabled_flag_does_not_activate_group_and_new_routes_validate_contract(monkeypatch):
    client, _ = client_for(monkeypatch, ledger())
    assert client.get("/api/trips/t/expense-settlement").json()["availability"]["status"] == "not_activated"
    assert client.post("/api/trips/t/settlement-intents", json={}).status_code == 422
    config = client.get("/api/meta/config").json()
    assert config["expense_settlement_actions_ready"] is False
    assert config["expense_settlement_protocol_version"] == 2


@pytest.mark.parametrize("count", [1, 1101])
def test_summary_query_count_is_constant_and_full_ledger_has_no_1000_row_cap(monkeypatch, count):
    client, database = client_for(monkeypatch, active_data(count))
    result = client.get("/api/trips/t/expense-settlement")
    assert result.status_code == 200
    payload = result.json()
    assert payload["complete"] is True
    assert len(payload["expenses"]) == count
    assert payload["balances"]["a"] == str(count * 100)
    assert len(database.reads) == 10
    assert all(session == "snapshot-session" for _, session in database.reads[1:])


def test_batch_details_share_freshness_and_disabled_actions_preserve_active_history(monkeypatch):
    client, _ = client_for(monkeypatch, active_data(3), enabled=False)
    first = client.get("/api/trips/t/expense-settlement").json()
    result = client.get("/api/trips/t/expense-settlement", params=[
        ("detail_expense_id", "e0"), ("detail_expense_id", "e2"), ("expected_snapshot_id", first["snapshot_id"]),
    ])
    payload = result.json()
    assert result.status_code == 200
    assert set(payload["details"]) == {"e0", "e2"}
    assert len(payload["expenses"]) == 3
    assert payload["snapshot_id"] == first["snapshot_id"]
    assert payload["freshness"]["consistent"] is True
    assert payload["availability"]["new_starts_available"] is False
    row = payload["details"]["e0"]["participants"][0]
    assert row["remaining_amount"] == "100" and row["eligible_remaining_amount"] == "100"
    assert row["actionable_amount"] is None
    assert payload["generated_at"]


@pytest.mark.parametrize("change", ["expense", "cash", "pending", "membership", "journal"])
def test_content_freshness_detects_changes_without_trip_version_bump(monkeypatch, change):
    data = active_data()
    client, database = client_for(monkeypatch, data)
    initial = client.get("/api/trips/t/expense-settlement").json()
    if change == "expense":
        # An uncovered expense can be rederived; remove frozen history to represent preactivation
        # history rather than pretending an immutable revision was edited in place.
        database.expense_share_revisions.rows.clear()
        database.expenses.rows[0]["amount"] = 110
    elif change == "cash":
        database.payments.rows.append({"id": "p", "trip_id": "t", "amount": 10,
                                      "from_member_id": "b", "to_member_id": "a"})
    elif change == "pending":
        database.payment_attempts.rows.append({"id": "pending", "trip_id": "t", "status": "awaiting_confirmation"})
    elif change == "membership":
        database.trips.rows[0]["user_ids"].append("new-viewer")
    else:
        # A persisted revision is itself a new projection input, even with identical money.
        database.expense_share_revisions.rows.clear()
    changed = client.get("/api/trips/t/expense-settlement", params={"expected_snapshot_id": initial["snapshot_id"]})
    assert changed.status_code == 409
    assert changed.json()["detail"]["code"] == "coverage_snapshot_changed"
    assert database.trips.rows[0]["version"] == 0


def test_uncertain_history_and_pending_private_evidence_never_become_false_counts(monkeypatch):
    data = active_data()
    data.revisions.clear()
    data.expenses[0]["receipt_base64"] = "PRIVATE-RECEIPT"
    data.payments.append({"id": "p", "trip_id": "t", "amount": 40, "from_member_id": "b", "to_member_id": "a",
                          "note": "PRIVATE-NOTE", "upi_id": "PRIVATE-UPI", "external_reference": "PRIVATE-REFERENCE"})
    data.attempts.append({"id": "attempt", "trip_id": "t", "status": "awaiting_confirmation", "upi_id": "PRIVATE-UPI",
                          "external_reference": "PRIVATE-REFERENCE"})
    client, _ = client_for(monkeypatch, data)
    response = client.get("/api/trips/t/expense-settlement", params={"detail_expense_id": "e0"})
    assert response.status_code == 200
    assert "PRIVATE-" not in response.text
    payload = response.json()
    assert payload["expenses"][0]["settled_count"] is None
    assert payload["details"]["e0"]["participants"][0]["remaining_amount"] is None
    assert payload["uncertainty"]["present"] is True


def test_detail_validation_and_authentication(monkeypatch):
    client, _ = client_for(monkeypatch, active_data())
    assert client.get("/api/trips/t/expense-settlement", params=[("detail_expense_id", str(index)) for index in range(101)]).status_code == 422
    assert client.get("/api/trips/t/expense-settlement", params={"detail_expense_id": "absent"}).status_code == 404
    outsider, _ = client_for(monkeypatch, active_data(), viewer="outsider")
    assert outsider.get("/api/trips/t/expense-settlement").status_code == 403
    anonymous, _ = client_for(monkeypatch, active_data(), viewer=None)
    assert anonymous.get("/api/trips/t/expense-settlement").status_code == 401


def test_membership_is_rechecked_inside_snapshot(monkeypatch):
    client, database = client_for(monkeypatch, active_data())
    async def revoke(callback):
        database.trips.rows[0]["user_ids"].remove("u_b")
        return await callback("snapshot-session")
    monkeypatch.setattr(expense_settlement, "run_snapshot_transaction", revoke)
    assert client.get("/api/trips/t/expense-settlement").status_code == 403


def test_transaction_and_ledger_failures_expose_unavailable_not_zero(monkeypatch):
    client, database = client_for(monkeypatch, active_data())
    async def unavailable(_callback):
        raise TransactionUnavailableError()
    monkeypatch.setattr(expense_settlement, "run_snapshot_transaction", unavailable)
    payload = client.get("/api/trips/t/expense-settlement").json()
    assert payload["availability"]["status"] == "unavailable" and payload["expenses"] is None
    async def transaction(callback):
        return await callback("snapshot-session")
    monkeypatch.setattr(expense_settlement, "run_snapshot_transaction", transaction)
    database.expenses.rows[0]["amount"] = 200
    payload = client.get("/api/trips/t/expense-settlement").json()
    assert payload["availability"]["status"] == "review_required"
    assert payload["expenses"] is None


def test_money_loader_projects_receipt_bytes_out(monkeypatch):
    data = active_data()
    data.expenses[0]["receipt_base64"] = "PRIVATE-RECEIPT"
    fake = FakeDB(data)
    loaded = asyncio.run(load_ledger("t", fake, coverage=True, session="snapshot-session"))
    assert "receipt_base64" not in loaded.expenses[0]


@pytest.mark.parametrize("record", ["event", "revision", "cash"])
def test_malformed_stored_record_returns_structured_unavailability(monkeypatch, record):
    data = active_data()
    if record == "event":
        data.events.append({"id": "broken", "trip_id": "t", "policy_version": "expense_coverage_v1", "status": "applied"})
    elif record == "revision":
        data.revisions[0].pop("entity_shares")
    else:
        data.payments.append({"id": "broken", "trip_id": "t", "amount": "10", "to_member_id": "a"})
    client, _ = client_for(monkeypatch, data)
    result = client.get("/api/trips/t/expense-settlement")
    assert result.status_code == 200
    payload = result.json()
    assert payload["availability"]["status"] == "review_required"
    assert payload["uncertainty"]["reasons"] == ["invalid_share_revision" if record == "revision" else "invalid_coverage_record"]
    assert payload["expenses"] is None and payload["snapshot_id"] is None


def test_current_allocation_references_and_people_change_snapshot_without_cash_amount_edit(monkeypatch):
    data = active_data()
    data.payments.append({"id": "p", "amount": 10, "trip_id": "t", "from_member_id": "b",
                          "to_member_id": "a", "created_at": "2026-10-02T00:00:00+00:00"})
    client, database = client_for(monkeypatch, data)
    first = client.get("/api/trips/t/expense-settlement").json()
    database.payments.rows[0]["actual_payer_person_id"] = "b"
    changed = client.get("/api/trips/t/expense-settlement", params={"expected_snapshot_id": first["snapshot_id"]})
    assert changed.status_code == 409


def test_private_payment_reference_is_not_loaded_for_the_coverage_projection(monkeypatch):
    data = active_data()
    data.payments.append({"id": "p", "amount": 10, "trip_id": "t", "from_member_id": "b", "to_member_id": "a",
                          "transaction_reference": "PRIVATE-BANK-REFERENCE", "upi_id": "PRIVATE-UPI"})
    data.attempts.append({"id": "attempt", "trip_id": "t", "status": "reported", "transaction_reference": "PRIVATE-REF"})
    loaded = asyncio.run(load_ledger("t", FakeDB(data), coverage=True, session="snapshot-session"))
    assert "transaction_reference" not in loaded.payments[0]
    assert "upi_id" not in loaded.payments[0]
    assert "transaction_reference" not in loaded.attempts[0]
