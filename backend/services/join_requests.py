"""Existing-person join discovery and owner/admin approval workflow.

The trip code authorizes a user to see unlinked roster *names*.  It does not authorize them to
take a blank- or different-email identity: those claims live here as durable requests.  Exact Gmail
matches continue to use the immediate claim path in ``routes.trips``.
"""

from datetime import timedelta
from typing import Optional

from fastapi import HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from database import db
from utils.common import gen_id, iso, now_utc
from utils.email_rules import normalize_email
from utils.members import (
    family_member_has_financial_history,
    member_has_financial_history,
    padded_family_member_ids,
)


RETRY_COOLDOWN = timedelta(hours=24)
PUBLIC_PENDING_STATUSES = {"pending", "approving"}


def _fail(status: int, code: str, message: str, **extra) -> None:
    raise HTTPException(status, detail={"code": code, "message": message, **extra})


def _slot_value(values: list, index: int):
    return values[index] if index < len(values) else None


def resolve_target(trip: dict, member_id: str, family_member_id: Optional[str] = None) -> dict:
    root = next((m for m in trip.get("members", []) if m.get("id") == member_id), None)
    if not root:
        _fail(404, "join_target_not_found", "This person is no longer on the trip")
    if family_member_id:
        if root.get("kind") != "family":
            _fail(400, "invalid_join_target", "The selected person is not in a family")
        ids = padded_family_member_ids(root)
        if family_member_id not in ids:
            _fail(404, "join_target_not_found", "This family member is no longer on the trip")
        index = ids.index(family_member_id)
        names = root.get("family_members") or []
        emails = root.get("family_member_emails") or []
        user_ids = root.get("family_member_user_ids") or []
        return {
            "kind": "family_member",
            "member_id": root["id"],
            "family_member_id": family_member_id,
            "name": _slot_value(names, index) or "Family member",
            "family_id": root["id"],
            "family_name": root.get("name"),
            "email": normalize_email(_slot_value(emails, index)),
            "email_raw": _slot_value(emails, index),
            "user_id": _slot_value(user_ids, index),
            "index": index,
            "root": root,
        }
    if root.get("kind") == "family":
        _fail(400, "invalid_join_target", "Choose a specific person inside this family")
    return {
        "kind": "individual",
        "member_id": root["id"],
        "family_member_id": None,
        "name": root.get("name") or "Individual",
        "family_id": None,
        "family_name": None,
        "email": normalize_email(root.get("email")),
        "email_raw": root.get("email"),
        "user_id": root.get("user_id"),
        "index": None,
        "root": root,
    }


def _target_public(target: dict, resolution: Optional[str] = None) -> dict:
    payload = {
        "kind": target["kind"],
        "member_id": target["member_id"],
        "family_member_id": target.get("family_member_id"),
        "name": target["name"],
        "family_id": target.get("family_id"),
        "family_name": target.get("family_name"),
    }
    if resolution:
        payload["resolution"] = resolution
    return payload


async def existing_people(trip: dict, caller_email: str) -> list[dict]:
    """Return every unlinked person, with no saved-email disclosure."""
    caller_email = normalize_email(caller_email)
    people: list[dict] = []
    for root in trip.get("members", []):
        if root.get("kind") != "family":
            if root.get("user_id"):
                continue
            target = resolve_target(trip, root["id"])
            direct = bool(caller_email and target["email"] == caller_email)
            row = _target_public(target, "direct" if direct else "approval_required")
            if direct:
                has_history = await member_has_financial_history(trip["id"], root["id"])
                row.update({"has_financial_history": has_history, "can_replace": not has_history})
            people.append(row)
            continue

        ids = padded_family_member_ids(root)
        user_ids = root.get("family_member_user_ids") or []
        for index, family_member_id in enumerate(ids):
            if _slot_value(user_ids, index):
                continue
            target = resolve_target(trip, root["id"], family_member_id)
            direct = bool(caller_email and target["email"] == caller_email)
            row = _target_public(target, "direct" if direct else "approval_required")
            if direct:
                has_history = await family_member_has_financial_history(
                    trip["id"], root, family_member_id,
                )
                row.update({"has_financial_history": has_history, "can_replace": not has_history})
            people.append(row)
    # Email matches are the strongest signal and should be visually first; otherwise preserve the
    # owner's roster order rather than inventing an alphabetical identity order.
    return sorted(people, key=lambda row: row["resolution"] != "direct")


def _same_target(document: dict, member_id: str, family_member_id: Optional[str]) -> bool:
    return (
        document.get("member_id") == member_id
        and (document.get("family_member_id") or None) == (family_member_id or None)
    )


def _request_target(document: dict) -> dict:
    return {
        "kind": document.get("target_kind"),
        "member_id": document.get("member_id"),
        "family_member_id": document.get("family_member_id"),
        "name": document.get("target_name"),
        "family_id": document.get("family_id"),
        "family_name": document.get("family_name"),
    }


