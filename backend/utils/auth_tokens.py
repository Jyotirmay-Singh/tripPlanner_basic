"""Email-bound tokens; consumption and account changes commit together."""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from pymongo import ReturnDocument

from database import db
from services.ledger_transactions import run_required_transaction

VERIFY_EMAIL = "verify_email"
RESET_PASSWORD = "reset_password"
COLLECTION = "auth_tokens"
TOKEN_TTL = timedelta(minutes=15)


class AuthTokenError(ValueError):
    def __init__(self, code: str):
        self.code = code
        messages = {
            "expired": "This link has expired. Please request a new email.",
            "used": "This link has already been used or replaced. Please request a new email.",
            "invalid": "This link is invalid or has expired. Please request a new email.",
        }
        super().__init__(messages[code])


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


async def issue_token(user_id: str, token_type: str, ttl: timedelta = TOKEN_TTL) -> str:
    if token_type not in (VERIFY_EMAIL, RESET_PASSWORD):
        raise ValueError("Unsupported email token purpose")
    raw = secrets.token_urlsafe(32)
    now = _now()

    async def issue(session):
        # The user update serializes concurrent issuances and consumption for this account.
        user = await db.users.find_one_and_update(
            {"id": user_id}, {"$inc": {f"auth_token_versions.{token_type}": 1}},
            return_document=ReturnDocument.AFTER, session=session,
        )
        if not user:
            raise AuthTokenError("invalid")
        await db[COLLECTION].update_many(
            {"user_id": user_id, "type": token_type, "used": False},
            {"$set": {"used": True}}, session=session,
        )
        await db[COLLECTION].insert_one({
            "token_hash": hash_token(raw), "user_id": user_id,
            "email": user["email"].lower().strip(), "type": token_type,
            "version": user["auth_token_versions"][token_type],
            "expires_at": now + min(ttl, TOKEN_TTL), "used": False, "created_at": now,
        }, session=session)

    await run_required_transaction(issue)
    return raw


async def consume_token(raw: str, token_type: str, *, user_update: Optional[dict] = None) -> str:
    if not raw or len(raw) > 512:
        raise AuthTokenError("invalid")

    async def consume(session):
        now = _now()
        rec = await db[COLLECTION].find_one(
            {"token_hash": hash_token(raw), "type": token_type}, session=session,
        )
        if not rec or not rec.get("email") or "version" not in rec:
            raise AuthTokenError("invalid")
        if rec.get("used"):
            raise AuthTokenError("used")
        if _as_utc(rec["expires_at"]) <= now:
            raise AuthTokenError("expired")
        claimed = await db[COLLECTION].find_one_and_update(
            {"_id": rec["_id"], "used": False, "expires_at": {"$gt": now}},
            {"$set": {"used": True, "used_at": now}}, session=session,
        )
        if not claimed:
            raise AuthTokenError("used")
        update = user_update or {"$set": {"auth_token_consumed_at": now}}
        if token_type == VERIFY_EMAIL:
            update = {"$set": {"email_verified": True, "email_verified_at": now,
                               "email_verified_for": rec["email"], "email_verification_method": "email_link"}}
        updated = await db.users.update_one(
            {"id": rec["user_id"], "email": rec["email"],
             f"auth_token_versions.{token_type}": rec["version"]},
            update, session=session,
        )
        if updated.matched_count != 1:
            raise AuthTokenError("invalid")
        if token_type == RESET_PASSWORD:
            await db[COLLECTION].update_many(
                {"user_id": rec["user_id"], "type": RESET_PASSWORD, "used": False},
                {"$set": {"used": True}}, session=session,
            )
        return rec["user_id"]

    return await run_required_transaction(consume)


async def seconds_since_last(user_id: str, token_type: str) -> Optional[float]:
    rec = await db[COLLECTION].find_one(
        {"user_id": user_id, "type": token_type}, sort=[("created_at", -1)],
    )
    return (_now() - _as_utc(rec["created_at"])).total_seconds() if rec else None
