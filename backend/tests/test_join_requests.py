import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import BackgroundTasks, HTTPException

from models.join import JoinClaimRequest, JoinRequest
from routes import join_requests as join_request_routes
from routes import trips as trip_routes
from services import join_requests
from utils.common import now_utc


def run(awaitable):
    return asyncio.run(awaitable)


def roster_trip():
    return {
        "id": "trip-1",
        "name": "Coast trip",
        "code": "ABC123",
        "owner_id": "owner-1",
        "admin_ids": ["owner-1", "admin-1"],
        "user_ids": ["owner-1", "admin-1"],
        "members": [
            {
                "id": "individual-1", "kind": "individual", "name": "Asha",
                "email": None, "user_id": None,
            },
            {
                "id": "individual-2", "kind": "individual", "name": "Dev",
                "email": "saved@gmail.com", "user_id": None,
            },
            {
                "id": "family-1", "kind": "family", "name": "Sharma family",
                "family_members": ["Priya", "Rohan"],
                "family_member_ids": ["slot-1", "slot-2"],
                "family_member_emails": [None, "rohan@gmail.com"],
                "family_member_user_ids": [None, None],
                "email": None, "user_id": None,
            },
        ],
    }


def request_document(**overrides):
    timestamp = now_utc()
    document = {
        "id": "request-1",
        "trip_id": "trip-1",
        "trip_name": "Coast trip",
        "trip_code": "ABC123",
        "requester_user_id": "requester-1",
        "requester_name": "New Dev",
        "requester_email": "newdev@gmail.com",
        "target_kind": "individual",
        "member_id": "individual-2",
        "family_member_id": None,
        "family_id": None,
        "family_name": None,
        "target_name": "Dev",
        "target_email_before": "saved@gmail.com",
        "email_relation": "different",
        "status": "pending",
        "active": True,
        "created_at": timestamp,
        "updated_at": timestamp,
        "decided_at": None,
        "decided_by_user_id": None,
        "rejection_reason": None,
    }
    document.update(overrides)
    return document


def test_existing_people_lists_individuals_and_family_members_without_emails(monkeypatch):
    monkeypatch.setattr(
        join_requests, "member_has_financial_history", AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        join_requests, "family_member_has_financial_history", AsyncMock(return_value=False),
    )

    people = run(join_requests.existing_people(roster_trip(), "newdev@gmail.com"))

    assert [(row["kind"], row["name"]) for row in people] == [
        ("individual", "Asha"),
        ("individual", "Dev"),
        ("family_member", "Priya"),
        ("family_member", "Rohan"),
    ]
    assert all(row["resolution"] == "approval_required" for row in people)
    assert all("email" not in row for row in people)
    priya = next(row for row in people if row["name"] == "Priya")
    assert priya["member_id"] == "family-1"
    assert priya["family_member_id"] == "slot-1"
    assert priya["family_name"] == "Sharma family"


def test_exact_gmail_match_is_direct_and_preserves_history_signal(monkeypatch):
    trip = roster_trip()
    trip["members"][1]["email"] = "NEWDEV@GMAIL.COM"
    monkeypatch.setattr(
        join_requests, "member_has_financial_history", AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        join_requests, "family_member_has_financial_history", AsyncMock(return_value=False),
    )

    people = run(join_requests.existing_people(trip, "newdev@gmail.com"))

    assert people[0]["member_id"] == "individual-2"
    assert people[0]["resolution"] == "direct"
    assert people[0]["has_financial_history"] is True
    assert people[0]["can_replace"] is False
    assert "email" not in people[0]


def test_create_request_keeps_old_email_in_admin_audit_but_hides_it_from_requester(monkeypatch):
    collection = SimpleNamespace(
        find_one=AsyncMock(side_effect=[None, None]),
        insert_one=AsyncMock(),
    )
    monkeypatch.setattr(join_requests, "db", SimpleNamespace(join_requests=collection))
    monkeypatch.setattr(join_requests, "existing_people", AsyncMock(return_value=[]))
    trip = roster_trip()
    user = {"id": "requester-1", "name": "New Dev", "email": "newdev@gmail.com"}

    document = run(join_requests.create_request(
        trip, user, "individual-2", None,
    ))

    assert document["target_email_before"] == "saved@gmail.com"
    assert document["email_relation"] == "different"
    public = join_requests.request_payload(document)
    assert "target_email" not in public
    assert "requester" not in public
    admin = join_requests.request_payload(document, admin=True)
    assert admin["target_email"] == "saved@gmail.com"
    assert admin["requester"]["email"] == "newdev@gmail.com"


