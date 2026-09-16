"""Self-service trip departure and complete account deletion.

Every destructive mutation in this module runs in a required MongoDB transaction.  Impact reads
are deliberately advisory; the same identity, balance, active-payment, family, and ownership rules
are rebuilt from the transaction snapshot immediately before any write.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
from typing import Iterable, Optional

from fastapi import HTTPException
from pymongo import UpdateOne

from database import db
from services.ledger_transactions import (
    TransactionUnavailableError,
    is_retryable_transaction_error,
    run_required_transaction,
)
from services.payment_attempts import ACTIVE_PAYMENT_ATTEMPT_STATUSES
from services.reallocation import plan_reallocation
from utils.balances import _compute_balances
from utils.common import now_utc
from utils.members import (
    align_family_member_emails,
    align_family_member_user_ids,
    assign_family_member_ids,
    padded_family_member_ids,
)
from utils.permissions import is_super_admin


ACCOUNT_REFERENCE_FIELDS = (
    "initiating_payer_user_id",
    "selected_recipient_user_id",
    "sender_reported_by",
    "canceled_by",
    "confirmation_attempted_by",
    "recipient_confirmed_by",
    "recipient_not_received_by",
    "review_closed_by",
)


def _detail(code: str, message: str, *, trip_id: Optional[str] = None,
            action: Optional[str] = None, retryable: bool = True) -> dict:
    payload = {"code": code, "message": message, "retryable": retryable}
    if trip_id:
        payload["trip_id"] = trip_id
    if action:
        payload["action"] = action
    return payload


def _conflict(code: str, message: str, *, trip_id: Optional[str] = None,
              action: Optional[str] = None, retryable: bool = True) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail=_detail(code, message, trip_id=trip_id, action=action, retryable=retryable),
    )


def _session_options(session) -> dict:
    return {"session": session} if session is not None else {}


def _decimal(value: object) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("NaN")
    return parsed


def _decimal_text(value: object) -> str:
    parsed = _decimal(value)
    if not parsed.is_finite() or parsed == 0:
        return "0"
    return format(parsed.normalize(), "f")


def _aware_datetime(value: object) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _is_nonexpired_attempt(attempt: dict, timestamp: datetime) -> bool:
    if attempt.get("status") not in ACTIVE_PAYMENT_ATTEMPT_STATUSES:
        return False
    expires_at = _aware_datetime(attempt.get("expires_at"))
    # A legacy unresolved row with no expiry is conservatively still active.
    return expires_at is None or expires_at > timestamp


def linked_identities(trip: dict, user_id: str) -> list[dict]:
    """Return every exact roster slot linked to ``user_id`` in visible roster order.

    A legacy family-level link is returned but marked invalid: self-service removal cannot guess
    which human row it represents. Startup migration normally eliminates this shape.
    """

    identities: list[dict] = []
    for member_index, member in enumerate(trip.get("members", []) or []):
        if member.get("kind") != "family":
            if member.get("user_id") == user_id:
                identities.append({
                    "identity_type": "individual",
                    "member_id": member.get("id"),
                    "member_name": member.get("name") or "Trip member",
                    "family_id": None,
                    "family_name": None,
                    "family_member_id": None,
                    "member_index": member_index,
                    "person_index": None,
                    "valid": True,
                })
            continue

        names = member.get("family_members") or []
        person_ids = padded_family_member_ids(member)
        linked_user_ids = member.get("family_member_user_ids") or []
        for person_index, linked_user_id in enumerate(linked_user_ids):
            if linked_user_id != user_id:
                continue
            identities.append({
                "identity_type": "family_member",
                "member_id": member.get("id"),
                "member_name": (
                    names[person_index]
                    if person_index < len(names) and names[person_index]
                    else member.get("name") or "Trip member"
                ),
                "family_id": member.get("id"),
                "family_name": member.get("name") or "Family",
                "family_member_id": (
                    person_ids[person_index] if person_index < len(person_ids) else None
                ),
                "member_index": member_index,
                "person_index": person_index,
                "valid": person_index < len(names) and person_index < len(person_ids),
            })

        if member.get("user_id") == user_id:
            identities.append({
                "identity_type": "family_member",
                "member_id": member.get("id"),
                "member_name": member.get("name") or "Family",
                "family_id": member.get("id"),
                "family_name": member.get("name") or "Family",
                "family_member_id": None,
                "member_index": member_index,
                "person_index": None,
                "valid": False,
            })
    return identities


def resolve_linked_identity(trip: dict, user_id: str) -> Optional[dict]:
    identities = linked_identities(trip, user_id)
    if len(identities) != 1 or not identities[0].get("valid"):
        return None
    return identities[0]


def visible_linked_users(trip: dict) -> list[dict]:
    """Linked accounts in visible roster order, with the person name shown in the trip."""

    visible: list[dict] = []
    seen: set[str] = set()
    for member in trip.get("members", []) or []:
        if member.get("kind") != "family":
            user_id = member.get("user_id")
            if user_id and user_id not in seen:
                seen.add(user_id)
                visible.append({"user_id": user_id, "name": member.get("name") or "Trip member"})
            continue
        names = member.get("family_members") or []
        for index, user_id in enumerate(member.get("family_member_user_ids") or []):
            if not user_id or user_id in seen:
                continue
            seen.add(user_id)
            visible.append({
                "user_id": user_id,
                "name": names[index] if index < len(names) and names[index]
                else member.get("name") or "Trip member",
            })
        legacy_user_id = member.get("user_id")
        if legacy_user_id and legacy_user_id not in seen:
            seen.add(legacy_user_id)
            visible.append({
                "user_id": legacy_user_id,
                "name": member.get("name") or "Trip member",
            })
    return visible


async def _ownership_outcome(trip: dict, departing_user_id: str, *, session=None) -> dict:
    is_owner = trip.get("owner_id") == departing_user_id
    if not is_owner:
        return {
            "is_owner": False,
            "transfer_required": False,
            "successor": None,
            "requires_trip_deletion": False,
        }

    visible = [row for row in visible_linked_users(trip)
               if row["user_id"] != departing_user_id]
    visible_by_id = {row["user_id"]: row for row in visible}
    linked_ids = set(trip.get("user_ids") or []) & set(visible_by_id)
    admin_order = [
        user_id for user_id in (trip.get("admin_ids") or [])
        if user_id != departing_user_id and user_id in linked_ids
    ]
    roster_order = [row["user_id"] for row in visible if row["user_id"] in linked_ids]
    candidate_order = list(dict.fromkeys([*admin_order, *roster_order]))
    if not candidate_order:
        return {
            "is_owner": True,
            "transfer_required": True,
            "successor": None,
            "requires_trip_deletion": True,
        }

    options = _session_options(session)
    users = await db.users.find(
        {"id": {"$in": candidate_order}}, {"_id": 0, "id": 1}, **options
    ).to_list(length=None)
    live_ids = {row.get("id") for row in users}
    successor_id = next((user_id for user_id in candidate_order if user_id in live_ids), None)
    successor = None
    if successor_id:
        successor = {
            "user_id": successor_id,
            "name": visible_by_id[successor_id]["name"],
        }
    return {
        "is_owner": True,
        "transfer_required": True,
        "successor": successor,
        "requires_trip_deletion": successor is None,
    }


def _attempt_references_identity(attempt: dict, user_id: str, identity: dict) -> bool:
    if any(attempt.get(field) == user_id for field in ACCOUNT_REFERENCE_FIELDS):
        return True
    if identity.get("identity_type") == "individual":
        return identity.get("member_id") in {
            attempt.get("from_member_id"), attempt.get("to_member_id"),
        }
    return attempt.get("selected_recipient_person_id") == identity.get("family_member_id")


def _attempt_references_family(attempt: dict, identity: dict) -> bool:
    family_id = identity.get("family_id")
    return family_id in {attempt.get("from_member_id"), attempt.get("to_member_id")}


async def _active_attempt_flags(trip_id: str, user_id: str, identity: dict,
                                *, session=None) -> tuple[bool, bool]:
    options = _session_options(session)
    attempts = await db.payment_attempts.find(
        {"trip_id": trip_id, "status": {"$in": list(ACTIVE_PAYMENT_ATTEMPT_STATUSES)}},
        {"_id": 0},
        **options,
    ).to_list(length=None)
    timestamp = now_utc()
    attempts = [row for row in attempts if _is_nonexpired_attempt(row, timestamp)]
    references_user = any(
        _attempt_references_identity(row, user_id, identity) for row in attempts
    )
    references_family = identity.get("identity_type") == "family_member" and any(
        _attempt_references_family(row, identity) for row in attempts
    )
    return references_user, references_family


async def _active_account_attempts(user_id: str, *, session=None) -> list[dict]:
    """Return unresolved, non-expired attempts that directly reference the account.

    Account deletion is global, so checking only trips that still contain a roster link would miss
    an unresolved historical attempt after an administrator repaired or removed that link.
    """

    options = _session_options(session)
    rows = await db.payment_attempts.find(
        {
            "status": {"$in": list(ACTIVE_PAYMENT_ATTEMPT_STATUSES)},
            "$or": [{field: user_id} for field in ACCOUNT_REFERENCE_FIELDS],
        },
        {"_id": 0, "trip_id": 1, "expires_at": 1, "status": 1},
        **options,
    ).to_list(length=None)
    timestamp = now_utc()
    return [row for row in rows if _is_nonexpired_attempt(row, timestamp)]


def _family_balance_rows(balances: dict, family_id: str) -> list[dict]:
    family = next(
        (row for row in balances.get("per_person", []) if row.get("member_id") == family_id),
        None,
    )
    return list((family or {}).get("members") or [])


def _precise_entity_position(balances: dict, member_id: str) -> str:
    precise = (balances.get("settlement_projection") or {}).get("precise_net", {}).get(member_id)
    if precise is not None:
        return str(precise)
    return _decimal_text((balances.get("net") or {}).get(member_id, 0))


def _identity_payload(identity: dict) -> dict:
    return {
        "type": identity["identity_type"],
        "member_id": identity.get("member_id"),
        "member_name": identity.get("member_name"),
        "family_id": identity.get("family_id"),
        "family_name": identity.get("family_name"),
        "family_member_id": identity.get("family_member_id"),
    }


def _blocker(code: str, message: str, action: str, actions: Iterable[str]) -> dict:
    return {
        "code": code,
        "message": message,
        "resolution": action,
        "actions": list(actions),
    }


async def evaluate_trip(trip: dict, user_id: str, *, session=None) -> dict:
    """Build public impact plus private mutation context from one database snapshot."""

    trip_id = trip.get("id")
    identities = linked_identities(trip, user_id)
    ownership = await _ownership_outcome(trip, user_id, session=session)
    public = {
        "trip_id": trip_id,
        "trip_name": trip.get("name") or "Trip",
        "currency": str(trip.get("currency") or "INR").upper(),
        "identity": None,
        "position": None,
        "family_position": None,
        "unsettled_family_members": [],
        "settled": False,
        "leave_eligible": False,
        "dissolve_family_eligible": False,
        "requires_family_dissolution": False,
        "available_actions": ["keep"],
        "default_action": "keep",
        "active_payment_blocker": False,
        "ownership": ownership,
        "blockers": [],
    }
    if len(identities) != 1 or not identities[0].get("valid"):
        public["blockers"].append(_blocker(
            "eligibility_changed",
            "Your account is not linked to exactly one person in this trip. Ask a trip admin to repair the roster.",
            "review_membership",
            ("leave", "dissolve_family"),
        ))
        return {"public": public, "identity": None, "trip": trip,
                "active_user_attempt": False, "active_family_attempt": False}

    identity = identities[0]
    public["identity"] = _identity_payload(identity)
    balances = await _compute_balances(trip_id, diagnostic=False, session=session)
    entity_position = _precise_entity_position(balances, identity["member_id"])
    entity_settled = _decimal(entity_position) == 0
    active_user_attempt, active_family_attempt = await _active_attempt_flags(
        trip_id, user_id, identity, session=session,
    )

    family = None
    family_settled = True
    another_family_user = False
    if identity["identity_type"] == "family_member":
        family = (trip.get("members") or [])[identity["member_index"]]
        rows = _family_balance_rows(balances, identity["family_id"])
        unsettled_rows = [row for row in rows if _decimal(row.get("net", 0)) != 0]
        own_row = next(
            (row for row in rows if row.get("id") == identity.get("family_member_id")),
            None,
        )
        public["position"] = _decimal_text((own_row or {}).get("net", 0))
        public["family_position"] = entity_position
        public["unsettled_family_members"] = [
            {"id": row.get("id"), "name": row.get("name") or "Family member",
             "position": _decimal_text(row.get("net", 0))}
            for row in unsettled_rows
        ]
        family_settled = entity_settled and not unsettled_rows
        public["settled"] = family_settled
        names = family.get("family_members") or []
        public["requires_family_dissolution"] = len(names) <= 1
        another_family_user = any(
            linked_user_id and linked_user_id != user_id
            for linked_user_id in (family.get("family_member_user_ids") or [])
        ) or bool(family.get("user_id") and family.get("user_id") != user_id)
    else:
        public["position"] = entity_position
        public["settled"] = entity_settled

    if not public["settled"]:
        public["blockers"].append(_blocker(
            "membership_unsettled",
            "This membership must be settled exactly before it can leave.",
            "settle_up",
            ("leave", "dissolve_family"),
        ))
    if active_user_attempt:
        public["active_payment_blocker"] = True
        public["blockers"].append(_blocker(
            "active_payment_attempt",
            "Resolve the active UPI payment before changing this membership.",
            "resolve_payment",
            ("leave", "dissolve_family"),
        ))
    if ownership.get("requires_trip_deletion"):
        public["blockers"].append(_blocker(
            "owner_trip_requires_deletion",
            "No linked account can take ownership. Delete this trip first.",
            "delete_trip_first",
            ("leave", "dissolve_family", "keep"),
        ))

    ownership_ok = not ownership.get("requires_trip_deletion")
    base_leave = public["settled"] and not active_user_attempt and ownership_ok
    public["leave_eligible"] = base_leave and not public["requires_family_dissolution"]

    if identity["identity_type"] == "family_member":
        public["dissolve_family_eligible"] = bool(
            public["settled"]
            and not another_family_user
            and not active_user_attempt
            and not active_family_attempt
            and ownership_ok
        )
        if another_family_user:
            public["blockers"].append(_blocker(
                "family_dissolution_rejected",
                "This family cannot be dissolved while another linked app user remains.",
                "keep_family",
                ("dissolve_family",),
            ))
        elif active_family_attempt and not active_user_attempt:
            public["blockers"].append(_blocker(
                "active_payment_attempt",
                "Resolve the family's active UPI payment before dissolving it.",
                "resolve_payment",
                ("dissolve_family",),
            ))

    if public["leave_eligible"]:
        public["available_actions"].append("leave")
    if public["dissolve_family_eligible"]:
        public["available_actions"].append("dissolve_family")

    return {
        "public": public,
        "identity": identity,
        "trip": trip,
        "family": family,
        "another_family_user": another_family_user,
        "active_user_attempt": active_user_attempt,
        "active_family_attempt": active_family_attempt,
    }


def _linked_trip_query(user_id: str) -> dict:
    return {"$or": [
        {"user_ids": user_id},
        {"owner_id": user_id},
        {"admin_ids": user_id},
        {"members.user_id": user_id},
        {"members.family_member_user_ids": user_id},
    ]}


async def _linked_trips(user_id: str, *, session=None) -> list[dict]:
    options = _session_options(session)
    trips = await db.trips.find(_linked_trip_query(user_id), {"_id": 0}, **options).to_list(
        length=None
    )
    return sorted(
        trips,
        key=lambda row: (row.get("last_activity_at") or "", row.get("created_at") or "", row.get("id") or ""),
        reverse=True,
    )


async def account_deletion_impact(user: dict) -> dict:
    trips = await _linked_trips(user["id"])
    evaluations = [await evaluate_trip(trip, user["id"]) for trip in trips]
    active_account_attempts = await _active_account_attempts(user["id"])
    account_blockers = []
    if is_super_admin(user):
        account_blockers.append(_blocker(
            "super_admin_account_protected",
            "The fixed application super-admin account cannot be deleted.",
            "none",
            ("delete_account",),
        ))
    for evaluation in evaluations:
        if evaluation["identity"] is None:
            account_blockers.append(_blocker(
                "eligibility_changed",
                f"Repair the linked identity in {evaluation['public']['trip_name']} before deleting this account.",
                "review_membership",
                ("delete_account",),
            ))
        if evaluation["public"]["ownership"].get("requires_trip_deletion"):
            account_blockers.append(_blocker(
                "owner_trip_requires_deletion",
                f"Delete {evaluation['public']['trip_name']} before deleting this account.",
                "delete_trip_first",
                ("delete_account",),
            ))
    active_attempt_trip_ids = {
        row.get("trip_id") for row in active_account_attempts if row.get("trip_id")
    }
    active_attempt_trip_ids.update(
        evaluation["trip"].get("id")
        for evaluation in evaluations
        if evaluation.get("active_user_attempt") and evaluation["trip"].get("id")
    )
    if active_account_attempts or active_attempt_trip_ids:
        trip_names = {
            evaluation["trip"]["id"]: evaluation["public"]["trip_name"]
            for evaluation in evaluations
        }
        affected = list(dict.fromkeys(
            trip_names.get(trip_id, "another trip")
            for trip_id in sorted(active_attempt_trip_ids)
        ))
        if active_account_attempts and not affected:
            affected = ["another trip"]
        where = affected[0] if len(affected) == 1 else "your linked trips"
        account_blockers.append(_blocker(
            "active_payment_attempt",
            f"Resolve the active UPI payment in {where} first.",
            "resolve_payment",
            ("delete_account",),
        ))
    return {
        "account_deletion_allowed": not account_blockers,
        "blockers": account_blockers,
        "trips": [evaluation["public"] for evaluation in evaluations],
        "defaults": {"trip_action": "keep"},
        "privacy": {
            "deleted": [
                "Login credentials, email, mobile number, UPI details, devices, and tokens",
                "Live account links and account references",
            ],
            "retained": [
                "Trip and member names unless you leave or dissolve the family",
                "Expenses, balances, payment amounts, reports, and anonymized chat text",
            ],
        },
    }


async def membership_leave_impact(trip: dict, user_id: str) -> dict:
    return (await evaluate_trip(trip, user_id))["public"]


def _raise_action_block(evaluation: dict, action: str) -> None:
    public = evaluation["public"]
    trip_id = public["trip_id"]
    if evaluation.get("identity") is None:
        raise _conflict(
            "eligibility_changed",
            "Your linked trip identity changed. Refresh and review the membership again.",
            trip_id=trip_id,
            action=action,
        )
    if evaluation.get("active_user_attempt"):
        raise _conflict(
            "active_payment_attempt",
            "Resolve the active UPI payment before continuing.",
            trip_id=trip_id,
            action=action,
        )
    if not public.get("settled"):
        raise _conflict(
            "membership_unsettled",
            "This membership is not settled exactly. Settle up and try again.",
            trip_id=trip_id,
            action=action,
        )
    if public.get("ownership", {}).get("requires_trip_deletion"):
        raise _conflict(
            "owner_trip_requires_deletion",
            "No linked account can take ownership. Delete this trip first.",
            trip_id=trip_id,
            action=action,
            retryable=False,
        )
    if action == "leave" and public.get("requires_family_dissolution"):
        raise _conflict(
            "family_dissolution_required",
            "This is the family's only person, so the family must be dissolved to leave.",
            trip_id=trip_id,
            action=action,
            retryable=False,
        )
    if action == "dissolve_family":
        if evaluation["identity"].get("identity_type") != "family_member":
            raise _conflict(
                "family_dissolution_rejected",
                "An individual membership has no family to dissolve.",
                trip_id=trip_id,
                action=action,
                retryable=False,
            )
        if evaluation.get("another_family_user"):
            raise _conflict(
                "family_dissolution_rejected",
                "Another linked app user remains in this family.",
                trip_id=trip_id,
                action=action,
                retryable=False,
            )
        if evaluation.get("active_family_attempt"):
            raise _conflict(
                "active_payment_attempt",
                "Resolve the family's active UPI payment before dissolving it.",
                trip_id=trip_id,
                action=action,
            )
    raise _conflict(
        "eligibility_changed",
        "Departure eligibility changed. Refresh and review this trip again.",
        trip_id=trip_id,
        action=action,
    )


async def _apply_reallocation(trip_id: str, member_id: str, old_weight: int,
                              new_weight: int, *, session) -> None:
    if old_weight == new_weight:
        return
    options = _session_options(session)
    expenses = await db.expenses.find(
        {
            "trip_id": trip_id,
            "split_mode": {"$ne": "PER_FAMILY"},
            "$or": [{"split_member_ids": member_id}, {"split_member_ids": []}],
        },
        {"_id": 0},
        **options,
    ).to_list(length=None)
    plan = plan_reallocation(
        member_id, old_weight, new_weight, reweight_past=False, expenses=expenses,
    )
    operations = [
        UpdateOne(
            {"id": update["expense_id"], "trip_id": trip_id},
            {"$set": {
                "weight_snapshots": update["weight_snapshots"],
                "weight_frozen": update["weight_frozen"],
            }},
        )
        for update in plan["updates"]
    ]
    if operations:
        await db.expenses.bulk_write(operations, session=session)


async def _snapshot_exact_family_people(trip_id: str, family_id: str,
                                        family_member_ids: Iterable[str], *, session) -> None:
    for person_id in family_member_ids:
        if not person_id:
            continue
        # Stable UUID-style family member IDs are safe Mongo dotted-path keys. The snapshot is
        # ledger-only: it preserves how old EXACT allocations roll up after the visible row leaves.
        await db.expenses.update_many(
            {
                "trip_id": trip_id,
                "split_mode": "EXACT",
                f"custom_amounts.{person_id}": {"$exists": True},
            },
            {"$set": {f"family_member_entity_snapshots.{person_id}": family_id}},
            session=session,
        )


async def _snapshot_implicit_split_roster(trip: dict, *, session) -> None:
    """Freeze legacy "split among everyone" rows before a whole entity disappears.

    An empty or missing ``split_member_ids`` is evaluated against the live roster. Replacing it with
    the current stable entity IDs immediately before removal keeps every historical participant in
    the ledger and lets the canonical engine prove that the departing entity remains exactly zero.
    """

    member_ids = [str(member["id"]) for member in (trip.get("members") or [])]
    if not member_ids:
        return
    await db.expenses.update_many(
        {
            "trip_id": trip["id"],
            "$or": [
                {"split_member_ids": []},
                {"split_member_ids": None},
                {"split_member_ids": {"$exists": False}},
            ],
        },
        {"$set": {"split_member_ids": member_ids}},
        session=session,
    )


def _detached_members(trip: dict, identity: dict) -> list[dict]:
    members = deepcopy(trip.get("members") or [])
    member = members[identity["member_index"]]
    if identity["identity_type"] == "individual":
        member["email"] = None
        member["user_id"] = None
        member.pop("mobile_number", None)
        return members

    names = member.get("family_members") or []
    ids = padded_family_member_ids(member)
    emails = align_family_member_emails(names, existing=member.get("family_member_emails"))
    user_ids, _ = align_family_member_user_ids(
        ids, member.get("family_member_ids"), member.get("family_member_user_ids"),
    )
    index = identity["person_index"]
    emails[index] = None
    user_ids[index] = None
    member["family_member_ids"] = ids
    member["family_member_emails"] = emails
    member["family_member_user_ids"] = user_ids
    mobile_numbers = list(member.get("family_member_mobile_numbers") or [])
    if mobile_numbers:
        mobile_numbers.extend([None] * max(0, len(names) - len(mobile_numbers)))
        mobile_numbers[index] = None
        member["family_member_mobile_numbers"] = mobile_numbers[:len(names)]
    return members


async def _departure_members(trip: dict, identity: dict, action: str, *, session) -> list[dict]:
    members = deepcopy(trip.get("members") or [])
    member = members[identity["member_index"]]
    trip_id = trip["id"]
    if identity["identity_type"] == "individual" or action == "dissolve_family":
        await _snapshot_implicit_split_roster(trip, session=session)
        weight = max(1, len(member.get("family_members") or [])) \
            if member.get("kind") == "family" else 1
        if member.get("kind") == "family":
            await _snapshot_exact_family_people(
                trip_id, member["id"], padded_family_member_ids(member), session=session,
            )
        await _apply_reallocation(trip_id, member["id"], weight, 0, session=session)
        return [row for index, row in enumerate(members) if index != identity["member_index"]]

    names = member.get("family_members") or []
    ids = padded_family_member_ids(member)
    index = identity["person_index"]
    await _snapshot_exact_family_people(
        trip_id, member["id"], [identity["family_member_id"]], session=session,
    )
    emails = align_family_member_emails(names, existing=member.get("family_member_emails"))
    user_ids, _ = align_family_member_user_ids(
        ids, member.get("family_member_ids"), member.get("family_member_user_ids"),
    )
    new_names = [value for i, value in enumerate(names) if i != index]
    new_ids = [value for i, value in enumerate(ids) if i != index]
    member["family_members"] = new_names
    member["family_member_ids"] = assign_family_member_ids(new_names, new_ids)
    member["family_member_emails"] = [value for i, value in enumerate(emails) if i != index]
    member["family_member_user_ids"] = [value for i, value in enumerate(user_ids) if i != index]
    if "family_member_mobile_numbers" in member:
        mobile_numbers = list(member.get("family_member_mobile_numbers") or [])
        mobile_numbers.extend([None] * max(0, len(names) - len(mobile_numbers)))
        member["family_member_mobile_numbers"] = [
            value for i, value in enumerate(mobile_numbers[:len(names)]) if i != index
        ]
    await _apply_reallocation(
        trip_id, member["id"], max(1, len(names)), max(1, len(new_names)), session=session,
    )
    return members


def _roles_after_departure(trip: dict, user_id: str, ownership: dict) -> tuple[list, list, str]:
    user_ids = [value for value in (trip.get("user_ids") or []) if value != user_id]
    admin_ids = [value for value in (trip.get("admin_ids") or []) if value != user_id]
    owner_id = trip.get("owner_id")
    successor = ownership.get("successor")
    if owner_id == user_id:
        if not successor:
            raise _conflict(
                "owner_trip_requires_deletion",
                "No linked account can take ownership. Delete this trip first.",
                trip_id=trip.get("id"),
                retryable=False,
            )
        owner_id = successor["user_id"]
        if owner_id not in admin_ids:
            admin_ids.append(owner_id)
    return user_ids, admin_ids, owner_id


async def _write_trip_membership(evaluation: dict, user_id: str, action: str,
                                 *, session) -> None:
    trip = evaluation["trip"]
    identity = evaluation["identity"]
    if action == "keep":
        members = _detached_members(trip, identity)
    else:
        members = await _departure_members(trip, identity, action, session=session)
    user_ids, admin_ids, owner_id = _roles_after_departure(
        trip, user_id, evaluation["public"]["ownership"],
    )
    version = trip.get("version", 0)
    version_filter = {"id": trip["id"]}
    if "version" in trip:
        version_filter["version"] = version
    result = await db.trips.update_one(
        version_filter,
        {
            "$set": {
                "members": members,
                "user_ids": user_ids,
                "admin_ids": admin_ids,
                "owner_id": owner_id,
                "last_activity_at": now_utc().isoformat(),
            },
            "$inc": {"version": 1},
        },
        session=session,
    )
    matched = getattr(result, "matched_count", 1)
    if matched == 0:
        raise _conflict(
            "eligibility_changed",
            "This trip changed while eligibility was being checked. Refresh and try again.",
            trip_id=trip["id"],
            action=action,
        )


def _scoped(trip_id: Optional[str], extra: Optional[dict] = None) -> dict:
    query = {"trip_id": trip_id} if trip_id is not None else {}
    if extra:
        query.update(extra)
    return query


def _chat_tombstone(trip_id: str, user_id: str) -> str:
    digest = hashlib.sha256(f"trip-departure:{trip_id}:{user_id}".encode("utf-8")).hexdigest()
    return f"deleted-user:{digest[:32]}"


async def _anonymize_chat(user_id: str, *, trip_id: Optional[str], session) -> None:
    options = _session_options(session)
    query = _scoped(trip_id, {"sender_user_id": user_id})
    rows = await db.chat_messages.find(query, {"_id": 0, "trip_id": 1}, **options).to_list(
        length=None
    )
    trip_ids = sorted({row.get("trip_id") for row in rows if row.get("trip_id")})
    for message_trip_id in trip_ids:
        await db.chat_messages.update_many(
            {"trip_id": message_trip_id, "sender_user_id": user_id},
            {
                "$set": {
                    "sender_user_id": _chat_tombstone(message_trip_id, user_id),
                    "sender_name": "Deleted user",
                },
                "$unset": {
                    "sender_person_id": "",
                    "sender_family_id": "",
                    "sender_family_name": "",
                },
            },
            session=session,
        )


async def _scrub_notification_records(user_id: str, *, trip_id: Optional[str], session) -> None:
    scope = _scoped(trip_id)
    await db.notification_outbox.update_many(
        {**scope, "actor_user_id": user_id},
        {"$unset": {"actor_user_id": "", "actor_name": ""}},
        session=session,
    )
    # The field is nullable on ordinary events, so only apply $pull to documents Mongo matched as
    # arrays containing the value. Delivery rows are removed whole, erasing their copied token.
    await db.notification_outbox.update_many(
        {**scope, "recipient_user_ids": user_id},
        {"$pull": {"recipient_user_ids": user_id}},
        session=session,
    )
    await db.notification_outbox.update_many(
        {**scope, "deliveries.user_id": user_id},
        {"$pull": {"deliveries": {"user_id": user_id}}},
        session=session,
    )


async def _scrub_payment_attempts(user_id: str, identity: Optional[dict], *,
                                  trip_id: Optional[str], session) -> None:
    scope = _scoped(trip_id)
    snapshot_conditions: list[dict] = [
        {field: user_id} for field in ACCOUNT_REFERENCE_FIELDS
    ]
    if identity:
        person_id = identity.get("family_member_id") or (
            identity.get("member_id") if identity.get("identity_type") == "individual" else None
        )
        if person_id:
            snapshot_conditions.append({"selected_recipient_person_id": person_id})
    await db.payment_attempts.update_many(
        {**scope, "$or": snapshot_conditions},
        {"$unset": {"upi_id_snapshot": "", "upi_updated_at_snapshot": ""}},
        session=session,
    )
    for field in ACCOUNT_REFERENCE_FIELDS:
        await db.payment_attempts.update_many(
            {**scope, field: user_id}, {"$unset": {field: ""}}, session=session,
        )


async def _scrub_account_references(user: dict, *, trip_id: Optional[str],
                                    identity: Optional[dict], session) -> None:
    """Remove direct account data globally, or only within one departing trip."""

    user_id = user["id"]
    email = user.get("email")
    scope = _scoped(trip_id)
    await _anonymize_chat(user_id, trip_id=trip_id, session=session)
    await db.chat_reads.delete_many({**scope, "user_id": user_id}, session=session)
    await db.trip_mobile_claims.delete_many({**scope, "user_id": user_id}, session=session)

    await db.expenses.update_many(
        {**scope, "created_by": user_id}, {"$unset": {"created_by": ""}}, session=session,
    )
    await db.settlements.update_many(
        {**scope, "$or": [
            {"recorded_by": user_id}, {"marked_paid_by": user_id},
        ]},
        {"$unset": {"recorded_by": "", "marked_paid_by": ""}},
        session=session,
    )
    await db.payments.update_many(
        {**scope, "recorded_by": user_id}, {"$unset": {"recorded_by": ""}}, session=session,
    )
    await _scrub_payment_attempts(
        user_id, identity, trip_id=trip_id, session=session,
    )
    await db["receipts.files"].update_many(
        ({"metadata.trip_id": trip_id, "metadata.uploaded_by": user_id}
         if trip_id is not None else {"metadata.uploaded_by": user_id}),
        {"$unset": {"metadata.uploaded_by": ""}},
        session=session,
    )

    await db.money_normalization_audits.update_many(
        {**scope, "actor_user_id": user_id},
        {"$unset": {"actor_user_id": ""}},
        session=session,
    )
    await db.admin_audit_logs.update_many(
        {**scope, "actor_user_id": user_id},
        {"$unset": {"actor_user_id": "", "actor_email": ""}},
        session=session,
    )
    await db.admin_audit_logs.update_many(
        {**scope, "resource_id": user_id},
        {"$unset": {"resource_id": ""}},
        session=session,
    )
    await db.trip_invites.update_many(
        {**scope, "revoked_by": user_id},
        {"$unset": {"revoked_by": ""}},
        session=session,
    )
    await _scrub_notification_records(user_id, trip_id=trip_id, session=session)

    await db.join_requests.delete_many(
        {**scope, "requester_user_id": user_id}, session=session,
    )
    await db.join_requests.update_many(
        {**scope, "decided_by_user_id": user_id},
        {"$unset": {"decided_by_user_id": ""}},
        session=session,
    )
    if email:
        await db.join_requests.update_many(
            {**scope, "target_email_before": email},
            {"$unset": {"target_email_before": ""}},
            session=session,
        )

    quote_query = {"user_id": user_id}
    if trip_id is not None:
        quote_query["payment_handoff.trip_id"] = trip_id
    await db.exchange_rate_quotes.delete_many(quote_query, session=session)


async def _run_destructive_transaction(callback):
    try:
        return await run_required_transaction(callback)
    except TransactionUnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail=_detail(
                "transactions_unavailable",
                "Account and membership changes are temporarily unavailable because atomic database transactions are required.",
                retryable=True,
            ),
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        if is_retryable_transaction_error(exc):
            raise _conflict(
                "eligibility_changed",
                "Trip data changed while the request was being committed. Refresh and try again.",
            ) from exc
        raise


async def leave_membership(trip_id: str, user: dict, *, dissolve_family: bool) -> dict:
    action = "dissolve_family" if dissolve_family else "leave"

    async def transaction(session):
        trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
        if not trip or user["id"] not in (trip.get("user_ids") or []):
            raise _conflict(
                "eligibility_changed",
                "This membership changed. Refresh your trips and try again.",
                trip_id=trip_id,
                action=action,
            )
        evaluation = await evaluate_trip(trip, user["id"], session=session)
        eligible_key = "dissolve_family_eligible" if dissolve_family else "leave_eligible"
        if not evaluation["public"].get(eligible_key):
            _raise_action_block(evaluation, action)
        await _write_trip_membership(evaluation, user["id"], action, session=session)
        await _scrub_account_references(
            user, trip_id=trip_id, identity=evaluation["identity"], session=session,
        )
        return {"ok": True, "trip_id": trip_id, "action": action}

    return await _run_destructive_transaction(transaction)


async def delete_account(user: dict, *, confirmation: str, acknowledge_unsettled: bool,
                         trip_actions: Iterable[dict]) -> dict:
    if confirmation != "DELETE":
        raise HTTPException(
            status_code=400,
            detail=_detail(
                "invalid_confirmation", 'Type uppercase "DELETE" exactly to continue.',
                retryable=False,
            ),
        )
    if is_super_admin(user):
        raise HTTPException(
            status_code=403,
            detail=_detail(
                "super_admin_account_protected",
                "The fixed application super-admin account cannot be deleted.",
                retryable=False,
            ),
        )

    requested_actions: dict[str, str] = {}
    for item in trip_actions:
        payload = item if isinstance(item, dict) else item.model_dump()
        requested_actions[payload["trip_id"]] = payload["action"]

    async def transaction(session):
        current_user = await db.users.find_one({"id": user["id"]}, {"_id": 0}, session=session)
        if not current_user:
            raise _conflict(
                "eligibility_changed",
                "This account was already removed or changed. Sign in again to continue.",
                retryable=False,
            )
        if is_super_admin(current_user):
            raise HTTPException(
                status_code=403,
                detail=_detail(
                    "super_admin_account_protected",
                    "The fixed application super-admin account cannot be deleted.",
                    retryable=False,
                ),
            )

        trips = await _linked_trips(user["id"], session=session)
        linked_trip_ids = {trip["id"] for trip in trips}
        unknown_trip_ids = sorted(set(requested_actions) - linked_trip_ids)
        if unknown_trip_ids:
            raise _conflict(
                "eligibility_changed",
                "One or more selected trips are no longer linked to this account. Refresh and review again.",
            )

        evaluations = []
        for trip in trips:
            evaluation = await evaluate_trip(trip, user["id"], session=session)
            if evaluation["identity"] is None:
                _raise_action_block(evaluation, requested_actions.get(trip["id"], "keep"))
            if evaluation["active_user_attempt"]:
                raise _conflict(
                    "active_payment_attempt",
                    f"Resolve the active UPI payment in {evaluation['public']['trip_name']} first.",
                    trip_id=trip["id"],
                )
            if evaluation["public"]["ownership"].get("requires_trip_deletion"):
                raise _conflict(
                    "owner_trip_requires_deletion",
                    f"Delete {evaluation['public']['trip_name']} before deleting this account.",
                    trip_id=trip["id"],
                    retryable=False,
                )
            action = requested_actions.get(trip["id"], "keep")
            if action == "leave" and not evaluation["public"].get("leave_eligible"):
                _raise_action_block(evaluation, action)
            if action == "dissolve_family" and not evaluation["public"].get(
                "dissolve_family_eligible"
            ):
                _raise_action_block(evaluation, action)
            evaluations.append((evaluation, action))

        if await _active_account_attempts(user["id"], session=session):
            raise _conflict(
                "active_payment_attempt",
                "Resolve every active UPI payment before deleting this account.",
            )

        retained_unsettled = [
            evaluation["public"]["trip_name"]
            for evaluation, action in evaluations
            if action == "keep" and not evaluation["public"].get("settled")
        ]
        if retained_unsettled and not acknowledge_unsettled:
            raise _conflict(
                "unsettled_acknowledgement_required",
                "Acknowledge that retained trip positions may remain unsettled.",
                retryable=False,
            )

        kept_trip_ids: list[str] = []
        departed_trip_ids: list[str] = []
        for evaluation, action in evaluations:
            await _write_trip_membership(evaluation, user["id"], action, session=session)
            # Preserve enough pre-write identity context to remove terminal attempt snapshots that
            # refer only to a stable member/person ID. The global pass below then catches every
            # direct account reference, including records from trips no longer linked to the user.
            await _scrub_account_references(
                current_user,
                trip_id=evaluation["trip"]["id"],
                identity=evaluation["identity"],
                session=session,
            )
            if action == "keep":
                kept_trip_ids.append(evaluation["trip"]["id"])
            else:
                departed_trip_ids.append(evaluation["trip"]["id"])

        # Global cleanup also covers historical rows in trips the account no longer belongs to.
        await _scrub_account_references(
            current_user, trip_id=None, identity=None, session=session,
        )
        await db.auth_tokens.delete_many({"user_id": user["id"]}, session=session)
        await db.password_reset_tokens.delete_many({"user_id": user["id"]}, session=session)
        await db.push_devices.delete_many({"user_id": user["id"]}, session=session)
        deleted = await db.users.delete_one({"id": user["id"]}, session=session)
        if getattr(deleted, "deleted_count", 1) == 0:
            raise _conflict(
                "eligibility_changed",
                "The account changed while deletion was being committed. Try signing in again.",
            )
        return {
            "ok": True,
            "kept_trip_ids": kept_trip_ids,
            "departed_trip_ids": departed_trip_ids,
        }

    return await _run_destructive_transaction(transaction)
