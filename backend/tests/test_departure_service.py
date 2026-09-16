import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from pymongo.errors import PyMongoError

from models.departure import AccountDeletionIn
from routes import expenses as expense_routes
from services import departure
from services.ledger_transactions import TransactionUnavailableError
from services.settlement_engine import SettlementLedgerError, build_precise_net


def run(awaitable):
    return asyncio.run(awaitable)


class Cursor:
    def __init__(self, rows):
        self.rows = list(rows)

    async def to_list(self, length=None):
        return list(self.rows)


class FindCollection:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.queries = []

    def find(self, query, *_args, **_kwargs):
        self.queries.append(query)
        return Cursor(self.rows)


class MappingDatabase(SimpleNamespace):
    def __getitem__(self, name):
        return getattr(self, name.replace(".", "_"))


def individual_trip(*, owner="other"):
    return {
        "id": "trip-1",
        "name": "Coast",
        "currency": "INR",
        "owner_id": owner,
        "admin_ids": [owner],
        "user_ids": ["user-1", owner],
        "members": [
            {
                "id": "member-1", "name": "Ada", "kind": "individual",
                "email": "ada@gmail.com", "user_id": "user-1",
            },
            {
                "id": "member-2", "name": "Ben", "kind": "individual",
                "email": "ben@gmail.com", "user_id": owner,
            },
        ],
    }


def family_trip(names=("Ada", "Bea"), linked=("user-1", None), *, owner="other"):
    return {
        "id": "trip-family",
        "name": "Family holiday",
        "currency": "LKR",
        "owner_id": owner,
        "admin_ids": [owner],
        "user_ids": [value for value in ("user-1", owner, *linked) if value],
        "members": [
            {
                "id": "family-1", "name": "Shah family", "kind": "family",
                "family_members": list(names),
                "family_member_ids": [f"person-{index + 1}" for index in range(len(names))],
                "family_member_emails": ["ada@gmail.com", *([None] * (len(names) - 1))],
                "family_member_user_ids": list(linked),
                "family_member_mobile_numbers": ["+919999999999", *([None] * (len(names) - 1))],
                "email": None, "user_id": None,
            },
            {
                "id": "member-2", "name": "Ben", "kind": "individual",
                "email": "ben@gmail.com", "user_id": owner,
            },
        ],
    }


def ownership_ok():
    return {
        "is_owner": False,
        "transfer_required": False,
        "successor": None,
        "requires_trip_deletion": False,
    }


def test_identity_resolution_requires_one_exact_person_slot():
    trip = family_trip()
    identity = departure.resolve_linked_identity(trip, "user-1")
    assert identity["identity_type"] == "family_member"
    assert identity["family_member_id"] == "person-1"

    trip["members"].append({
        "id": "duplicate", "name": "Duplicate", "kind": "individual",
        "user_id": "user-1",
    })
    assert departure.resolve_linked_identity(trip, "user-1") is None


def test_linked_trip_query_includes_access_and_role_references():
    conditions = departure._linked_trip_query("user-1")["$or"]

    assert {"user_ids": "user-1"} in conditions
    assert {"owner_id": "user-1"} in conditions
    assert {"admin_ids": "user-1"} in conditions
    assert {"members.user_id": "user-1"} in conditions
    assert {"members.family_member_user_ids": "user-1"} in conditions


def test_owner_successor_prefers_live_admin_order_over_roster_order(monkeypatch):
    trip = {
        "id": "trip-1", "owner_id": "departing",
        "admin_ids": ["departing", "admin-user"],
        "user_ids": ["departing", "roster-user", "admin-user"],
        "members": [
            {"id": "a", "kind": "individual", "name": "Departing", "user_id": "departing"},
            {"id": "r", "kind": "individual", "name": "Roster first", "user_id": "roster-user"},
            {"id": "b", "kind": "individual", "name": "Admin second", "user_id": "admin-user"},
        ],
    }
    users = FindCollection([{"id": "roster-user"}, {"id": "admin-user"}])
    monkeypatch.setattr(departure, "db", SimpleNamespace(users=users))

    outcome = run(departure._ownership_outcome(trip, "departing"))

    assert outcome["successor"] == {"user_id": "admin-user", "name": "Admin second"}


