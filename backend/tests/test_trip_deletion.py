"""Group deletion checks use current settlement state and current ownership."""

import asyncio
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from config import SUPER_ADMIN_EMAIL
from models.financial_correction import CorrectionPreview
from routes import trips
from services import financial_corrections
from services.coverage_allocations import plan_direct_allocations
from services.expense_coverage import build_coverage_snapshot
from services.ledger_snapshot import LedgerSnapshot
from services.trip_deletion import require_trip_deletion_allowed
from tests.test_expense_coverage import applied, expense, ledger, share, trip
from tests.test_financial_corrections import planned, version_two
from utils.common import now_utc


OWNER = {"id": "admin"}
APPLICATION_ADMIN = {"id": "application-admin", "email": SUPER_ADMIN_EMAIL, "role": "super_admin"}


def deletion_ledger(settled):
    group = trip()
    group["admin_ids"].append("group-admin")
    group["user_ids"].append("group-admin")
    return LedgerSnapshot(group, [] if settled else [expense()])


def covered_ledger():
    initial = build_coverage_snapshot(ledger())
    covered = applied(initial, plan_direct_allocations(
        initial, [{"share_id": share(initial)["id"], "amount": "100"}],
    ))
    return version_two(covered.ledger)


@pytest.mark.parametrize("settled,viewer,status", [
    (True, OWNER, None),
    (False, OWNER, 409),
    (True, APPLICATION_ADMIN, 403),
    (False, APPLICATION_ADMIN, None),
    (True, {"id": "group-admin"}, 403),
    (False, {"id": "group-admin"}, 403),
    (True, {"id": "u_b"}, 403),
    (False, {"id": "u_b"}, 403),
    (True, {"id": "stranger"}, 403),
    (False, {"id": "stranger"}, 403),
    (False, {"id": "admin", "is_super_admin": True}, 409),
    (False, {"id": "admin", "role": "super_admin", "email": "other@gmail.com"}, 409),
])
def test_deletion_permission_matrix(settled, viewer, status):
    data = deletion_ledger(settled)
    before = deepcopy(data)
    if status is None:
        require_trip_deletion_allowed(data, viewer)
    else:
        with pytest.raises(HTTPException) as error:
            require_trip_deletion_allowed(data, viewer)
        assert error.value.status_code == status
    assert data == before


@pytest.mark.parametrize("settled", [True, False])
def test_application_admin_can_delete_their_own_group(settled):
    data = deletion_ledger(settled)
    data.trip["owner_id"] = APPLICATION_ADMIN["id"]
    require_trip_deletion_allowed(data, APPLICATION_ADMIN)


def test_rounded_zero_with_exact_outstanding_money_is_unsettled():
    data = deletion_ledger(False)
    data.expenses[0]["amount"] = "0.25"
    with pytest.raises(HTTPException) as error:
        require_trip_deletion_allowed(data, OWNER)
    assert error.value.status_code == 409
    require_trip_deletion_allowed(data, APPLICATION_ADMIN)


@pytest.mark.parametrize("payment_kind", ["payments", "settlements"])
def test_recorded_payment_can_fully_settle_the_group(payment_kind):
    data = deletion_ledger(False)
    getattr(data, payment_kind).append({
        "id": "paid", "amount": 100, "from_member_id": "b", "to_member_id": "a", "status": "paid",
    })
    require_trip_deletion_allowed(data, OWNER)
    with pytest.raises(HTTPException) as error:
        require_trip_deletion_allowed(data, APPLICATION_ADMIN)
    assert error.value.status_code == 403