def request_payload(document: dict, *, admin: bool = False) -> dict:
    status = "pending" if document.get("status") == "approving" else document.get("status")
    payload = {
        "id": document["id"],
        "trip": {
            "id": document["trip_id"],
            "name": document.get("trip_name"),
            "code": document.get("trip_code"),
        },
        "target": _request_target(document),
        "status": status,
        "created_at": iso(document.get("created_at")),
        "updated_at": iso(document.get("updated_at")),
        "decided_at": iso(document.get("decided_at")),
        "rejection_reason": document.get("rejection_reason"),
    }
    if document.get("status") == "rejected" and document.get("decided_at"):
        payload["retry_after"] = iso(document["decided_at"] + RETRY_COOLDOWN)
    else:
        payload["retry_after"] = None
    if admin:
        payload["requester"] = {
            "user_id": document["requester_user_id"],
            "name": document.get("requester_name"),
            "email": document.get("requester_email"),
        }
        payload["target_email"] = document.get("target_email_before")
        payload["email_relation"] = document.get("email_relation")
        payload["decided_by_user_id"] = document.get("decided_by_user_id")
    return payload


async def active_request(trip_id: str, requester_user_id: str) -> Optional[dict]:
    return await db.join_requests.find_one({
        "trip_id": trip_id,
        "requester_user_id": requester_user_id,
        "active": True,
    }, {"_id": 0})


async def create_request(trip: dict, user: dict, member_id: str,
                         family_member_id: Optional[str]) -> dict:
    if user["id"] in trip.get("user_ids", []):
        _fail(409, "already_joined", "You already belong to this trip")
    target = resolve_target(trip, member_id, family_member_id)
    if target.get("user_id"):
        _fail(409, "join_target_taken", "This person is already linked to an account")

    caller_email = normalize_email(user.get("email"))
    if target.get("email") == caller_email:
        _fail(409, "direct_claim_available", "This person already matches your Gmail; join directly")

    # A different exact-email profile must be resolved first.  This prevents an approval from
    # creating two people with one Gmail and keeps the established wrong-match replacement flow.
    direct_matches = [
        row for row in await existing_people(trip, caller_email)
        if row["resolution"] == "direct"
    ]
    if direct_matches:
        _fail(
            409,
            "direct_claim_available",
            "Another existing person already matches your Gmail; resolve that match first",
        )

    current = await active_request(trip["id"], user["id"])
    if current:
        if _same_target(current, member_id, family_member_id):
            return current
        _fail(409, "active_join_request", "Cancel your pending request before choosing another person")

    cooldown_after = now_utc() - RETRY_COOLDOWN
    rejected = await db.join_requests.find_one({
        "trip_id": trip["id"],
        "requester_user_id": user["id"],
        "member_id": member_id,
        "family_member_id": family_member_id or None,
        "status": "rejected",
        "decided_at": {"$gt": cooldown_after},
    }, {"_id": 0}, sort=[("decided_at", -1)])
    if rejected:
        retry_after = rejected["decided_at"] + RETRY_COOLDOWN
        _fail(
            429,
            "join_request_cooldown",
            "You can request this person again after the 24-hour waiting period",
            retry_after=iso(retry_after),
        )

    timestamp = now_utc()
    document = {
        "id": gen_id(),
        "trip_id": trip["id"],
        "trip_name": trip.get("name"),
        "trip_code": trip.get("code"),
        "requester_user_id": user["id"],
        "requester_name": user.get("name"),
        "requester_email": caller_email,
        "target_kind": target["kind"],
        "member_id": target["member_id"],
        "family_member_id": target.get("family_member_id"),
        "family_id": target.get("family_id"),
        "family_name": target.get("family_name"),
        "target_name": target["name"],
        "target_email_before": target.get("email"),
        "email_relation": "missing" if not target.get("email") else "different",
        "status": "pending",
        "active": True,
        "created_at": timestamp,
        "updated_at": timestamp,
        "decided_at": None,
        "decided_by_user_id": None,
        "rejection_reason": None,
    }
    try:
        await db.join_requests.insert_one(document)
    except DuplicateKeyError:
        current = await active_request(trip["id"], user["id"])
        if current and _same_target(current, member_id, family_member_id):
            return current
        _fail(409, "active_join_request", "You already have a pending request for this trip")
    document.pop("_id", None)
    return document


async def get_request_for_user(request_id: str, user_id: str) -> dict:
    document = await db.join_requests.find_one({
        "id": request_id,
        "requester_user_id": user_id,
    }, {"_id": 0})
    if not document:
        _fail(404, "join_request_not_found", "Join request not found")
    return document