def test_precise_residual_blocks_individual_departure(monkeypatch):
    monkeypatch.setattr(departure, "_ownership_outcome", AsyncMock(return_value=ownership_ok()))
    monkeypatch.setattr(departure, "_active_attempt_flags", AsyncMock(return_value=(False, False)))
    monkeypatch.setattr(departure, "_compute_balances", AsyncMock(return_value={
        "net": {"member-1": 0},
        "settlement_projection": {"precise_net": {"member-1": "0.000000000001"}},
        "per_person": [],
    }))

    result = run(departure.evaluate_trip(individual_trip(), "user-1"))["public"]

    assert result["position"] == "0.000000000001"
    assert result["settled"] is False
    assert result["leave_eligible"] is False
    assert {blocker["code"] for blocker in result["blockers"]} == {"membership_unsettled"}


def test_family_requires_zero_entity_and_every_member_row(monkeypatch):
    monkeypatch.setattr(departure, "_ownership_outcome", AsyncMock(return_value=ownership_ok()))
    monkeypatch.setattr(departure, "_active_attempt_flags", AsyncMock(return_value=(False, False)))
    balances = {
        "net": {"family-1": 0},
        "settlement_projection": {"precise_net": {"family-1": "0.000000000000"}},
        "per_person": [{
            "member_id": "family-1",
            "members": [
                {"id": "person-1", "name": "Ada", "net": 1},
                {"id": "person-2", "name": "Bea", "net": -1},
            ],
        }],
    }
    compute = AsyncMock(return_value=balances)
    monkeypatch.setattr(departure, "_compute_balances", compute)

    unsettled = run(departure.evaluate_trip(family_trip(), "user-1"))["public"]
    assert unsettled["family_position"] == "0.000000000000"
    assert unsettled["settled"] is False
    assert [row["id"] for row in unsettled["unsettled_family_members"]] == [
        "person-1", "person-2",
    ]

    balances["per_person"][0]["members"][0]["net"] = 0
    balances["per_person"][0]["members"][1]["net"] = 0
    settled = run(departure.evaluate_trip(family_trip(), "user-1"))["public"]
    assert settled["settled"] is True
    assert settled["leave_eligible"] is True
    assert settled["dissolve_family_eligible"] is True


def test_family_choices_cover_other_linked_user_and_only_person(monkeypatch):
    monkeypatch.setattr(departure, "_ownership_outcome", AsyncMock(return_value=ownership_ok()))
    monkeypatch.setattr(departure, "_active_attempt_flags", AsyncMock(return_value=(False, False)))
    monkeypatch.setattr(departure, "_compute_balances", AsyncMock(return_value={
        "net": {"family-1": 0},
        "settlement_projection": {"precise_net": {"family-1": "0.000000000000"}},
        "per_person": [{"member_id": "family-1", "members": [
            {"id": "person-1", "name": "Ada", "net": 0},
            {"id": "person-2", "name": "Bea", "net": 0},
        ]}],
    }))

    shared = run(departure.evaluate_trip(
        family_trip(linked=("user-1", "user-2")), "user-1",
    ))["public"]
    assert shared["leave_eligible"] is True
    assert shared["dissolve_family_eligible"] is False
    assert any(row["code"] == "family_dissolution_rejected" for row in shared["blockers"])

    departure._compute_balances.return_value["per_person"][0]["members"] = [
        {"id": "person-1", "name": "Ada", "net": 0},
    ]
    only = run(departure.evaluate_trip(
        family_trip(names=("Ada",), linked=("user-1",)), "user-1",
    ))["public"]
    assert only["requires_family_dissolution"] is True
    assert only["leave_eligible"] is False
    assert only["dissolve_family_eligible"] is True


