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
        "created_at": _iso(document["created_at"]),
        "expires_at": _iso(document["expires_at"]),
        "status": invite_status(document),
        "revoked_at": _iso(document.get("revoked_at")),
        "revoked_by": document.get("revoked_by"),
        "use_count": document.get("use_count", 0),
        "last_used_at": _iso(document.get("last_used_at")),
    }


async def create_invite(trip: dict, created_by: str) -> dict:
    raw = secrets.token_urlsafe(32)
    timestamp = now_utc()
    document = {
        "id": gen_id(),
        "trip_id": trip["id"],
        "trip_name": trip.get("name"),
        "token_hash": hash_invite_token(raw),
        "created_by": created_by,
        "created_at": timestamp,
        "expires_at": timestamp + INVITE_TTL,
        "audit_expires_at": timestamp + INVITE_TTL + AUDIT_RETENTION,
        "revoked_at": None,
        "revoked_by": None,
        "use_count": 0,
        "last_used_at": None,
    }
    await db.trip_invites.insert_one(document)
    logger.info(
        "invite.created invite_id=%s trip_id=%s created_by=%s expires_at=%s",
        document["id"], trip["id"], created_by, _iso(document["expires_at"]),
    )
    payload = invite_metadata(document)
    payload["url"] = f"{INVITE_BASE_URL}/invite/{raw}"
    return payload


async def list_invites(trip_id: str) -> list[dict]:
    cursor = db.trip_invites.find({"trip_id": trip_id}, {"_id": 0}).sort("created_at", -1)
    return [invite_metadata(row) for row in await cursor.to_list(100)]


async def revoke_invite(trip_id: str, invite_id: str, revoked_by: str) -> dict:
    timestamp = now_utc()
    document = await db.trip_invites.find_one_and_update(
        {"id": invite_id, "trip_id": trip_id, "revoked_at": None},
        {"$set": {
            "revoked_at": timestamp,
            "revoked_by": revoked_by,
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
        {"id": invite_id, "trip_id": trip_id}, {"_id": 0},
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
            "revoked_at": timestamp,
            "revoked_by": revoked_by,
            "audit_expires_at": timestamp + AUDIT_RETENTION,
        }},
    )
    logger.info(
        "invite.trip_revoked trip_id=%s revoked_by=%s count=%s",
        trip_id,
        revoked_by,
        getattr(result, "modified_count", 0),
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
