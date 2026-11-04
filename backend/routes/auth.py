from fastapi import APIRouter, BackgroundTasks, HTTPException, Depends
from google.auth.transport import requests as google_requests
from google.auth.exceptions import TransportError
from google.oauth2 import id_token as google_id_token

from config import GOOGLE_CLIENT_ID, EMAIL_FEATURES_ENABLED, logger
from database import db
from models.auth import (
    RegisterIn, LoginIn, GoogleAuthIn,
    VerifyEmailIn, RequestPasswordResetIn, ResetPasswordIn, SetCredentialsIn, ChangePasswordIn,
    UpiProfileUpdate, MobileProfileUpdate,
)
from services.mobile_claims import update_account_mobile
from utils.common import gen_id, now_utc
from utils.email_rules import assert_gmail, normalize_email, email_is_verified
from utils.security import hash_secret, verify_secret, create_token
from utils.deps import get_current_user
from utils.permissions import is_super_admin
from utils.auth_tokens import (
    issue_token, consume_token, consume_verification_token, mark_verification_for_recovery,
    AuthTokenError, TOKEN_TTL, VERIFY_EMAIL, RESET_PASSWORD,
)
from utils.emailer import send_auth_email, build_link, EmailDeliveryError
from utils.email_limits import claim_email_send, enforce_email_ip_limit
from services.ledger_transactions import TransactionUnavailableError
from services.chat_realtime import chat_connections

VERIFY_TTL = TOKEN_TTL
RESET_TTL = TOKEN_TTL
# Minimum seconds between "resend verification email" requests (per user).
RESEND_COOLDOWN_SECONDS = 60

router = APIRouter()

# Minimum account-password length (length-only; no complexity rules). Mirrored client-side in
# frontend/src/validation.ts (MIN_PASSWORD_LENGTH).
MIN_PASSWORD_LENGTH = 9


# ---------- Auth ----------
def _user_payload(user: dict) -> dict:
    """Public profile. Pending email verification never restricts application access."""
    return {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "role": user.get("role", "user"),
        "is_super_admin": is_super_admin(user),
        "email_verified": email_is_verified(user),
        "credentials_set": user.get("credentials_set", True),
        "upi_id": user.get("upi_id"),
        "upi_updated_at": user.get("upi_updated_at"),
        "mobile_number": user.get("mobile_number"),
        "mobile_country_code": user.get("mobile_country_code"),
        "mobile_verified_at": user.get("mobile_verified_at"),
    }


def _self_profile_payload(user: dict) -> dict:
    """Preserve the existing /auth/me shape while stabilizing nullable UPI fields."""
    payload = dict(user)
    payload["email_verified"] = email_is_verified(user)
    payload.pop("auth_token_versions", None)
    payload.pop("session_version", None)
    payload.pop("email_security_migration", None)
    payload["is_super_admin"] = is_super_admin(user)
    payload["upi_id"] = user.get("upi_id")
    payload["upi_updated_at"] = user.get("upi_updated_at")
    payload["mobile_number"] = user.get("mobile_number")
    payload["mobile_country_code"] = user.get("mobile_country_code")
    payload["mobile_verified_at"] = user.get("mobile_verified_at")
    return payload


async def _send_verification(user: dict, *, password_reset_requested: bool = False) -> None:
    """Issue a fresh verify-email token (invalidating older ones) and email the link."""
    retry = await claim_email_send(user["email"], VERIFY_EMAIL)
    if retry:
        raise HTTPException(429, {"code": "email_cooldown", "message": "Please wait before requesting another email."},
                            headers={"Retry-After": str(retry)})
    options = {"password_reset_requested": True} if password_reset_requested else {}
    raw = await issue_token(user["id"], VERIFY_EMAIL, VERIFY_TTL, **options)
    link = build_link("verify-email", raw)
    await send_auth_email(user["email"], VERIFY_EMAIL, link)