def test_global_active_attempt_check_ignores_expired_and_terminal_rows(monkeypatch):
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    attempts = FindCollection([
        {"trip_id": "live", "status": "initiated", "expires_at": future,
         "sender_reported_by": "user-1"},
        {"trip_id": "expired", "status": "needs_review", "expires_at": past,
         "sender_reported_by": "user-1"},
        {"trip_id": "terminal", "status": "canceled", "expires_at": future,
         "sender_reported_by": "user-1"},
    ])
    monkeypatch.setattr(departure, "db", SimpleNamespace(payment_attempts=attempts))

    rows = run(departure._active_account_attempts("user-1"))

    assert [row["trip_id"] for row in rows] == ["live"]
    assert {next(iter(condition)) for condition in attempts.queries[0]["$or"]} \
        == set(departure.ACCOUNT_REFERENCE_FIELDS)


def test_deletion_impact_blocks_identity_only_active_attempt(monkeypatch):
    trip = individual_trip()
    evaluation = {
        "trip": trip,
        "identity": departure.resolve_linked_identity(trip, "user-1"),
        "active_user_attempt": True,
        "public": {
            "trip_id": trip["id"],
            "trip_name": trip["name"],
            "ownership": ownership_ok(),
        },
    }
    monkeypatch.setattr(departure, "_linked_trips", AsyncMock(return_value=[trip]))
    monkeypatch.setattr(departure, "evaluate_trip", AsyncMock(return_value=evaluation))
    # Simulate a legacy attempt that has only the member reference, not a copied account field.
    monkeypatch.setattr(departure, "_active_account_attempts", AsyncMock(return_value=[]))

    impact = run(departure.account_deletion_impact({
        "id": "user-1", "email": "ada@gmail.com", "role": "user",
    }))

    assert impact["account_deletion_allowed"] is False
    assert [row["code"] for row in impact["blockers"]] == ["active_payment_attempt"]
    assert "Coast" in impact["blockers"][0]["message"]


def test_family_person_departure_removes_only_aligned_slot_and_freezes_history(monkeypatch):
    snapshot = AsyncMock()
    snapshot_roster = AsyncMock()
    reallocate = AsyncMock()
    monkeypatch.setattr(departure, "_snapshot_exact_family_people", snapshot)
    monkeypatch.setattr(departure, "_snapshot_implicit_split_roster", snapshot_roster)
    monkeypatch.setattr(departure, "_apply_reallocation", reallocate)
    trip = family_trip()
    trip["members"][0].update({
        "email": "legacy@gmail.com",
        "user_id": "legacy-user",
        "mobile_number": "+918888888888",
    })
    identity = departure.resolve_linked_identity(trip, "user-1")

    members = run(departure._departure_members(trip, identity, "leave", session="session"))

    family = members[0]
    assert family["family_members"] == ["Bea"]
    assert family["family_member_ids"] == ["person-2"]
    assert family["family_member_emails"] == [None]
    assert family["family_member_user_ids"] == [None]
    assert family["family_member_mobile_numbers"] == [None]
    assert family["email"] == "legacy@gmail.com"
    assert family["user_id"] == "legacy-user"
    assert family["mobile_number"] == "+918888888888"
    snapshot.assert_awaited_once_with(
        "trip-family", "family-1", ["person-1"], session="session",
    )
    reallocate.assert_awaited_once_with(
        "trip-family", "family-1", 2, 1, session="session",
    )
    snapshot_roster.assert_not_awaited()


