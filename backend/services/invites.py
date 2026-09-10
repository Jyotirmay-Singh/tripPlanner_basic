"""One stable, resettable invitation link for each trip.

Invitation tokens are deterministic HMAC-signed capabilities derived from the trip id and its
``invite_generation``. Raw bearer tokens are never persisted. Incrementing the generation resets
the trip link immediately without maintaining user-visible invite history.
"""

import base64
import hashlib
import hmac
import logging
import re
from datetime import timedelta
from typing import Optional

from fastapi import HTTPException
from pymongo import ReturnDocument

from config import INVITE_BASE_URL, INVITE_LINKS_ENABLED, JWT_SECRET
from database import db
from utils.common import now_utc


AUDIT_RETENTION = timedelta(days=90)
INVITE_TOKEN_CONTEXT = b"trip-splitter:stable-invite:v1:"
INVITE_SIGNATURE_LENGTH = 43
INVITE_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
logger = logging.getLogger(__name__)


def hash_invite_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def invite_generation(trip: dict) -> int:
    try:
        return max(0, int(trip.get("invite_generation", 0)))
    except (TypeError, ValueError):
        return 0


def create_signed_invite_token(trip: dict) -> str:
    """Return the stable token for the trip's current invite generation."""
    payload = _b64encode(f'{trip["id"]}:{invite_generation(trip)}'.encode("utf-8"))
    signature = hmac.new(
        str(JWT_SECRET).encode("utf-8"), INVITE_TOKEN_CONTEXT + payload.encode("ascii"), hashlib.sha256,
    ).digest()
    return f"{payload}_{_b64encode(signature)}"


def decode_signed_invite_token(raw: str) -> Optional[tuple[str, int]]:
    """Verify a stable invite token and return ``(trip_id, generation)``."""
    token = (raw or "").strip()
    # The signature is always 43 base64url characters. Using its fixed width avoids ambiguity
    # because underscores are valid inside both halves of the token.
    if (
        not INVITE_TOKEN_PATTERN.fullmatch(token)
        or len(token) <= INVITE_SIGNATURE_LENGTH + 1
        or token[-(INVITE_SIGNATURE_LENGTH + 1)] != "_"
    ):
        return None
    payload = token[:-(INVITE_SIGNATURE_LENGTH + 1)]
    supplied_signature = token[-INVITE_SIGNATURE_LENGTH:]
    expected_signature = _b64encode(hmac.new(
        str(JWT_SECRET).encode("utf-8"), INVITE_TOKEN_CONTEXT + payload.encode("ascii"), hashlib.sha256,
    ).digest())
    if not hmac.compare_digest(supplied_signature, expected_signature):
        return None
    try:
        decoded = _b64decode(payload).decode("utf-8")
        trip_id, generation_value = decoded.rsplit(":", 1)
        generation = int(generation_value)
    except (ValueError, UnicodeDecodeError):
        return None
    if not trip_id or generation < 0:
        return None
    return trip_id, generation


def current_invite_link(trip: dict) -> dict:
    token = create_signed_invite_token(trip)
    return {"url": f"{INVITE_BASE_URL}/invite/{token}"}


async def reset_invite_link(trip_id: str) -> dict:
    """Atomically replace a trip's link by advancing its invite generation."""
    trip = await db.trips.find_one_and_update(
        {"id": trip_id},
        {"$inc": {"invite_generation": 1}},
        projection={"_id": 0, "id": 1, "invite_generation": 1},
        return_document=ReturnDocument.AFTER,
    )
    if not trip:
        raise HTTPException(404, "Trip not found")
    logger.info(
        "invite.reset trip_id=%s generation=%s", trip_id, invite_generation(trip),
    )
    return current_invite_link(trip)


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


async def retire_legacy_invites() -> None:
    """Invalidate every pre-singleton invite while retaining its internal audit record."""
    timestamp = now_utc()
    result = await db.trip_invites.update_many(
        {"revoked_at": None},
        {"$set": {
            "active": False,
            "revoked_at": timestamp,
            "revoked_by": "system",
            "revocation_reason": "single_link_migration",
            "audit_expires_at": timestamp + AUDIT_RETENTION,
        }},
    )
    logger.info("invite.legacy_retired count=%s", getattr(result, "modified_count", 0))


def _invite_error(status: str) -> HTTPException:
    messages = {
        "revoked": "This invitation link was reset. Ask a trip admin for the current link.",
        "invalid": "This invitation is not valid.",
        "disabled": "Invitation links are temporarily unavailable.",
    }
    status_code = 503 if status == "disabled" else 410 if status == "revoked" else 404
    return HTTPException(status_code, detail={"code": f"invite_{status}", "message": messages[status]})


async def find_invite(raw: str) -> Optional[dict]:
    token = (raw or "").strip()
    if len(token) < 32 or len(token) > 128:
        return None
    return await db.trip_invites.find_one({"token_hash": hash_invite_token(token)}, {"_id": 0})


async def public_invite_status(raw: str) -> dict:
    if not INVITE_LINKS_ENABLED:
        raise _invite_error("disabled")
    resolved = decode_signed_invite_token(raw)
    if not resolved:
        if await find_invite(raw):
            logger.info("invite.resolve_rejected reason=legacy_retired")
            raise _invite_error("revoked")
        logger.warning("invite.resolve_rejected reason=invalid")
        raise _invite_error("invalid")
    trip_id, generation = resolved
    trip = await db.trips.find_one(
        {"id": trip_id}, {"_id": 0, "name": 1, "invite_generation": 1},
    )
    if not trip or invite_generation(trip) != generation:
        raise _invite_error("revoked")
    return {"status": "active", "trip_name": trip["name"]}


async def resolve_join_credential(code: Optional[str], invite_token: Optional[str]) -> tuple[dict, Optional[dict]]:
    if code:
        normalized = code.upper().strip()
        trip = await db.trips.find_one({"code": normalized}, {"_id": 0})
        if not trip:
            raise HTTPException(404, "Trip not found")
        return trip, None

    if not INVITE_LINKS_ENABLED:
        raise _invite_error("disabled")
    raw = invite_token or ""
    resolved = decode_signed_invite_token(raw)
    if not resolved:
        if await find_invite(raw):
            logger.info("invite.join_rejected reason=legacy_retired")
            raise _invite_error("revoked")
        logger.warning("invite.join_rejected reason=invalid")
        raise _invite_error("invalid")
    trip_id, generation = resolved
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    if not trip or invite_generation(trip) != generation:
        raise _invite_error("revoked")
    # A truthy marker keeps invite-based previews from exposing the six-character fallback code.
    return trip, {"kind": "stable_link"}


async def record_invite_use(invite: Optional[dict]) -> None:
    """Compatibility hook retained for join callers; stable links keep no use history."""
    return None