@router.post("/auth/register", dependencies=[Depends(enforce_email_ip_limit)])
async def register(body: RegisterIn):
    email = body.email.lower().strip()
    assert_gmail(email)
    if await db.users.find_one({"email": email}):
        raise HTTPException(400, "Email already registered")
    if len(body.password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    uid = gen_id()
    password_hash = hash_secret(body.password)
    doc = {
        "id": uid, "email": email, "name": body.name,
        "password_hash": password_hash,
        "role": "user",
        "email_verified": False,
        "session_version": 0,
        "email_security_migration": 1,
        "credentials_set": True,
        "mobile_number": None,
        "mobile_country_code": None,
        "mobile_verified_at": None,
        "created_at": now_utc().isoformat(),
    }
    await db.users.insert_one(doc)
    delivery = "disabled"
    if EMAIL_FEATURES_ENABLED:
        try:
            await _send_verification(doc)
            delivery = "sent"
        except (EmailDeliveryError, TransactionUnavailableError, HTTPException):
            logger.warning("email.registration_delivery_unavailable")
            delivery = "unavailable"
    token = create_token(uid, email)
    return {"access_token": token, "user": _user_payload(doc), "verification_delivery": delivery}


@router.post("/auth/login")
async def login(body: LoginIn):
    email = body.email.lower().strip()
    assert_gmail(email)
    user = await db.users.find_one({"email": email})
    password_hash = user.get("password_hash") if user else None
    if not password_hash or not verify_secret(body.password, password_hash):
        raise HTTPException(401, "Invalid email or password")
    token = create_token(user["id"], email, user.get("session_version", 0))
    return {"access_token": token, "user": _user_payload(user)}


@router.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return _self_profile_payload(user)


@router.patch("/auth/me")
async def update_me(body: UpiProfileUpdate, user=Depends(get_current_user)):
    """Replace or remove only the authenticated account's UPI payment address."""
    current_upi_id = user.get("upi_id")
    if body.upi_id == current_upi_id:
        return _self_profile_payload(user)

    if body.upi_id is None:
        update = {"$unset": {"upi_id": "", "upi_updated_at": ""}, "$inc": {"recipient_account_revision": 1}}
    else:
        update = {"$set": {
            "upi_id": body.upi_id,
            "upi_updated_at": now_utc().isoformat(),
        }, "$inc": {"recipient_account_revision": 1}}

    from services.settlement_write_guard import activated
    linked = await db.trips.find({"user_ids": user["id"]}, {"_id": 0}).to_list(None)
    if any(activated(trip) for trip in linked):
        from services.coverage_journal import run_snapshot_transaction
        from services.financial_bindings import invalidate_bindings
        operation_id = gen_id()
        async def change_profile(session):
            actor = await db.users.find_one({"id": user["id"]}, {"_id": 0}, session=session)
            if not actor:
                raise HTTPException(401, "User not found")
            await db.users.update_one({"id": actor["id"]}, update, session=session)
            current = await db.trips.find({"user_ids": actor["id"]}, {"_id": 0}, session=session).to_list(None)
            for trip in current:
                if activated(trip):
                    await invalidate_bindings(db, trip["id"], {actor["id"]}, operation_id, "recipient_account_changed", session)
                    await db.trips.update_one({"id": trip["id"]}, {"$inc": {"version": 1}}, session=session)
            return await db.users.find_one({"id": actor["id"]}, {"_id": 0, "password_hash": 0}, session=session)
        updated = await run_snapshot_transaction(change_profile)
    else:
        await db.users.update_one({"id": user["id"]}, update)
        updated = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 0, "pin_hash": 0})
    if not updated:
        # The dependency authenticated a real user, but the row may have been
        # removed concurrently before the write/re-fetch completed.
        raise HTTPException(401, "User not found")
    return _self_profile_payload(updated)


@router.patch("/auth/me/mobile")
async def update_mobile(body: MobileProfileUpdate, user=Depends(get_current_user)):
    """Replace or remove the authenticated account's international mobile number."""
    updated = await update_account_mobile(
        user, body.mobile_number, body.mobile_country_code,
    )
    return _self_profile_payload(updated)