def test_standalone_and_family_dissolution_remove_complete_entity(monkeypatch):
    snapshot = AsyncMock()
    snapshot_roster = AsyncMock()
    reallocate = AsyncMock()
    monkeypatch.setattr(departure, "_snapshot_exact_family_people", snapshot)
    monkeypatch.setattr(departure, "_snapshot_implicit_split_roster", snapshot_roster)
    monkeypatch.setattr(departure, "_apply_reallocation", reallocate)

    individual = individual_trip()
    individual_identity = departure.resolve_linked_identity(individual, "user-1")
    individual_members = run(departure._departure_members(
        individual, individual_identity, "leave", session="session",
    ))
    assert [row["id"] for row in individual_members] == ["member-2"]
    reallocate.assert_awaited_with(
        "trip-1", "member-1", 1, 0, session="session",
    )

    family = family_trip()
    family_identity = departure.resolve_linked_identity(family, "user-1")
    family_members = run(departure._departure_members(
        family, family_identity, "dissolve_family", session="session",
    ))
    assert [row["id"] for row in family_members] == ["member-2"]
    snapshot.assert_awaited_once_with(
        "trip-family", "family-1", ["person-1", "person-2"], session="session",
    )
    reallocate.assert_awaited_with(
        "trip-family", "family-1", 2, 0, session="session",
    )
    assert snapshot_roster.await_count == 2
    snapshot_roster.assert_any_await(individual, session="session")
    snapshot_roster.assert_any_await(family, session="session")


def test_implicit_split_roster_is_frozen_to_stable_entity_ids(monkeypatch):
    update_many = AsyncMock()
    monkeypatch.setattr(
        departure,
        "db",
        SimpleNamespace(expenses=SimpleNamespace(update_many=update_many)),
    )
    trip = individual_trip()

    run(departure._snapshot_implicit_split_roster(trip, session="session"))

    query, mutation = update_many.await_args.args
    assert query == {
        "trip_id": "trip-1",
        "$or": [
            {"split_member_ids": []},
            {"split_member_ids": None},
            {"split_member_ids": {"$exists": False}},
        ],
    }
    assert mutation == {"$set": {"split_member_ids": ["member-1", "member-2"]}}
    assert update_many.await_args.kwargs == {"session": "session"}


def test_role_transfer_removes_account_and_requires_a_successor():
    trip = {
        "id": "trip-1", "owner_id": "user-1",
        "user_ids": ["user-1", "user-2"], "admin_ids": ["user-1"],
    }
    users, admins, owner = departure._roles_after_departure(
        trip, "user-1", {"successor": {"user_id": "user-2", "name": "Bea"}},
    )
    assert users == ["user-2"]
    assert admins == ["user-2"]
    assert owner == "user-2"

    with pytest.raises(HTTPException) as error:
        departure._roles_after_departure(trip, "user-1", {"successor": None})
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "owner_trip_requires_deletion"


def test_stale_expense_and_membership_versions_return_structured_conflicts(monkeypatch):
    expense_update = AsyncMock(return_value=SimpleNamespace(matched_count=0))
    monkeypatch.setattr(
        expense_routes,
        "db",
        SimpleNamespace(trips=SimpleNamespace(update_one=expense_update)),
    )
    with pytest.raises(HTTPException) as expense_conflict:
        run(expense_routes._claim_trip_version(
            {"id": "trip-1", "version": 4}, "2026-09-16T10:00:00+00:00", "session",
        ))
    assert expense_conflict.value.status_code == 409
    assert expense_conflict.value.detail["code"] == "eligibility_changed"
    assert expense_update.await_args.args[0] == {"id": "trip-1", "version": 4}

    membership_update = AsyncMock(return_value=SimpleNamespace(matched_count=0))
    monkeypatch.setattr(
        departure,
        "db",
        SimpleNamespace(trips=SimpleNamespace(update_one=membership_update)),
    )
    trip = individual_trip()
    trip["version"] = 7
    identity = departure.resolve_linked_identity(trip, "user-1")
    evaluation = {
        "trip": trip,
        "identity": identity,
        "public": {"ownership": ownership_ok()},
    }
    with pytest.raises(HTTPException) as membership_conflict:
        run(departure._write_trip_membership(
            evaluation, "user-1", "keep", session="session",
        ))
    assert membership_conflict.value.status_code == 409
    assert membership_conflict.value.detail["code"] == "eligibility_changed"
    assert membership_update.await_args.args[0] == {"id": "trip-1", "version": 7}


