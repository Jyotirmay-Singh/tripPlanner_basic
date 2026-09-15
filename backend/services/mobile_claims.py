"""Per-trip mobile-number claims and privacy-safe trip enrichment.

The claim collection is the concurrency guard for the rule that one mobile number may identify
only one linked app user inside a trip. Numbers remain account-global data; claim rows only project
that data into trips where the account is linked to a specific person.
"""

from copy import deepcopy
from dataclasses import dataclass
import logging
from typing import Iterable, Optional

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from database import db
from services.ledger_transactions import run_optional_transaction
from utils.common import now_utc
from utils.members import padded_family_member_ids


logger = logging.getLogger(__name__)


@dataclass
class ClaimReservation:
    before: Optional[dict]
    after: Optional[dict]
    changed: bool


def linked_identity(trip: dict, user_id: str) -> Optional[dict]:
    """Resolve one linked account to its exact person slot in a trip."""
    for member in trip.get("members", []) or []:
        if member.get("kind") != "family":
            if member.get("user_id") == user_id:
                return {
                    "member_id": member.get("id"),
                    "family_member_id": None,
                    "member_name": member.get("name") or "Trip member",
                }
            continue

        names = member.get("family_members") or []
        ids = padded_family_member_ids(member)
        user_ids = member.get("family_member_user_ids") or []
        for index, linked_user_id in enumerate(user_ids):
            if linked_user_id == user_id:
                return {
                    "member_id": member.get("id"),
                    "family_member_id": ids[index] if index < len(ids) else None,
                    "member_name": names[index] if index < len(names)
                    else member.get("name") or "Trip member",
                }

        # Tolerate a legacy family entity link until the startup migration demotes it.
        if member.get("user_id") == user_id:
            return {
                "member_id": member.get("id"),
                "family_member_id": None,
                "member_name": member.get("name") or "Trip member",
            }
    return None


def _claim_document(trip: dict, user: dict, identity: Optional[dict]) -> Optional[dict]:
    mobile_number = user.get("mobile_number")
    if not mobile_number or not identity:
        return None
    return {
        "trip_id": trip["id"],
        "user_id": user["id"],
        "mobile_number": mobile_number,
        "member_id": identity.get("member_id"),
        "family_member_id": identity.get("family_member_id"),
        "member_name": identity.get("member_name") or "Trip member",
        "updated_at": now_utc().isoformat(),
    }


def _member_name_for_claim(trip: dict, claim: Optional[dict]) -> str:
    if not claim:
        return "another member"
    member = next(
        (row for row in trip.get("members", []) if row.get("id") == claim.get("member_id")),
        None,
    )
    if member and claim.get("family_member_id"):
        ids = padded_family_member_ids(member)
        if claim["family_member_id"] in ids:
            index = ids.index(claim["family_member_id"])
            names = member.get("family_members") or []
            if index < len(names) and names[index]:
                return names[index]
    if member and member.get("name"):
        return member["name"]
    return claim.get("member_name") or "another member"


def _mobile_conflict(trip: dict, claim: Optional[dict]) -> HTTPException:
    member_name = _member_name_for_claim(trip, claim)
    trip_name = trip.get("name") or "this trip"
    return HTTPException(409, detail={
        "code": "trip_mobile_conflict",
        "message": f"This mobile number is already used by {member_name} in {trip_name}.",
        "trip_id": trip.get("id"),
        "trip_name": trip_name,
        "member_name": member_name,
        "retryable": False,
    })


async def _find_claim(query: dict, session=None) -> Optional[dict]:
    kwargs = {"session": session} if session is not None else {}
    return await db.trip_mobile_claims.find_one(query, {"_id": 0}, **kwargs)


async def sync_mobile_claim(
    trip: dict,
    user: dict,
    identity: Optional[dict] = None,
    *,
    session=None,
) -> ClaimReservation:
    """Idempotently make one user's claim match their current profile and trip identity."""
    identity = identity if identity is not None else linked_identity(trip, user["id"])
    desired = _claim_document(trip, user, identity)
    query = {"trip_id": trip["id"], "user_id": user["id"]}
    before = await _find_claim(query, session)
    kwargs = {"session": session} if session is not None else {}

    if desired is None:
        if before is None:
            return ClaimReservation(None, None, False)
        await db.trip_mobile_claims.delete_one(query, **kwargs)
        return ClaimReservation(before, None, True)

    comparable_fields = (
        "trip_id", "user_id", "mobile_number", "member_id", "family_member_id", "member_name",
    )
    if before and all(before.get(field) == desired.get(field) for field in comparable_fields):
        return ClaimReservation(before, before, False)

    try:
        await db.trip_mobile_claims.replace_one(query, desired, upsert=True, **kwargs)
    except DuplicateKeyError as exc:
        conflict = await _find_claim({
            "trip_id": trip["id"],
            "mobile_number": desired["mobile_number"],
            "user_id": {"$ne": user["id"]},
        }, session)
        raise _mobile_conflict(trip, conflict) from exc
    return ClaimReservation(before, desired, True)