def test_one_active_request_is_idempotent_for_same_target_and_blocks_a_different_target(monkeypatch):
    current = request_document()
    collection = SimpleNamespace(find_one=AsyncMock(return_value=current))
    monkeypatch.setattr(join_requests, "db", SimpleNamespace(join_requests=collection))
    monkeypatch.setattr(join_requests, "existing_people", AsyncMock(return_value=[]))
    trip = roster_trip()
    user = {"id": "requester-1", "name": "New Dev", "email": "newdev@gmail.com"}

    assert run(join_requests.create_request(trip, user, "individual-2", None)) == current
    with pytest.raises(HTTPException) as error:
        run(join_requests.create_request(trip, user, "individual-1", None))
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "active_join_request"


def test_rejected_same_target_has_a_24_hour_cooldown(monkeypatch):
    rejected = request_document(
        status="rejected", active=False, decided_at=now_utc() - timedelta(hours=1),
    )
    collection = SimpleNamespace(find_one=AsyncMock(side_effect=[None, rejected]))
    monkeypatch.setattr(join_requests, "db", SimpleNamespace(join_requests=collection))
    monkeypatch.setattr(join_requests, "existing_people", AsyncMock(return_value=[]))
    trip = roster_trip()
    user = {"id": "requester-1", "name": "New Dev", "email": "newdev@gmail.com"}

    with pytest.raises(HTTPException) as error:
        run(join_requests.create_request(trip, user, "individual-2", None))

    assert error.value.status_code == 429
    assert error.value.detail["code"] == "join_request_cooldown"
    assert error.value.detail["retry_after"]


def test_approval_replaces_email_and_finalizes_request(monkeypatch):
    document = request_document()
    trip = roster_trip()
    fresh_trip = roster_trip()
    fresh_trip["user_ids"].append("requester-1")
    fresh_trip["members"][1].update({
        "email": "newdev@gmail.com", "user_id": "requester-1",
    })
    final = request_document(
        status="approved", active=False, decided_at=now_utc(),
    )
    request_collection = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value=document),
        find_one=AsyncMock(return_value=final),
        update_one=AsyncMock(),
        update_many=AsyncMock(),
    )
    trip_collection = SimpleNamespace(
        find_one=AsyncMock(side_effect=[trip, fresh_trip]),
        update_one=AsyncMock(return_value=SimpleNamespace(modified_count=1)),
    )
    monkeypatch.setattr(join_requests, "db", SimpleNamespace(
        join_requests=request_collection,
        trips=trip_collection,
        users=SimpleNamespace(find_one=AsyncMock(return_value={
            "id": "requester-1", "name": "New Dev", "email": "newdev@gmail.com",
        })),
    ))

    approved, returned_trip = run(join_requests.approve_request("request-1", "admin-1"))

    assert approved["status"] == "approved"
    assert returned_trip == fresh_trip
    query, update = trip_collection.update_one.await_args.args
    assert query["members"]["$elemMatch"]["email"] == "saved@gmail.com"
    assert update["$set"]["members.$.email"] == "newdev@gmail.com"
    assert document["target_email_before"] == "saved@gmail.com"
    request_collection.update_one.assert_awaited()
    request_collection.update_many.assert_awaited_once()