async def cancel_request(request_id: str, user_id: str) -> dict:
    timestamp = now_utc()
    updated = await db.join_requests.find_one_and_update(
        {"id": request_id, "requester_user_id": user_id, "status": "pending"},
        {"$set": {
            "status": "cancelled", "active": False, "updated_at": timestamp,
            "decided_at": timestamp,
        }},
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    if updated:
        return updated
    current = await get_request_for_user(request_id, user_id)
    if current.get("status") in {"cancelled", "approved", "rejected", "obsolete"}:
        return current
    _fail(409, "join_request_in_progress", "This request is currently being reviewed")


async def cancel_pending_after_join(trip_id: str, requester_user_id: str) -> None:
    timestamp = now_utc()
    await db.join_requests.update_many(
        {
            "trip_id": trip_id,
            "requester_user_id": requester_user_id,
            "status": "pending",
        },
        {"$set": {
            "status": "cancelled", "active": False, "updated_at": timestamp,
            "decided_at": timestamp, "rejection_reason": "Joined as a new person instead.",
        }},
    )


async def list_requests(trip_id: str, status: Optional[str] = "pending") -> list[dict]:
    query: dict = {"trip_id": trip_id}
    if status == "pending":
        query["status"] = {"$in": list(PUBLIC_PENDING_STATUSES)}
    elif status:
        query["status"] = status
    return await db.join_requests.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)


def _email_owned_elsewhere(trip: dict, email: str, target: dict) -> bool:
    for root in trip.get("members", []):
        if root.get("kind") != "family":
            if root.get("id") != target["member_id"] and normalize_email(root.get("email")) == email:
                return True
            continue
        emails = root.get("family_member_emails") or []
        ids = padded_family_member_ids(root)
        for index, family_member_id in enumerate(ids):
            if (root.get("id"), family_member_id) == (
                target["member_id"], target.get("family_member_id"),
            ):
                continue
            if normalize_email(_slot_value(emails, index)) == email:
                return True
    return False