def test_exact_history_rolls_removed_family_person_into_retained_entity():
    members = [
        {
            "id": "family-1", "kind": "family", "family_members": ["Bea"],
            "family_member_ids": ["person-2"],
        },
        {"id": "payer", "kind": "individual"},
    ]
    expense = {
        "id": "exact", "amount": 10, "paid_by_member_id": "payer",
        "split_member_ids": ["family-1"], "split_mode": "EXACT",
        "custom_amounts": {"person-1": 5, "person-2": 5},
        "family_member_entity_snapshots": {"person-1": "family-1"},
    }
    payment = {
        "id": "paid", "from_member_id": "family-1", "to_member_id": "payer",
        "amount": 10,
    }

    assert build_precise_net(members, [expense], payments=[payment]) == {
        "family-1": 0,
        "payer": 0,
    }


def test_settled_removed_standalone_payer_remains_replayable():
    members = [{"id": "remaining", "kind": "individual"}]
    expense = {
        "id": "historical-expense",
        "amount": 10,
        "paid_by_member_id": "departed",
        "split_member_ids": ["departed", "remaining"],
        "split_mode": "PER_CAPITA",
    }
    payment = {
        "id": "settling-payment",
        "from_member_id": "remaining",
        "to_member_id": "departed",
        "amount": 5,
    }

    assert build_precise_net(members, [expense], payments=[payment]) == {"remaining": 0}


def test_frozen_implicit_split_keeps_settled_removed_participant_replayable():
    members = [{"id": "remaining", "kind": "individual"}]
    expense = {
        "id": "historical-expense",
        "amount": 10,
        "paid_by_member_id": "remaining",
        # The departure transaction replaces an originally empty all-roster split with this list.
        "split_member_ids": ["departed", "remaining"],
        "split_mode": "PER_CAPITA",
    }
    payment = {
        "id": "settling-payment",
        "from_member_id": "departed",
        "to_member_id": "remaining",
        "amount": 5,
    }

    assert build_precise_net(members, [expense], payments=[payment]) == {"remaining": 0}


def test_migration_adjustment_settles_removed_historical_member_before_omission():
    members = [{"id": "remaining", "kind": "individual"}]
    payment = {
        "id": "legacy-rounding-overlay",
        "from_member_id": "remaining",
        "to_member_id": "departed",
        "amount": 1,
    }

    with pytest.raises(SettlementLedgerError) as unresolved:
        build_precise_net(members, [], payments=[payment])
    assert unresolved.value.code == "orphaned_member_balance"

    assert build_precise_net(
        members,
        [],
        payments=[payment],
        migration_adjustments={"remaining": -1, "departed": 1},
    ) == {"remaining": 0}


def test_account_deletion_requires_acknowledgement_then_runs_scoped_and_global_cleanup(monkeypatch):
    user = {"id": "user-1", "email": "ada@gmail.com", "role": "user"}
    trip = individual_trip()
    identity = departure.resolve_linked_identity(trip, "user-1")
    evaluation = {
        "trip": trip,
        "identity": identity,
        "active_user_attempt": False,
        "active_family_attempt": False,
        "public": {
            "trip_name": trip["name"], "settled": False,
            "leave_eligible": False, "dissolve_family_eligible": False,
            "ownership": ownership_ok(),
        },
    }

    async def execute(callback):
        return await callback("session")

    users = SimpleNamespace(
        find_one=AsyncMock(return_value=user),
        delete_one=AsyncMock(return_value=SimpleNamespace(deleted_count=1)),
    )
    fake_db = SimpleNamespace(
        users=users,
        auth_tokens=SimpleNamespace(delete_many=AsyncMock()),
        password_reset_tokens=SimpleNamespace(delete_many=AsyncMock()),
        push_devices=SimpleNamespace(delete_many=AsyncMock()),
    )
    monkeypatch.setattr(departure, "db", fake_db)
    monkeypatch.setattr(departure, "_run_destructive_transaction", execute)
    monkeypatch.setattr(departure, "_linked_trips", AsyncMock(return_value=[trip]))
    monkeypatch.setattr(departure, "evaluate_trip", AsyncMock(return_value=evaluation))
    monkeypatch.setattr(departure, "_active_account_attempts", AsyncMock(return_value=[]))
    write = AsyncMock()
    scrub = AsyncMock()
    monkeypatch.setattr(departure, "_write_trip_membership", write)
    monkeypatch.setattr(departure, "_scrub_account_references", scrub)

    with pytest.raises(HTTPException) as error:
        run(departure.delete_account(
            user, confirmation="DELETE", acknowledge_unsettled=False, trip_actions=[],
        ))
    assert error.value.detail["code"] == "unsettled_acknowledgement_required"
    write.assert_not_awaited()

    result = run(departure.delete_account(
        user, confirmation="DELETE", acknowledge_unsettled=True, trip_actions=[],
    ))
    assert result == {"ok": True, "kept_trip_ids": ["trip-1"], "departed_trip_ids": []}
    write.assert_awaited_once()
    assert scrub.await_count == 2
    assert scrub.await_args_list[0].kwargs["trip_id"] == "trip-1"
    assert scrub.await_args_list[0].kwargs["identity"] == identity
    assert scrub.await_args_list[1].kwargs["trip_id"] is None
    users.delete_one.assert_awaited_once_with({"id": "user-1"}, session="session")


