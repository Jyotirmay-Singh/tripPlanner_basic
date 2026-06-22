"""Hardened, hashed, single-use, expiring email tokens (verify-email + password-reset).

These back the email-verification and forgot-PASSWORD flows. They are intentionally kept
separate from the legacy `db.password_reset_tokens` used by the forgot-PIN flow (which stores
raw tokens + ISO-string expiries and is left byte-for-byte). Here we:
  * store only a SHA-256 hash of the raw token (the raw value lives only in the email link);
  * tag every token with a `type` so a verify token can never be spent as a reset token;
  * store `expires_at` as a real UTC datetime so a TTL index can auto-purge expired rows;
  * invalidate a user's prior unused tokens of the same type whenever a new one is issued;
  * mark a token `used` on first consume (single-use).
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from database import db

# Token types (the only valid values for the `type` field).
VERIFY_EMAIL = "verify_email"
RESET_PASSWORD = "reset_password"

COLLECTION = "auth_tokens"


def hash_token(raw: str) -> str:
    """SHA-256 hex of the raw token. High-entropy random tokens don't need bcrypt; a fast
    digest lets us look the token up by an indexed `token_hash`."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    # Motor/pymongo return naive UTC datetimes (the client isn't tz_aware); normalize so
    # comparisons against tz-aware _now() don't raise.
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


async def issue_token(user_id: str, token_type: str, ttl: timedelta) -> str:
    """Invalidate the user's prior unused tokens of this type, persist a fresh hashed
    token, and return the RAW token (never stored)."""
    await db[COLLECTION].update_many(
        {"user_id": user_id, "type": token_type, "used": False},
        {"$set": {"used": True}},
    )
    raw = secrets.token_urlsafe(32)
    now = _now()
    await db[COLLECTION].insert_one({
        "token_hash": hash_token(raw),
        "user_id": user_id,
        "type": token_type,
        "expires_at": now + ttl,
        "used": False,
        "created_at": now,
    })
    return raw


async def consume_token(raw: str, token_type: str) -> Optional[str]:
    """Validate a raw token of the given type and mark it used. Returns the owning
    user_id, or None if the token is missing / wrong type / already used / expired."""
    if not raw:
        return None
    rec = await db[COLLECTION].find_one({"token_hash": hash_token(raw), "type": token_type})
    if not rec or rec.get("used"):
        return None
    if _as_utc(rec["expires_at"]) < _now():
        return None
    await db[COLLECTION].update_one({"_id": rec["_id"]}, {"$set": {"used": True}})
    return rec["user_id"]


async def seconds_since_last(user_id: str, token_type: str) -> Optional[float]:
    """Seconds since the most recent token of this type was created for the user (used for
    resend rate limiting), or None if the user has never been issued one."""
    rec = await db[COLLECTION].find_one(
        {"user_id": user_id, "type": token_type},
        sort=[("created_at", -1)],
    )
    if not rec:
        return None
    return (_now() - _as_utc(rec["created_at"])).total_seconds()