@router.post("/auth/google")
async def google_auth(body: GoogleAuthIn):
    # GOOGLE_CLIENT_ID may be a single client ID or a comma-separated list of
    # accepted audiences. Web and Android Credential Manager both mint an ID token
    # for the Web OAuth client passed as `webClientId`; the retained iOS AuthSession
    # flow may mint for its iOS client. An Android OAuth client is still required for
    # package/SHA registration, but is not the Android token audience in the current
    # flow. google-auth verifies Google's signature, issuer, expiry, and one of these
    # audiences; verify_oauth2_token accepts the parsed list directly.
    audiences = [c.strip() for c in GOOGLE_CLIENT_ID.split(",") if c.strip()]
    if not audiences:
        raise HTTPException(500, "Google sign-in is not configured")
    try:
        idinfo = google_id_token.verify_oauth2_token(
            body.id_token, google_requests.Request(), audiences
        )
    except ValueError:
        raise HTTPException(401, "Invalid Google token")
    except TransportError:
        raise HTTPException(503, "Google sign-in is temporarily unavailable")

    if idinfo.get("email_verified") is not True:
        raise HTTPException(401, "Google has not verified this email address")
    email = normalize_email(idinfo.get("email"))
    if not email:
        raise HTTPException(401, "Invalid Google token")
    assert_gmail(email)

    user = await db.users.find_one({"email": email})
    if not user:
        uid = gen_id()
        name = idinfo.get("name") or email.split("@")[0]
        user = {
            "id": uid, "email": email, "name": name,
            "role": "user", "auth_provider": "google",
            # Phase 9: Google already verified the address, so skip email verification.
            # credentials_set=False routes the user through mandatory local-password setup
            # before the client allows access to protected application screens.
            "email_verified": True,
            "email_verified_at": now_utc(),
            "email_verified_for": email,
            "email_verification_method": "google",
            "email_security_migration": 1,
            "session_version": 0,
            "credentials_set": False,
            "mobile_number": None,
            "mobile_country_code": None,
            "mobile_verified_at": None,
            "created_at": now_utc().isoformat(),
        }
        await db.users.insert_one(user)
    else:
        proof = {"email_verified": True, "email_verified_at": now_utc(),
                 "email_verified_for": email, "email_verification_method": "google"}
        await db.users.update_one({"id": user["id"], "email": email}, {"$set": proof})
        user.update(proof)

    token = create_token(user["id"], email, user.get("session_version", 0))
    return {"access_token": token, "user": _user_payload(user)}


# ---------- Email verification (Phase 9) ----------
@router.post("/auth/verify-email", dependencies=[Depends(enforce_email_ip_limit)])
async def verify_email(body: VerifyEmailIn):
    # Unauthenticated: the single-use token in the email link is the proof of ownership.
    result = await _consume_email_token(body.token, VERIFY_EMAIL, verification_context=True)
    response = {"ok": True}
    if result.password_reset_requested:
        # Reveal the continuation address only after the single-use ownership proof commits.
        response["password_reset_email"] = result.email
    return response


@router.post("/auth/resend-verification", dependencies=[Depends(enforce_email_ip_limit)])
async def resend_verification(user=Depends(get_current_user)):
    if not EMAIL_FEATURES_ENABLED:
        return {"ok": True, "message": "Email verification is currently disabled"}
    if email_is_verified(user):
        return {"ok": True, "message": "Email already verified"}
    email = user["email"]
    assert_gmail(email)
    try:
        await _send_verification(user)
    except (EmailDeliveryError, TransactionUnavailableError):
        raise HTTPException(503, {"code": "email_unavailable", "message": "Email is temporarily unavailable. Please try again later."},
                            headers={"Retry-After": "60"}) from None
    return {"ok": True, "message": "Verification email sent"}