def test_confirmation_model_and_transaction_unavailable_errors_are_structured(monkeypatch):
    with pytest.raises(ValidationError):
        AccountDeletionIn(
            confirmation="DELETE",
            acknowledge_unsettled=False,
            trip_actions=[
                {"trip_id": "same", "action": "keep"},
                {"trip_id": "same", "action": "leave"},
            ],
        )

    with pytest.raises(HTTPException) as invalid:
        run(departure.delete_account(
            {"id": "user-1", "role": "user"},
            confirmation="delete", acknowledge_unsettled=True, trip_actions=[],
        ))
    assert invalid.value.status_code == 400
    assert invalid.value.detail["code"] == "invalid_confirmation"

    monkeypatch.setattr(
        departure,
        "run_required_transaction",
        AsyncMock(side_effect=TransactionUnavailableError("standalone")),
    )
    with pytest.raises(HTTPException) as unavailable:
        run(departure._run_destructive_transaction(AsyncMock()))
    assert unavailable.value.status_code == 503
    assert unavailable.value.detail["code"] == "transactions_unavailable"

    monkeypatch.setattr(
        departure,
        "run_required_transaction",
        AsyncMock(side_effect=PyMongoError("write conflict during commit")),
    )
    with pytest.raises(HTTPException) as conflict:
        run(departure._run_destructive_transaction(AsyncMock()))
    assert conflict.value.status_code == 409
    assert conflict.value.detail["code"] == "eligibility_changed"


def test_payment_attempt_scrub_clears_snapshots_for_any_direct_account_role(monkeypatch):
    update_many = AsyncMock()
    monkeypatch.setattr(
        departure,
        "db",
        SimpleNamespace(payment_attempts=SimpleNamespace(update_many=update_many)),
    )
    identity = {
        "identity_type": "family_member",
        "member_id": "family-1",
        "family_member_id": "person-1",
    }

    run(departure._scrub_payment_attempts(
        "user-1", identity, trip_id="trip-1", session="session",
    ))

    snapshot_query = update_many.await_args_list[0].args[0]
    assert snapshot_query["trip_id"] == "trip-1"
    assert {"initiating_payer_user_id": "user-1"} in snapshot_query["$or"]
    assert {"selected_recipient_person_id": "person-1"} in snapshot_query["$or"]
    assert update_many.await_args_list[0].args[1] == {
        "$unset": {"upi_id_snapshot": "", "upi_updated_at_snapshot": ""},
    }