async def rollback_claim(reservation: ClaimReservation, *, session=None) -> None:
    """Compensate a reservation without overwriting a newer concurrent value."""
    if not reservation.changed:
        return
    current = reservation.after
    before = reservation.before
    anchor = current or before
    if not anchor:
        return
    query = {"trip_id": anchor["trip_id"], "user_id": anchor["user_id"]}
    if current and current.get("mobile_number"):
        query["mobile_number"] = current["mobile_number"]
    kwargs = {"session": session} if session is not None else {}
    if before is None:
        await db.trip_mobile_claims.delete_one(query, **kwargs)
    elif current is None:
        try:
            await db.trip_mobile_claims.insert_one(before, **kwargs)
        except DuplicateKeyError:
            logger.warning("Mobile-claim compensation encountered a concurrent trip conflict")
    else:
        try:
            await db.trip_mobile_claims.replace_one(query, before, upsert=False, **kwargs)
        except DuplicateKeyError:
            logger.warning("Mobile-claim compensation encountered a concurrent trip conflict")


async def reserve_linked_mobile(
    trip: dict,
    user: dict,
    *,
    member_id: str,
    member_name: str,
    family_member_id: Optional[str] = None,
) -> ClaimReservation:
    """Reserve the user's number before a join/claim writes the linked roster slot."""
    return await sync_mobile_claim(trip, user, {
        "member_id": member_id,
        "family_member_id": family_member_id,
        "member_name": member_name,
    })


async def release_user_claims(trip_id: str, user_ids: Iterable[Optional[str]]) -> None:
    ids = sorted({value for value in user_ids if value})
    if ids:
        await db.trip_mobile_claims.delete_many({"trip_id": trip_id, "user_id": {"$in": ids}})


async def release_trip_claims(trip_id: str) -> None:
    await db.trip_mobile_claims.delete_many({"trip_id": trip_id})


def _user_mobile_write(mobile_number: Optional[str], country_code: Optional[str]) -> dict:
    return {"$set": {
        "mobile_number": mobile_number,
        "mobile_country_code": country_code,
        # Reserved for a future OTP flow. Any profile mutation invalidates prior metadata.
        "mobile_verified_at": None,
    }}


async def update_account_mobile(
    user: dict,
    mobile_number: Optional[str],
    country_code: Optional[str],
) -> dict:
    """Update the profile and all of its trip claims as one logical operation.

    Transaction-capable deployments update atomically. Standalone MongoDB uses ordered,
    idempotent reservations and compensates every earlier claim if a later operation fails.
    """
    if (
        user.get("mobile_number") == mobile_number
        and user.get("mobile_country_code") == country_code
    ):
        return user

    trips = await db.trips.find(
        {"user_ids": user["id"]}, {"_id": 0}
    ).to_list(length=None)
    # A stable order avoids cross-trip lock inversion when two shared-trip users attempt the same
    # number concurrently on standalone MongoDB. The unique index still makes the first reservation
    # the concurrency winner; deterministic ordering prevents both updates from partially advancing.
    trips.sort(key=lambda trip: trip.get("id", ""))
    candidate = {
        **user,
        "mobile_number": mobile_number,
        "mobile_country_code": country_code,
        "mobile_verified_at": None,
    }
    update = _user_mobile_write(mobile_number, country_code)

    async def transactional(session):
        for trip in trips:
            await sync_mobile_claim(trip, candidate, session=session)
        result = await db.users.update_one({"id": user["id"]}, update, session=session)
        if getattr(result, "matched_count", 1) == 0:
            raise HTTPException(401, "User not found")
        return await db.users.find_one(
            {"id": user["id"]},
            {"_id": 0, "password_hash": 0, "pin_hash": 0},
            session=session,
        )

    async def standalone():
        reservations: list[ClaimReservation] = []
        try:
            for trip in trips:
                reservations.append(await sync_mobile_claim(trip, candidate))
            result = await db.users.update_one({"id": user["id"]}, update)
            if getattr(result, "matched_count", 1) == 0:
                raise HTTPException(401, "User not found")
        except Exception:
            for reservation in reversed(reservations):
                try:
                    await rollback_claim(reservation)
                except Exception:
                    logger.error("Mobile-claim compensation failed; reconciliation will retry")
            raise
        return await db.users.find_one(
            {"id": user["id"]}, {"_id": 0, "password_hash": 0, "pin_hash": 0}
        )

    updated = await run_optional_transaction(transactional, standalone)
    if not updated:
        raise HTTPException(401, "User not found")
    return updated


