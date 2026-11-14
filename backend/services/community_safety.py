"""Terms, teen permissions and user blocking shared by every content transport."""

import hashlib
import secrets
from datetime import timedelta

from fastapi import HTTPException

from utils.common import now_utc
from utils.email_rules import email_is_verified, normalize_email


TERMS_VERSION = "2026-11-13"
SUPPORT_EMAIL = "teamsplitora@gmail.com"
PERMISSION_FIELDS = {
    "chat": "chat_enabled", "receipts": "receipts_enabled", "contacts": "contacts_enabled",
}
SAFETY_PROFILE_FIELDS = {
    "community_age_band": 1, "community_terms_version": 1,
    "guardian_consent": 1, "ugc_suspended_at": 1,
}


def terms_current(user: dict) -> bool:
    return user.get("community_terms_version") == TERMS_VERSION


async def community_permissions(database, user: dict) -> dict:
    accepted = terms_current(user)
    age = user.get("community_age_band")
    eligible = accepted and age in ("13_17", "18_plus")
    consent = user.get("guardian_consent") or {}
    guardian_valid = False
    if eligible and age == "13_17" and consent.get("status") == "approved" \
            and consent.get("terms_version") == TERMS_VERSION:
        guardian = await database.users.find_one({"id": consent.get("guardian_user_id")})
        guardian_valid = bool(
            guardian and guardian.get("community_age_band") == "18_plus"
            and terms_current(guardian) and email_is_verified(guardian)
            and normalize_email(guardian.get("email")) == consent.get("guardian_email")
            and not guardian.get("ugc_suspended_at")
        )
    permitted = eligible and not user.get("ugc_suspended_at")
    permissions = {
        feature: bool(permitted and (
            age == "18_plus" or (guardian_valid and consent.get(field) is True)
        ))
        for feature, field in PERMISSION_FIELDS.items()
    }
    permissions["account"] = bool(eligible and (age == "18_plus" or guardian_valid))
    return {
        "terms_version": TERMS_VERSION,
        "accepted": accepted,
        "age_band": age,
        "suspended": bool(user.get("ugc_suspended_at")),
        "guardian_status": (
            "renewal_required" if consent.get("status") in ("approved", "pending_verification")
            and consent.get("terms_version") != TERMS_VERSION else consent.get("status")
        ),
        "guardian_email": consent.get("guardian_email"),
        "permissions": permissions,
    }


async def require_community_access(database, user: dict, feature: str) -> None:
    # Internal callers can carry only an authenticated ID. Resolve their current policy
    # instead of treating omitted fields as a consent decision.
    if user.get("id") and ("community_age_band" not in user or "community_terms_version" not in user):
        current = await database.users.find_one({"id": user["id"]})
        if current:
            user = current
    state = await community_permissions(database, user)
    if state["permissions"][feature]:
        return
    if not state["accepted"] or not state["age_band"]:
        code, message = "community_terms_required", "Review Community safety and accept the current terms."
    elif state["age_band"] == "under_13":
        code, message = "minimum_age_required", "Splitora is available to people aged 13 and over."
    elif state["suspended"]:
        code, message = "community_suspended", "Community access is suspended. Contact support to appeal."
    else:
        code, message = "guardian_permission_required", "A verified parent or guardian must enable this feature."
    raise HTTPException(403, {"code": code, "message": message})


async def blocked_chat_users(database, user_id: str) -> set[str]:
    rows = await database.community_blocks.find({"$or": [
        {"user_id": user_id}, {"blocked_user_id": user_id},
    ]}).to_list(None)
    return {
        row["blocked_user_id"] if row["user_id"] == user_id else row["user_id"]
        for row in rows
    }


async def chat_recipient_allowed(database, user_id: str, author_id: str | None) -> bool:
    user = await database.users.find_one({"id": user_id})
    if not user or not (await community_permissions(database, user))["permissions"]["chat"]:
        return False
    if not author_id or user_id == author_id:
        return True
    return author_id not in await blocked_chat_users(database, user_id)


def guardian_code_hash(code: str) -> str:
    return hashlib.sha256(code.lower().encode()).hexdigest()


async def request_guardian(database, user: dict, email: str) -> str:
    if not terms_current(user) or user.get("community_age_band") != "13_17":
        raise HTTPException(409, "Complete the teen age and terms review first.")
    email = normalize_email(email)
    if email == normalize_email(user.get("email")):
        raise HTTPException(422, "Use your parent or guardian's Gmail address.")
    code = secrets.token_hex(16)
    consent = {
        "status": "requested", "guardian_email": email,
        "token_hash": guardian_code_hash(code), "requested_at": now_utc(),
        "expires_at": now_utc() + timedelta(days=7),
        "chat_enabled": False, "receipts_enabled": False, "contacts_enabled": False,
    }
    # A fresh code supersedes the previous request and its permissions atomically.
    result = await database.users.update_one(
        {"id": user["id"], "$or": [
            {"guardian_consent.requested_at": {"$lte": now_utc() - timedelta(minutes=1)}},
            {"guardian_consent.requested_at": {"$exists": False}},
        ]}, {"$set": {"guardian_consent": consent}},
    )
    if not result.matched_count:
        raise HTTPException(429, "Wait a minute before creating another guardian code.",
                            headers={"Retry-After": "60"})
    return code


async def guardian_child_for_code(database, guardian: dict, code: str) -> dict:
    if not terms_current(guardian) or guardian.get("community_age_band") != "18_plus" \
            or not email_is_verified(guardian) or guardian.get("ugc_suspended_at"):
        raise HTTPException(403, "Accept the adult terms and verify your email before giving consent.")
    child = await database.users.find_one({
        "guardian_consent.token_hash": guardian_code_hash(code),
        "guardian_consent.guardian_email": normalize_email(guardian.get("email")),
        "guardian_consent.expires_at": {"$gt": now_utc()},
        "$or": [
            {"guardian_consent.status": "requested", "guardian_consent.expires_at": {"$gt": now_utc()}},
            {"guardian_consent.status": {"$in": ["pending_verification", "approved"]},
             "guardian_consent.guardian_user_id": guardian["id"],
             "guardian_consent.terms_version": TERMS_VERSION},
        ],
        "community_age_band": "13_17",
        "community_terms_version": TERMS_VERSION,
    })
    if not child or child["id"] == guardian["id"]:
        raise HTTPException(404, "Guardian code is unavailable or expired.")
    return child


async def cleanup_community_account(database, user_id: str, *, session=None) -> None:
    options = {"session": session} if session is not None else {}
    await database.community_blocks.delete_many({"$or": [
        {"user_id": user_id}, {"blocked_user_id": user_id},
    ]}, **options)
    user = await database.users.find_one({"id": user_id}, **options)
    relationships = [{"guardian_consent.guardian_user_id": user_id}]
    if user and user.get("email"):
        relationships.append({"guardian_consent.guardian_email": normalize_email(user["email"])})
    await database.users.update_many(
        {"$or": relationships},
        {"$unset": {"guardian_consent": ""}}, **options,
    )
    # Moderation decisions retain their bounded case evidence, with account references scrubbed.
    await database.community_reports.update_many(
        {"reporter_user_id": user_id}, {"$unset": {"reporter_user_id": ""}}, **options,
    )
    await database.community_reports.update_many(
        {"target_user_id": user_id},
        {"$unset": {"target_user_id": "", "snapshot": "", "details": "", "request.details": ""}}, **options,
    )
    await database.community_reports.update_many(
        {"target_type": "user", "target_id": user_id},
        {"$unset": {"target_id": "", "request.target_id": ""}}, **options,
    )