def test_account_reference_scrub_covers_every_personal_data_collection(monkeypatch):
    def update_collection():
        return SimpleNamespace(update_many=AsyncMock())

    def delete_collection():
        return SimpleNamespace(delete_many=AsyncMock())

    chat_reads = delete_collection()
    mobile_claims = delete_collection()
    expenses = update_collection()
    settlements = update_collection()
    payments = update_collection()
    receipts = update_collection()
    money_audits = update_collection()
    admin_audits = update_collection()
    invites = update_collection()
    join_requests = SimpleNamespace(delete_many=AsyncMock(), update_many=AsyncMock())
    quotes = delete_collection()
    fake_db = MappingDatabase(
        chat_reads=chat_reads,
        trip_mobile_claims=mobile_claims,
        expenses=expenses,
        settlements=settlements,
        payments=payments,
        receipts_files=receipts,
        money_normalization_audits=money_audits,
        admin_audit_logs=admin_audits,
        trip_invites=invites,
        join_requests=join_requests,
        exchange_rate_quotes=quotes,
    )
    anonymize = AsyncMock()
    scrub_attempts = AsyncMock()
    scrub_notifications = AsyncMock()
    monkeypatch.setattr(departure, "db", fake_db)
    monkeypatch.setattr(departure, "_anonymize_chat", anonymize)
    monkeypatch.setattr(departure, "_scrub_payment_attempts", scrub_attempts)
    monkeypatch.setattr(departure, "_scrub_notification_records", scrub_notifications)

    user = {"id": "user-1", "email": "ada@gmail.com"}
    run(departure._scrub_account_references(
        user, trip_id=None, identity=None, session="session",
    ))

    anonymize.assert_awaited_once_with("user-1", trip_id=None, session="session")
    chat_reads.delete_many.assert_awaited_once_with(
        {"user_id": "user-1"}, session="session",
    )
    mobile_claims.delete_many.assert_awaited_once_with(
        {"user_id": "user-1"}, session="session",
    )
    expenses.update_many.assert_awaited_once_with(
        {"created_by": "user-1"}, {"$unset": {"created_by": ""}}, session="session",
    )
    settlements.update_many.assert_awaited_once()
    payments.update_many.assert_awaited_once_with(
        {"recorded_by": "user-1"}, {"$unset": {"recorded_by": ""}}, session="session",
    )
    scrub_attempts.assert_awaited_once_with(
        "user-1", None, trip_id=None, session="session",
    )
    receipts.update_many.assert_awaited_once_with(
        {"metadata.uploaded_by": "user-1"},
        {"$unset": {"metadata.uploaded_by": ""}},
        session="session",
    )
    money_audits.update_many.assert_awaited_once()
    assert admin_audits.update_many.await_count == 2
    invites.update_many.assert_awaited_once()
    scrub_notifications.assert_awaited_once_with(
        "user-1", trip_id=None, session="session",
    )
    join_requests.delete_many.assert_awaited_once_with(
        {"requester_user_id": "user-1"}, session="session",
    )
    assert join_requests.update_many.await_count == 2
    quotes.delete_many.assert_awaited_once_with(
        {"user_id": "user-1"}, session="session",
    )


def test_chat_anonymization_uses_distinct_trip_scoped_tombstones(monkeypatch):
    rows = FindCollection([
        {"trip_id": "trip-1"}, {"trip_id": "trip-1"}, {"trip_id": "trip-2"},
    ])
    rows.update_many = AsyncMock()
    monkeypatch.setattr(departure, "db", SimpleNamespace(chat_messages=rows))

    run(departure._anonymize_chat("user-1", trip_id=None, session="session"))

    assert rows.update_many.await_count == 2
    tombstones = []
    for call in rows.update_many.await_args_list:
        mutation = call.args[1]
        tombstones.append(mutation["$set"]["sender_user_id"])
        assert mutation["$set"]["sender_name"] == "Deleted user"
        assert mutation["$unset"] == {
            "sender_person_id": "", "sender_family_id": "", "sender_family_name": "",
        }
        assert call.kwargs["session"] == "session"
    assert len(set(tombstones)) == 2
    assert all(value.startswith("deleted-user:") for value in tombstones)
    assert all("user-1" not in value for value in tombstones)