def test_approval_links_a_family_member_and_guards_the_saved_email(monkeypatch):
    document = request_document(
        target_kind="family_member",
        member_id="family-1",
        family_member_id="slot-1",
        family_id="family-1",
        family_name="Sharma family",
        target_name="Priya",
        target_email_before=None,
        email_relation="missing",
    )
    trip = roster_trip()
    fresh_trip = roster_trip()
    fresh_trip["user_ids"].append("requester-1")
    fresh_trip["members"][2]["family_member_emails"][0] = "newdev@gmail.com"
    fresh_trip["members"][2]["family_member_user_ids"][0] = "requester-1"
    final = {**document, "status": "approved", "active": False, "decided_at": now_utc()}
    request_collection = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value=document),
        find_one=AsyncMock(return_value=final),
        update_one=AsyncMock(),
        update_many=AsyncMock(),
    )
    trip_collection = SimpleNamespace(
        find_one=AsyncMock(side_effect=[trip, fresh_trip]),
        update_one=AsyncMock(return_value=SimpleNamespace(modified_count=1)),
    )
    monkeypatch.setattr(join_requests, "db", SimpleNamespace(
        join_requests=request_collection,
        trips=trip_collection,
        users=SimpleNamespace(find_one=AsyncMock(return_value={
            "id": "requester-1", "name": "New Dev", "email": "newdev@gmail.com",
        })),
    ))

    approved, returned_trip = run(join_requests.approve_request("request-1", "admin-1"))

    assert approved["status"] == "approved"
    assert returned_trip == fresh_trip
    query, update = trip_collection.update_one.await_args.args
    target_query = query["members"]["$elemMatch"]
    assert target_query["family_member_ids.0"] == "slot-1"
    assert target_query["family_member_emails.0"] is None
    assert update["$set"]["members.$.family_member_user_ids.0"] == "requester-1"
    assert update["$set"]["members.$.family_member_emails.0"] == "newdev@gmail.com"


def test_approval_retry_finalizes_a_roster_link_left_in_approving_state(monkeypatch):
    approving = request_document(status="approving")
    approved = request_document(status="approved", active=False, decided_at=now_utc())
    linked_trip = roster_trip()
    linked_trip["user_ids"].append("requester-1")
    linked_trip["members"][1].update({
        "email": "newdev@gmail.com", "user_id": "requester-1",
    })
    request_collection = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value=None),
        find_one=AsyncMock(side_effect=[approving, approved]),
        update_one=AsyncMock(),
        update_many=AsyncMock(),
    )
    trip_collection = SimpleNamespace(
        find_one=AsyncMock(side_effect=[linked_trip, linked_trip]),
        update_one=AsyncMock(),
    )
    monkeypatch.setattr(join_requests, "db", SimpleNamespace(
        join_requests=request_collection,
        trips=trip_collection,
        users=SimpleNamespace(find_one=AsyncMock(return_value={
            "id": "requester-1", "name": "New Dev", "email": "newdev@gmail.com",
        })),
    ))

    result, _ = run(join_requests.approve_request("request-1", "admin-1"))

    assert result["status"] == "approved"
    trip_collection.update_one.assert_not_awaited()
    final_update = request_collection.update_one.await_args_list[-1].args[1]
    assert final_update["$set"]["status"] == "approved"


def test_concurrent_approval_of_same_request_recognizes_the_same_winner(monkeypatch):
    document = request_document()
    approved = request_document(status="approved", active=False, decided_at=now_utc())
    before = roster_trip()
    won = roster_trip()
    won["user_ids"].append("requester-1")
    won["members"][1].update({
        "email": "newdev@gmail.com", "user_id": "requester-1",
    })
    request_collection = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value=document),
        find_one=AsyncMock(return_value=approved),
        update_one=AsyncMock(),
        update_many=AsyncMock(),
    )
    trip_collection = SimpleNamespace(
        find_one=AsyncMock(side_effect=[before, won, won]),
        # Another approval worker linked this same requester just before this write.
        update_one=AsyncMock(return_value=SimpleNamespace(modified_count=0)),
    )
    monkeypatch.setattr(join_requests, "db", SimpleNamespace(
        join_requests=request_collection,
        trips=trip_collection,
        users=SimpleNamespace(find_one=AsyncMock(return_value={
            "id": "requester-1", "name": "New Dev", "email": "newdev@gmail.com",
        })),
    ))

    result, returned_trip = run(join_requests.approve_request("request-1", "admin-1"))

    assert result["status"] == "approved"
    assert returned_trip == won
    final_update = request_collection.update_one.await_args_list[-1].args[1]
    assert final_update["$set"]["status"] == "approved"