async def enrich_trip_mobile_numbers(trip: dict) -> dict:
    """Add contact fields to an already-authorized trip-detail payload only."""
    enriched = deepcopy(trip)
    claims = await db.trip_mobile_claims.find(
        {"trip_id": trip["id"]}, {"_id": 0}
    ).to_list(length=None)
    by_user = {claim.get("user_id"): claim for claim in claims if claim.get("user_id")}

    for member in enriched.get("members", []) or []:
        if member.get("kind") != "family":
            claim = by_user.get(member.get("user_id"))
            member["mobile_number"] = (
                claim.get("mobile_number")
                if claim and claim.get("member_id") == member.get("id")
                and not claim.get("family_member_id")
                else None
            )
            continue

        names = member.get("family_members") or []
        member_ids = padded_family_member_ids(member)
        user_ids = member.get("family_member_user_ids") or []
        mobile_numbers: list[Optional[str]] = []
        for index in range(len(names)):
            claim = by_user.get(user_ids[index] if index < len(user_ids) else None)
            mobile_numbers.append(
                claim.get("mobile_number")
                if claim
                and claim.get("member_id") == member.get("id")
                and index < len(member_ids)
                and claim.get("family_member_id") == member_ids[index]
                else None
            )
        member["family_member_mobile_numbers"] = mobile_numbers
    return enriched


async def reconcile_mobile_claims() -> dict:
    """Idempotently repair claims after standalone interruption or a legacy rollout."""
    trips = await db.trips.find(
        {}, {"_id": 0, "id": 1, "name": 1, "members": 1, "user_ids": 1}
    ).to_list(length=None)
    desired: dict[tuple[str, str], Optional[dict]] = {}
    conflicts = 0
    repaired = 0

    for trip in sorted(trips, key=lambda row: row.get("id", "")):
        identities: list[tuple[str, dict]] = []
        for user_id in trip.get("user_ids", []) or []:
            identity = linked_identity(trip, user_id)
            if identity:
                identities.append((user_id, identity))
        if not identities:
            continue
        user_ids = [user_id for user_id, _identity in identities]
        users = await db.users.find(
            {"id": {"$in": user_ids}},
            {"_id": 0, "id": 1, "mobile_number": 1, "mobile_country_code": 1},
        ).to_list(length=None)
        users_by_id = {row["id"]: row for row in users}
        for user_id, identity in identities:
            profile = users_by_id.get(user_id, {"id": user_id})
            desired_doc = _claim_document(trip, profile, identity)
            desired[(trip["id"], user_id)] = desired_doc
            try:
                reservation = await sync_mobile_claim(trip, profile, identity)
                repaired += int(reservation.changed)
            except HTTPException as exc:
                if exc.status_code != 409:
                    raise
                conflicts += 1

    existing = await db.trip_mobile_claims.find({}, {"_id": 0}).to_list(length=None)
    for claim in existing:
        expected = desired.get((claim.get("trip_id"), claim.get("user_id")))
        fields = ("mobile_number", "member_id", "family_member_id")
        if expected is not None and all(
            claim.get(field) == expected.get(field) for field in fields
        ):
            continue
        await db.trip_mobile_claims.delete_one({
            "trip_id": claim.get("trip_id"),
            "user_id": claim.get("user_id"),
            "mobile_number": claim.get("mobile_number"),
        })
        repaired += 1

    if conflicts:
        logger.warning("Mobile-claim reconciliation found %d trip conflict(s)", conflicts)
    return {"repaired": repaired, "conflicts": conflicts}