@pytest.mark.parametrize("collection,row", [
    ("attempts", {"id": "pending", "status": "awaiting_confirmation"}),
    ("attempts", {"id": "sent", "status": "expired", "sender_reported_by": "u_b"}),
    ("settlements", {"id": "pending", "status": "pending", "amount": 100}),
])
def test_legacy_pending_payment_keeps_group_unsettled(collection, row):
    data = deletion_ledger(True)
    getattr(data, collection).append({**row, "from_member_id": "b", "to_member_id": "a"})
    with pytest.raises(HTTPException) as error:
        require_trip_deletion_allowed(data, OWNER)
    assert error.value.status_code == 409
    require_trip_deletion_allowed(data, APPLICATION_ADMIN)


def test_direct_debt_cycle_is_unsettled_despite_zero_net_balances():
    data = deletion_ledger(False)
    data.trip["simplify_debts"] = False
    data.expenses = [
        expense(), expense("second", 100, "b", ("c",)), expense("third", 100, "c", ("a",)),
    ]
    with pytest.raises(HTTPException) as error:
        require_trip_deletion_allowed(data, OWNER)
    assert error.value.status_code == 409
    require_trip_deletion_allowed(data, APPLICATION_ADMIN)


def test_reviewed_group_with_open_shares_is_unsettled_despite_zero_net():
    data = version_two(ledger([expense(), expense("reverse", 100, "b", ("a",))]))
    with pytest.raises(HTTPException) as error:
        require_trip_deletion_allowed(data, OWNER)
    assert error.value.status_code == 409
    require_trip_deletion_allowed(data, APPLICATION_ADMIN)


def test_reviewed_settled_group_can_be_archived_by_its_owner():
    data = covered_ledger()
    proposal = planned(data, "archive_trip", data.trip["id"])
    assert proposal["event"]["trip_change"]["after"]["archived_at"]


def test_pending_payment_report_keeps_reviewed_group_unsettled():
    data = covered_ledger()
    data.attempts.append({
        "id": "pending", "status": "awaiting_confirmation", "from_member_id": "b", "to_member_id": "a",
    })
    with pytest.raises(HTTPException) as error:
        require_trip_deletion_allowed(data, OWNER)
    assert error.value.status_code == 409
    require_trip_deletion_allowed(data, APPLICATION_ADMIN)


def test_reviewed_archive_preview_rejects_unsettled_owner():
    data = version_two(ledger())
    with pytest.raises(HTTPException) as error:
        planned(data, "archive_trip", data.trip["id"])
    assert error.value.status_code == 409


@pytest.mark.parametrize("settled,status", [(False, None), (True, 403)])
def test_reviewed_archive_preview_checks_application_admin(settled, status):
    data = covered_ledger() if settled else version_two(ledger())
    current = build_coverage_snapshot(data, infer_history=False)
    body = CorrectionPreview(expected_snapshot_id=current.snapshot_id, operation="archive_trip",
        target_id=data.trip["id"], changes={}, reason="Remove the group after administrator review")
    operation = financial_corrections.plan(
        data.trip, APPLICATION_ADMIN, data, body, "deletion", now_utc().isoformat(),
    )
    if status is None:
        assert asyncio.run(operation)["event"]["trip_change"]
    else:
        with pytest.raises(HTTPException) as error:
            asyncio.run(operation)
        assert error.value.status_code == status


@pytest.mark.parametrize("settled,viewer,status", [
    (False, OWNER, 409),
    (True, APPLICATION_ADMIN, 403),
    (True, {"id": "u_b"}, 403),
])
def test_reviewed_archive_application_rechecks_current_authority(monkeypatch, settled, viewer, status):
    data = covered_ledger() if settled else version_two(ledger())
    monkeypatch.setattr(financial_corrections, "load_ledger", AsyncMock(return_value=data))
    database = MagicMock()
    monkeypatch.setattr(financial_corrections, "db", database)
    correction = {
        "operation": "archive_trip", "plan": {"basis_hash": financial_corrections.basis(data)},
        "expires_at": (now_utc() + timedelta(minutes=1)).isoformat(),
    }
    with pytest.raises(HTTPException) as error:
        asyncio.run(financial_corrections.apply(data.trip, viewer, correction, None))
    assert error.value.status_code == status
    assert database.mock_calls == []


