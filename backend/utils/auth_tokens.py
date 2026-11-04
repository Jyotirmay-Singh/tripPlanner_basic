"""Email-bound tokens; consumption and account changes commit together."""
import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from pymongo import ReturnDocument

from database import db
from services.ledger_transactions import run_required_transaction
from utils.email_rules import email_is_verified

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
            "verification_required": "Verify your email before resetting your password. Request a new recovery email to continue.",
        }
        super().__init__(messages[code])


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


async def issue_token(user_id: str, token_type: str, ttl: timedelta = TOKEN_TTL, *,
                      password_reset_requested: bool = False) -> str:
    if token_type not in (VERIFY_EMAIL, RESET_PASSWORD):
        raise ValueError("Unsupported email token purpose")
    if password_reset_requested and token_type != VERIFY_EMAIL:
        raise ValueError("Recovery continuation requires an email verification token")
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
            "password_reset_requested": password_reset_requested,
        }, session=session)

    await run_required_transaction(issue)
    return raw


@dataclass(frozen=True)
class ConsumedToken:
    user_id: str
    email: str
    password_reset_requested: bool


async def consume_token(raw: str, token_type: str, *, user_update: Optional[dict] = None) -> str:
    result = await _consume_token(raw, token_type, user_update=user_update)
    return result.user_id


async def consume_verification_token(raw: str) -> ConsumedToken:
    return await _consume_token(raw, VERIFY_EMAIL)


async def mark_verification_for_recovery(user_id: str, email: str) -> None:
    """Keep an already-sent verification link useful when its resend cooldown applies."""
    await db[COLLECTION].update_one({
        "user_id": user_id, "email": email, "type": VERIFY_EMAIL,
        "used": False, "expires_at": {"$gt": _now()},
    }, {"$set": {"password_reset_requested": True}})


async def _consume_token(raw: str, token_type: str, *, user_update: Optional[dict] = None) -> ConsumedToken:
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
        if token_type == RESET_PASSWORD:
            # Check the exact address inside the password-write transaction, including links
            # issued before verification became required. Rejection must not burn the link.
            user = await db.users.find_one({
                "id": rec["user_id"], "email": rec["email"],
                f"auth_token_versions.{token_type}": rec["version"],
            }, session=session)
            if not user:
                raise AuthTokenError("invalid")
            if not email_is_verified(user):
                raise AuthTokenError("verification_required")
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
        return ConsumedToken(rec["user_id"], rec["email"], rec.get("password_reset_requested") is True)

    return await run_required_transaction(consume)


async def seconds_since_last(user_id: str, token_type: str) -> Optional[float]:
    rec = await db[COLLECTION].find_one(
        {"user_id": user_id, "type": token_type}, sort=[("created_at", -1)],
    )
    return (_now() - _as_utc(rec["created_at"])).total_seconds() if rec else None