# ---------- Forgot PASSWORD (email link) (Phase 9) ----------
async def _send_reset_for_address(email: str) -> None:
    try:
        user = await db.users.find_one({"email": email})
        if user and not email_is_verified(user):
            # Share verification limits with registration/Profile, without using up the
            # reset-email cooldown that the user needs immediately after verification.
            try:
                await _send_verification(user, password_reset_requested=True)
            except HTTPException as exc:
                if exc.status_code != 429:
                    raise
                await mark_verification_for_recovery(user["id"], user["email"])
            return
        if await claim_email_send(email, RESET_PASSWORD):
            return
        if not user:
            return
        raw = await issue_token(user["id"], RESET_PASSWORD, RESET_TTL)
        await send_auth_email(user["email"], RESET_PASSWORD, build_link("reset-password", raw))
    except Exception:
        # Background errors must not disclose existence or echo a provider/database payload.
        logger.warning("email.reset_delivery_unavailable")


async def _consume_email_token(raw: str, purpose: str, *, verification_context: bool = False, **kwargs):
    try:
        if verification_context:
            return await consume_verification_token(raw)
        return await consume_token(raw, purpose, **kwargs)
    except AuthTokenError as exc:
        raise HTTPException(400, {"code": f"email_link_{exc.code}", "message": str(exc)}) from None
    except TransactionUnavailableError:
        raise HTTPException(503, {"code": "auth_temporarily_unavailable", "message": "Please try again shortly."}) from None


@router.post("/auth/request-password-reset", dependencies=[Depends(enforce_email_ip_limit)])
async def request_password_reset(body: RequestPasswordResetIn, background_tasks: BackgroundTasks):
    # ALWAYS returns the same generic response so the endpoint never reveals whether an
    # account exists or is verified. Unverified accounts receive verification instructions.
    email = body.email.lower().strip()
    assert_gmail(email)
    if EMAIL_FEATURES_ENABLED:
        background_tasks.add_task(_send_reset_for_address, email)
    return {"ok": True, "message": "If this email exists, recovery instructions have been sent."}


@router.post("/auth/reset-password", dependencies=[Depends(enforce_email_ip_limit)])
async def reset_password(body: ResetPasswordIn):
    # Validate the new password BEFORE consuming the token so a rejected password doesn't
    # burn the user's single-use link. Completing reset also finishes password setup for a
    # Google-created account that has not yet configured local credentials.
    if len(body.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    user_id = await _consume_email_token(body.token, RESET_PASSWORD, user_update={
        "$set": {
            "password_hash": hash_secret(body.new_password),
            "credentials_set": True,
        }, "$inc": {"session_version": 1},
    })
    await chat_connections.revoke_user(user_id)
    return {"ok": True}


# ---------- OAuth one-time credential setup (Phase 9) ----------
@router.post("/auth/set-credentials")
async def set_credentials(body: SetCredentialsIn, user=Depends(get_current_user)):
    # Lets a Google-OAuth user configure the local password required before the client grants
    # access to protected application screens.
    if len(body.password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    await db.users.update_one({"id": user["id"]}, {"$set": {
        "password_hash": hash_secret(body.password),
        "credentials_set": True,
    }})
    updated = await db.users.find_one(
        {"id": user["id"]}, {"_id": 0, "password_hash": 0, "pin_hash": 0}
    )
    return {"ok": True, "user": _user_payload(updated)}


# ---------- Self-service password change (signed-in) ----------
@router.post("/auth/change-password")
async def change_password(body: ChangePasswordIn, user=Depends(get_current_user)):
    # In-app "change my password": prove ownership with the current password (no email round-trip),
    # then set a new one. Verification and the JWT are untouched. `get_current_user` strips
    # password_hash from its projection, so re-fetch the full doc to verify.
    if len(body.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    full = await db.users.find_one({"id": user["id"]})
    password_hash = full.get("password_hash") if full else None
    if not password_hash or not verify_secret(body.current_password, password_hash):
        raise HTTPException(401, "Current password is incorrect")
    if verify_secret(body.new_password, password_hash):
        raise HTTPException(400, "New password must be different from your current password")
    await db.users.update_one(
        {"id": user["id"]}, {"$set": {"password_hash": hash_secret(body.new_password)}}
    )
    return {"ok": True}