def test_approval_does_not_overwrite_a_newer_admin_email_change(monkeypatch):
    document = request_document()
    changed = roster_trip()
    changed["members"][1]["email"] = "corrected@gmail.com"
    request_collection = SimpleNamespace(
        find_one_and_update=AsyncMock(return_value=document),
        update_one=AsyncMock(),
    )
    trip_collection = SimpleNamespace(
        find_one=AsyncMock(return_value=changed),
        update_one=AsyncMock(),
    )
    monkeypatch.setattr(join_requests, "db", SimpleNamespace(
        join_requests=request_collection,
        trips=trip_collection,
        users=SimpleNamespace(find_one=AsyncMock(return_value={
            "id": "requester-1", "name": "New Dev", "email": "newdev@gmail.com",
        })),
    ))

    with pytest.raises(HTTPException) as error:
        run(join_requests.approve_request("request-1", "admin-1"))

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "join_request_obsolete"
    trip_collection.update_one.assert_not_awaited()
    obsolete_update = request_collection.update_one.await_args.args[1]
    assert obsolete_update["$set"]["status"] == "obsolete"


def test_blank_family_person_requires_structured_approval(monkeypatch):
    trip = roster_trip()
    body = JoinRequest(
        code="ABC123", mode="family", family_id="family-1", family_member_id="slot-1",
    )

    with pytest.raises(HTTPException) as error:
        run(trip_routes._apply_mode(
            trip,
            trip["members"],
            {"id": "requester-1", "name": "Priya"},
            "newdev@gmail.com",
            body,
        ))

    assert error.value.status_code == 409
    assert error.value.detail == {
        "code": "approval_required",
        "message": "An owner or admin must approve joining as this family member",
    }


def test_plain_member_cannot_approve_request(monkeypatch):
    guard = AsyncMock(side_effect=HTTPException(403, "Trip admin access required"))
    approve = AsyncMock()
    monkeypatch.setattr(join_request_routes, "_trip_admin_or_403", guard)
    monkeypatch.setattr(join_request_routes, "approve_request", approve)

    with pytest.raises(HTTPException) as error:
        run(join_request_routes.approve_join_request(
            "trip-1", "request-1", BackgroundTasks(), user={"id": "plain-user"},
        ))

    assert error.value.status_code == 403
    approve.assert_not_awaited()


def test_request_notification_goes_only_to_trip_admins(monkeypatch):
    trip = roster_trip()
    document = request_document()
    enqueue = AsyncMock()
    monkeypatch.setattr(join_request_routes, "db", SimpleNamespace(
        trips=SimpleNamespace(find_one=AsyncMock(return_value=trip)),
    ))
    monkeypatch.setattr(join_request_routes, "create_request", AsyncMock(return_value=document))
    monkeypatch.setattr(join_request_routes, "enqueue_notification_event", enqueue)

    result = run(join_request_routes.request_existing_person(
        JoinClaimRequest(code="ABC123", member_id="individual-2"),
        BackgroundTasks(),
        user={"id": "requester-1", "name": "New Dev", "email": "newdev@gmail.com"},
    ))

    assert result["status"] == "pending"
    assert enqueue.await_args.kwargs["event_type"] == "join.request.created"
    assert enqueue.await_args.kwargs["recipient_user_ids_override"] == ["owner-1", "admin-1"]


def test_approval_notification_goes_only_to_requester(monkeypatch):
    document = request_document(status="approved", active=False, decided_at=now_utc())
    enqueue = AsyncMock()
    monkeypatch.setattr(join_request_routes, "_trip_admin_or_403", AsyncMock())
    monkeypatch.setattr(
        join_request_routes, "_request_for_trip_or_404", AsyncMock(return_value=request_document()),
    )
    monkeypatch.setattr(
        join_request_routes, "approve_request", AsyncMock(return_value=(document, roster_trip())),
    )
    monkeypatch.setattr(join_request_routes, "enqueue_notification_event", enqueue)

    result = run(join_request_routes.approve_join_request(
        "trip-1", "request-1", BackgroundTasks(), user={"id": "admin-1"},
    ))

    assert result["status"] == "approved"
    assert enqueue.await_args.kwargs["event_type"] == "join.request.approved"
    assert enqueue.await_args.kwargs["recipient_user_ids_override"] == ["requester-1"]
