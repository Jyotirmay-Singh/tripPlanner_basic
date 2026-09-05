"""Hashed, revocable, expiring links for joining a trip.

Raw invite tokens are returned once and never persisted or logged. The legacy trip code remains
supported as a separate credential for backward compatibility.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from config import INVITE_BASE_URL, INVITE_LINKS_ENABLED
from database import db
from utils.common import gen_id, now_utc


INVITE_TTL = timedelta(days=7)
AUDIT_RETENTION = timedelta(days=90)
logger = logging.getLogger(__name__)


def hash_invite_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def invite_status(document: dict, *, now: Optional[datetime] = None) -> str:
    if document.get("revoked_at"):
        return "revoked"
    current = now or now_utc()
    if _as_utc(document["expires_at"]) <= current:
        return "expired"
    # ``active`` is an index-maintenance field rather than the source of expiry truth.  Legacy
    # records have no such field and remain valid until the startup migration normalizes them.
    if document.get("active") is False:
        return "revoked"
    return "active"


def _iso(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return _as_utc(value).isoformat()


def invite_metadata(document: dict) -> dict:
    return {
        "id": document["id"],
        "created_by": document["created_by"],
        "created_by_name": document.get("created_by_name"),
        "created_at": _iso(document["created_at"]),
        "expires_at": _iso(document["expires_at"]),
        "status": invite_status(document),
        "revoked_at": _iso(document.get("revoked_at")),
        "revoked_by": document.get("revoked_by"),
        "revocation_reason": document.get("revocation_reason"),
        "use_count": document.get("use_count", 0),
        "last_used_at": _iso(document.get("last_used_at")),
    }


async def create_invite(trip: dict, user: dict) -> dict:
    """Rotate and return the caller's only active invite for this trip.

    The raw bearer token exists only in this function and its one-time response.  Mongo stores the
    SHA-256 digest.  The partial unique index installed at startup is the final concurrency guard if
    two devices try to rotate the same member's link at once.
    """
    raw = secrets.token_urlsafe(32)
    timestamp = now_utc()
    created_by = user["id"]
    await db.trip_invites.update_many(
        {"trip_id": trip["id"], "created_by": created_by, "revoked_at": None},
        {"$set": {
            "active": False,
            "revoked_at": timestamp,
            "revoked_by": created_by,
            "revocation_reason": "rotated",
            "audit_expires_at": timestamp + AUDIT_RETENTION,
        }},
    )
    document = {
        "id": gen_id(),
        "trip_id": trip["id"],
        "trip_name": trip.get("name"),
        "token_hash": hash_invite_token(raw),
        "created_by": created_by,
        "created_by_name": str(user.get("name") or user.get("email") or "Trip member"),
        "created_at": timestamp,
        "expires_at": timestamp + INVITE_TTL,
        "audit_expires_at": timestamp + INVITE_TTL + AUDIT_RETENTION,
        "revoked_at": None,
        "revoked_by": None,
        "revocation_reason": None,
        "active": True,
        "use_count": 0,
        "last_used_at": None,
    }
    try:
        await db.trip_invites.insert_one(document)
    except DuplicateKeyError as error:
        logger.info(
            "invite.rotation_conflict trip_id=%s created_by=%s", trip["id"], created_by,
        )
        raise HTTPException(
            409,
            detail={
                "code": "invite_rotation_conflict",
                "message": "Another invite link was created at the same time. Please try sharing again.",
                "retryable": True,
            },
        ) from error
    logger.info(
        "invite.created invite_id=%s trip_id=%s created_by=%s expires_at=%s",
        document["id"], trip["id"], created_by, _iso(document["expires_at"]),
    )
    payload = invite_metadata(document)
    payload["url"] = f"{INVITE_BASE_URL}/invite/{raw}"
    return payload


async def list_invites(trip_id: str, *, created_by: Optional[str] = None) -> list[dict]:
    query = {"trip_id": trip_id}
    if created_by:
        query["created_by"] = created_by
    cursor = db.trip_invites.find(query, {"_id": 0}).sort("created_at", -1)
    return [invite_metadata(row) for row in await cursor.to_list(100)]


async def revoke_invite(
    trip_id: str,
    invite_id: str,
    revoked_by: str,
    *,
    can_revoke_all: bool = False,
) -> dict:
    timestamp = now_utc()
    authorized = {"id": invite_id, "trip_id": trip_id}
    if not can_revoke_all:
        authorized["created_by"] = revoked_by
    document = await db.trip_invites.find_one_and_update(
        {**authorized, "revoked_at": None},
        {"$set": {
            "active": False,
            "revoked_at": timestamp,
            "revoked_by": revoked_by,
            "revocation_reason": "manual",
            "audit_expires_at": timestamp + AUDIT_RETENTION,
        }},
        projection={"_id": 0},
        return_document=ReturnDocument.AFTER,
    )
    if document:
        logger.info(
            "invite.revoked invite_id=%s trip_id=%s revoked_by=%s",
            invite_id, trip_id, revoked_by,
        )
        return invite_metadata(document)
    existing = await db.trip_invites.find_one(
        authorized, {"_id": 0},
    )
    if not existing:
        raise HTTPException(404, "Invite link not found")
    return invite_metadata(existing)


async def revoke_trip_invites(trip_id: str, revoked_by: str) -> None:
    """Revoke every live link before a trip is deleted and retain that audit event for 90 days."""
    timestamp = now_utc()
    result = await db.trip_invites.update_many(
        {"trip_id": trip_id, "revoked_at": None},
        {"$set": {
            "active": False,
            "revoked_at": timestamp,
            "revoked_by": revoked_by,
            "revocation_reason": "trip_deleted",
            "audit_expires_at": timestamp + AUDIT_RETENTION,
        }},
    )
    logger.info(
        "invite.trip_revoked trip_id=%s revoked_by=%s count=%s",
        trip_id,
        revoked_by,
        getattr(result, "modified_count", 0),
    )


async def normalize_invite_active_flags() -> None:
    """Idempotently prepare legacy invite rows for the one-active-link unique index.

    Before build 7, invite rows did not carry ``active`` and a creator could have several valid
    links.  Keep only their newest unexpired link active, rotate every older live link, and mark
    expired/revoked rows inactive.  This runs before index creation during application startup.
    """
    timestamp = now_utc()
    projection = {
        "_id": 0, "id": 1, "trip_id": 1, "created_by": 1, "created_at": 1,
        "expires_at": 1, "revoked_at": 1, "active": 1,
    }
    cursor = db.trip_invites.find({}, projection).sort([
        ("trip_id", 1), ("created_by", 1), ("created_at", -1),
    ])
    newest_live: set[tuple[str, str]] = set()
    async for document in cursor:
        expired = _as_utc(document["expires_at"]) <= timestamp
        revoked = bool(document.get("revoked_at"))
        key = (document["trip_id"], document["created_by"])
        if not expired and not revoked and key not in newest_live:
            newest_live.add(key)
            if document.get("active") is not True:
                await db.trip_invites.update_one(
                    {"id": document["id"]}, {"$set": {"active": True}},
                )
            continue

        if not expired and not revoked:
            await db.trip_invites.update_one(
                {"id": document["id"]},
                {"$set": {
                    "active": False,
                    "revoked_at": timestamp,
                    "revoked_by": "system",
                    "revocation_reason": "migration_rotation",
                    "audit_expires_at": timestamp + AUDIT_RETENTION,
                }},
            )
        elif document.get("active") is not False:
            await db.trip_invites.update_one(
                {"id": document["id"]}, {"$set": {"active": False}},
            )


def _invite_error(status: str) -> HTTPException:
    messages = {
        "expired": "This invitation has expired. Ask a trip admin for a new link.",
        "revoked": "This invitation was revoked. Ask a trip admin for a new link.",
        "invalid": "This invitation is not valid.",
        "disabled": "Invitation links are temporarily unavailable.",
    }
    status_code = 503 if status == "disabled" else 410 if status in {"expired", "revoked"} else 404
    return HTTPException(status_code, detail={"code": f"invite_{status}", "message": messages[status]})


async def find_invite(raw: str) -> Optional[dict]:
    token = (raw or "").strip()
    if len(token) < 32 or len(token) > 128:
        return None
    return await db.trip_invites.find_one({"token_hash": hash_invite_token(token)}, {"_id": 0})


async def public_invite_status(raw: str) -> dict:
    if not INVITE_LINKS_ENABLED:
        raise _invite_error("disabled")
    document = await find_invite(raw)
    if not document:
        logger.warning("invite.resolve_rejected reason=invalid")
        raise _invite_error("invalid")
    status = invite_status(document)
    trip = await db.trips.find_one({"id": document["trip_id"]}, {"_id": 0, "name": 1})
    if not trip:
        status = "revoked"
    return {
        "status": status,
        "trip_name": trip.get("name") if trip else document.get("trip_name"),
        "expires_at": _iso(document["expires_at"]),
    }


async def resolve_join_credential(code: Optional[str], invite_token: Optional[str]) -> tuple[dict, Optional[dict]]:
    if code:
        normalized = code.upper().strip()
        trip = await db.trips.find_one({"code": normalized}, {"_id": 0})
        if not trip:
            raise HTTPException(404, "Trip not found")
        return trip, None

    if not INVITE_LINKS_ENABLED:
        raise _invite_error("disabled")
    invite = await find_invite(invite_token or "")
    if not invite:
        logger.warning("invite.join_rejected reason=invalid")
        raise _invite_error("invalid")
    status = invite_status(invite)
    if status != "active":
        logger.info("invite.join_rejected invite_id=%s reason=%s", invite["id"], status)
        raise _invite_error(status)
    trip = await db.trips.find_one({"id": invite["trip_id"]}, {"_id": 0})
    if not trip:
        raise _invite_error("revoked")
    return trip, invite


async def record_invite_use(invite: Optional[dict]) -> None:
    if not invite:
        return
    await db.trip_invites.update_one(
        {"id": invite["id"]},
        {"$inc": {"use_count": 1}, "$set": {"last_used_at": now_utc()}},
    )
    logger.info("invite.used invite_id=%s trip_id=%s", invite["id"], invite["trip_id"])