async def approve_request(request_id: str, admin_user_id: str) -> tuple[dict, dict]:
    timestamp = now_utc()
    document = await db.join_requests.find_one_and_update(
        {"id": request_id, "status": "pending"},
        {"$set": {"status": "approving", "updated_at": timestamp,
                  "decided_by_user_id": admin_user_id}},
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    if not document:
        current = await db.join_requests.find_one({"id": request_id}, {"_id": 0})
        if not current:
            _fail(404, "join_request_not_found", "Join request not found")
        if current.get("status") == "approved":
            trip = await db.trips.find_one({"id": current["trip_id"]}, {"_id": 0})
            return current, trip
        # ``approving`` is a recoverable state.  A process can stop after claiming the request or
        # after linking the roster but before recording the final request status.  Retrying approval
        # resumes that work; the conditional trip update below still ensures that only one account
        # can win the identity.
        if current.get("status") != "approving":
            _fail(409, "join_request_resolved", "This join request is no longer pending")
        document = current

    trip = await db.trips.find_one({"id": document["trip_id"]}, {"_id": 0})
    requester = await db.users.find_one({"id": document["requester_user_id"]}, {"_id": 0})
    if not trip or not requester:
        await db.join_requests.update_one({"id": request_id, "status": "approving"}, {"$set": {
            "status": "obsolete", "active": False, "updated_at": timestamp,
            "decided_at": timestamp, "rejection_reason": "The trip or account no longer exists.",
        }})
        _fail(409, "join_request_obsolete", "The trip or requester no longer exists")

    try:
        target = resolve_target(trip, document["member_id"], document.get("family_member_id"))
    except HTTPException:
        await db.join_requests.update_one({"id": request_id, "status": "approving"}, {"$set": {
            "status": "obsolete", "active": False, "updated_at": timestamp,
            "decided_at": timestamp, "rejection_reason": "The selected person no longer exists.",
        }})
        raise

    requester_email = normalize_email(requester.get("email"))
    target_owned_by_requester = (
        target.get("user_id") == document["requester_user_id"]
        and document["requester_user_id"] in trip.get("user_ids", [])
    )
    if (
        not target_owned_by_requester
        and normalize_email(target.get("email"))
        != normalize_email(document.get("target_email_before"))
    ):
        # Do not overwrite an admin's newer roster correction using a stale approval screen.
        await db.join_requests.update_one({"id": request_id, "status": "approving"}, {"$set": {
            "status": "obsolete", "active": False, "updated_at": timestamp,
            "decided_at": timestamp, "rejection_reason": "The saved email changed after this request.",
        }})
        _fail(409, "join_request_obsolete", "The saved email changed after this request was sent")
    if _email_owned_elsewhere(trip, requester_email, target):
        await db.join_requests.update_one({"id": request_id, "status": "approving"}, {"$set": {
            "status": "obsolete", "active": False, "updated_at": timestamp,
            "decided_at": timestamp,
            "rejection_reason": "This Gmail is now assigned to another person on the trip.",
        }})
        _fail(409, "join_request_obsolete", "The requester Gmail now belongs to another person")

    if document["requester_user_id"] in trip.get("user_ids", []) and not target_owned_by_requester:
        # A concurrent new join won.  The trip document is the identity source of truth.
        await db.join_requests.update_one({"id": request_id, "status": "approving"}, {"$set": {
            "status": "obsolete", "active": False, "updated_at": timestamp,
            "decided_at": timestamp, "rejection_reason": "The requester joined another way.",
        }})
        _fail(409, "join_request_obsolete", "The requester has already joined this trip")

    if target.get("user_id") and not target_owned_by_requester:
        await db.join_requests.update_one({"id": request_id, "status": "approving"}, {"$set": {
            "status": "obsolete", "active": False, "updated_at": timestamp,
            "decided_at": timestamp, "rejection_reason": "This person was linked to another account.",
        }})
        _fail(409, "join_target_taken", "This person is already linked to another account")

    if target_owned_by_requester:
        result = None  # A previous attempt linked the roster; only finalization remains.
    elif target["kind"] == "individual":
        result = await db.trips.update_one(
            {
                "id": trip["id"],
                "user_ids": {"$ne": requester["id"]},
                "members": {"$elemMatch": {
                    "id": target["member_id"],
                    "user_id": None,
                    "email": target.get("email_raw"),
                }},
            },
            {
                "$addToSet": {"user_ids": requester["id"]},
                "$set": {
                    "members.$.user_id": requester["id"],
                    "members.$.email": requester_email,
                },
            },
        )
    else:
        index = target["index"]
        result = await db.trips.update_one(
            {
                "id": trip["id"],
                "user_ids": {"$ne": requester["id"]},
                "members": {"$elemMatch": {
                    "id": target["member_id"],
                    f"family_member_ids.{index}": target["family_member_id"],
                    f"family_member_user_ids.{index}": None,
                    f"family_member_emails.{index}": target.get("email_raw"),
                }},
            },
            {
                "$addToSet": {"user_ids": requester["id"]},
                "$set": {
                    f"members.$.family_member_user_ids.{index}": requester["id"],
                    f"members.$.family_member_emails.{index}": requester_email,
                },
            },
        )

    if result is not None and result.modified_count == 0:
        # Another retry/admin may have completed the exact same roster link between our read and
        # write.  Treat that as success; only a different winner or other roster change obsoletes it.
        fresh = await db.trips.find_one({"id": trip["id"]}, {"_id": 0})
        if fresh:
            try:
                fresh_target = resolve_target(
                    fresh, document["member_id"], document.get("family_member_id"),
                )
            except HTTPException:
                fresh_target = None
        else:
            fresh_target = None
        linked_by_this_request = bool(
            fresh
            and document["requester_user_id"] in fresh.get("user_ids", [])
            and fresh_target
            and fresh_target.get("user_id") == document["requester_user_id"]
        )
        if not linked_by_this_request:
            await db.join_requests.update_one({"id": request_id, "status": "approving"}, {"$set": {
                "status": "obsolete", "active": False, "updated_at": timestamp,
                "decided_at": timestamp, "rejection_reason": "The roster changed before approval.",
            }})
            _fail(409, "join_request_obsolete", "The roster changed before this request was approved")

    await db.join_requests.update_one({"id": request_id, "status": "approving"}, {"$set": {
        "status": "approved", "active": False, "updated_at": timestamp,
        "decided_at": timestamp,
    }})
    await db.join_requests.update_many({
        "trip_id": trip["id"],
        "member_id": target["member_id"],
        "family_member_id": target.get("family_member_id"),
        "status": "pending",
        "id": {"$ne": request_id},
    }, {"$set": {
        "status": "obsolete", "active": False, "updated_at": timestamp,
        "decided_at": timestamp, "rejection_reason": "Another account was approved for this person.",
    }})
    final = await db.join_requests.find_one({"id": request_id}, {"_id": 0})
    fresh_trip = await db.trips.find_one({"id": trip["id"]}, {"_id": 0})
    return final, fresh_trip


async def reject_request(request_id: str, admin_user_id: str,
                         reason: Optional[str]) -> dict:
    timestamp = now_utc()
    updated = await db.join_requests.find_one_and_update(
        {"id": request_id, "status": "pending"},
        {"$set": {
            "status": "rejected", "active": False, "updated_at": timestamp,
            "decided_at": timestamp, "decided_by_user_id": admin_user_id,
            "rejection_reason": reason,
        }},
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    if updated:
        return updated
    current = await db.join_requests.find_one({"id": request_id}, {"_id": 0})
    if not current:
        _fail(404, "join_request_not_found", "Join request not found")
    _fail(409, "join_request_resolved", "This join request is no longer pending")