@pytest.mark.parametrize("settled,viewer,deleted_count,status", [
    (False, OWNER, 1, 409),
    (True, APPLICATION_ADMIN, 1, 403),
    (True, OWNER, 0, 409),
])
def test_rejected_deletion_performs_no_cleanup(monkeypatch, settled, viewer, deleted_count, status):
    data = deletion_ledger(settled)
    database = MagicMock()
    database.trips.delete_one = AsyncMock(return_value=SimpleNamespace(deleted_count=deleted_count))
    monkeypatch.setattr(trips, "db", database)
    monkeypatch.setattr(trips, "_trip_owner_or_403", AsyncMock(return_value=data.trip))
    monkeypatch.setattr(trips, "load_ledger", AsyncMock(return_value=data))
    revoke = AsyncMock()
    receipts = AsyncMock()
    monkeypatch.setattr(trips, "revoke_trip_invites", revoke)
    monkeypatch.setattr(trips, "delete_receipts_for_trip", receipts)

    with pytest.raises(HTTPException) as error:
        asyncio.run(trips.delete_trip(data.trip["id"], user=viewer))
    assert error.value.status_code == status
    revoke.assert_not_awaited()
    receipts.assert_not_awaited()
    if settled and viewer == OWNER:
        database.trips.delete_one.assert_awaited_once()
        assert len(database.mock_calls) == 1
    else:
        assert database.mock_calls == []


@pytest.mark.parametrize("settled,viewer", [(True, OWNER), (False, APPLICATION_ADMIN)])
@pytest.mark.parametrize("session", [None, "deletion-session"])
def test_permitted_deletion_checks_snapshot_and_cleans_group(monkeypatch, settled, viewer, session):
    data = deletion_ledger(settled)
    data.trip["version"] = 7
    names = (
        "expenses", "settlements", "payments", "payment_attempts", "join_requests",
        "notification_outbox", "chat_messages", "chat_reads", "chat_counters",
    )
    collections = {name: SimpleNamespace(delete_many=AsyncMock()) for name in names}
    collections["trips"] = SimpleNamespace(delete_one=AsyncMock(
        return_value=SimpleNamespace(deleted_count=1),
    ))
    monkeypatch.setattr(trips, "db", SimpleNamespace(**collections))
    monkeypatch.setattr(trips, "_trip_owner_or_403", AsyncMock(return_value=data.trip))
    loader = AsyncMock(return_value=data)
    monkeypatch.setattr(trips, "load_ledger", loader)

    async def transaction(callback, fallback):
        return await callback(session) if session is not None else await fallback()

    monkeypatch.setattr(trips, "run_optional_transaction", transaction)
    for name in ("revoke_trip_invites", "delete_receipts_for_trip", "release_trip_claims", "record_admin_action"):
        monkeypatch.setattr(trips, name, AsyncMock())
    monkeypatch.setattr(trips, "chat_connections", SimpleNamespace(disconnect_trip=AsyncMock()))

    assert asyncio.run(trips.delete_trip(data.trip["id"], user=viewer)) == {"ok": True}
    loader.assert_awaited_once_with(data.trip["id"], trips.db, session=session, coverage=True)
    options = {"session": session} if session is not None else {}
    collections["trips"].delete_one.assert_awaited_once_with({
        "id": data.trip["id"], "owner_id": data.trip["owner_id"], "version": 7,
    }, **options)
    for name in names:
        collections[name].delete_many.assert_awaited_once_with({"trip_id": data.trip["id"]}, **options)
    trips.revoke_trip_invites.assert_awaited_once_with(data.trip["id"], viewer["id"])
    trips.delete_receipts_for_trip.assert_awaited_once_with(data.trip["id"])
    trips.release_trip_claims.assert_awaited_once_with(data.trip["id"])
    trips.chat_connections.disconnect_trip.assert_awaited_once_with(data.trip["id"])
