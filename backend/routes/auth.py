from datetime import timedelta

from fastapi import APIRouter, HTTPException, Depends
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from config import GOOGLE_CLIENT_ID, EMAIL_FEATURES_ENABLED
from database import db
from models.auth import (
    RegisterIn, LoginIn, GoogleAuthIn,
    VerifyEmailIn, RequestPasswordResetIn, ResetPasswordIn, SetCredentialsIn, ChangePasswordIn,
)
from utils.common import gen_id, now_utc
from utils.email_rules import assert_gmail, normalize_email
from utils.security import hash_secret, verify_secret, create_token
from utils.deps import get_current_user
from utils.auth_tokens import (
    issue_token, consume_token, seconds_since_last, VERIFY_EMAIL, RESET_PASSWORD,
)
from utils.emailer import send_email, build_link, verification_html, password_reset_html

# Email-token lifetimes (Phase 9): verification link 24h, password-reset link 1h.
VERIFY_TTL = timedelta(hours=24)
RESET_TTL = timedelta(hours=1)
# Minimum seconds between "resend verification email" requests (per user).
RESEND_COOLDOWN_SECONDS = 60

router = APIRouter()

# Minimum account-password length (length-only; no complexity rules). Mirrored client-side in
# frontend/src/validation.ts (MIN_PASSWORD_LENGTH).
MIN_PASSWORD_LENGTH = 9


# ---------- Auth ----------
def _user_payload(user: dict) -> dict:
    """The public user object returned alongside an access token. `email_verified` /
    `credentials_set` default True so legacy rows (read before the startup backfill) and
    any caller-built dict behave as already-provisioned rather than locked out. The
    credential flag now means that a Google-created account has configured a local password."""
    return {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "role": user.get("role", "user"),
        "email_verified": user.get("email_verified", True),
        "credentials_set": user.get("credentials_set", True),
    }


async def _send_verification(user: dict) -> None:
    """Issue a fresh verify-email token (invalidating older ones) and email the link."""
    raw = await issue_token(user["id"], VERIFY_EMAIL, VERIFY_TTL)
    link = build_link("verify-email", raw)
    await send_email(
        user["email"], "Verify your Trip Splitter email",
        verification_html(user.get("name", "there"), link, raw), link_for_log=link,
    )


@router.post("/auth/register")
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
        # Phase 9: new email/password signups start UNVERIFIED (soft gate — they can still
        # log in, the app shows a "verify your email" banner) but already have credentials.
        # When email features are ghosted (EMAIL_FEATURES_ENABLED=false) there is no way to
        # deliver/verify, so new signups are marked verified up-front and no email is sent.
        "email_verified": not EMAIL_FEATURES_ENABLED,
        "credentials_set": True,
        "created_at": now_utc().isoformat(),
    }
    await db.users.insert_one(doc)
    if EMAIL_FEATURES_ENABLED:
        await _send_verification(doc)
    token = create_token(uid, email)
    return {"access_token": token, "user": _user_payload(doc)}


@router.post("/auth/login")
async def login(body: LoginIn):
    email = body.email.lower().strip()
    assert_gmail(email)
    user = await db.users.find_one({"email": email})
    password_hash = user.get("password_hash") if user else None
    if not password_hash or not verify_secret(body.password, password_hash):
        raise HTTPException(401, "Invalid email or password")
    token = create_token(user["id"], email)
    return {"access_token": token, "user": _user_payload(user)}


@router.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return user


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
            "credentials_set": False,
            "created_at": now_utc().isoformat(),
        }
        await db.users.insert_one(user)

    token = create_token(user["id"], email)
    return {"access_token": token, "user": _user_payload(user)}


# ---------- Email verification (Phase 9) ----------
@router.post("/auth/verify-email")
async def verify_email(body: VerifyEmailIn):
    # Unauthenticated: the single-use token in the email link is the proof of ownership.
    user_id = await consume_token(body.token, VERIFY_EMAIL)
    if not user_id:
        raise HTTPException(400, "Invalid or expired verification link")
    await db.users.update_one({"id": user_id}, {"$set": {"email_verified": True}})
    return {"ok": True}


@router.post("/auth/resend-verification")
async def resend_verification(user=Depends(get_current_user)):
    if not EMAIL_FEATURES_ENABLED:
        # Ghosted: nothing to send (and new users are already marked verified).
        return {"ok": True, "message": "Email verification is currently disabled"}
    if user.get("email_verified", True):
        return {"ok": True, "message": "Email already verified"}
    email = user["email"]
    assert_gmail(email)
    last = await seconds_since_last(user["id"], VERIFY_EMAIL)
    if last is not None and last < RESEND_COOLDOWN_SECONDS:
        raise HTTPException(429, "Please wait a moment before requesting another email")
    await _send_verification(user)
    return {"ok": True, "message": "Verification email sent"}


# ---------- Forgot PASSWORD (email link) (Phase 9) ----------
@router.post("/auth/request-password-reset")
async def request_password_reset(body: RequestPasswordResetIn):
    # ALWAYS returns the same generic response so the endpoint never reveals whether an
    # account exists (no enumeration). The link is only emailed when the account is real.
    email = body.email.lower().strip()
    assert_gmail(email)
    # When ghosted, skip issuing/sending entirely (nothing would deliver) — but keep the SAME
    # generic response so the endpoint's behavior is indistinguishable and reveals nothing.
    if EMAIL_FEATURES_ENABLED:
        user = await db.users.find_one({"email": email})
        if user:
            raw = await issue_token(user["id"], RESET_PASSWORD, RESET_TTL)
            link = build_link("reset-password", raw)
            await send_email(
                email, "Reset your Trip Splitter password",
                password_reset_html(user.get("name", "there"), link, raw), link_for_log=link,
            )
    return {"ok": True, "message": "If this email exists, a reset link has been sent."}


@router.post("/auth/reset-password")
async def reset_password(body: ResetPasswordIn):
    # Validate the new password BEFORE consuming the token so a rejected password doesn't
    # burn the user's single-use link. Completing reset also finishes password setup for a
    # Google-created account that has not yet configured local credentials.
    if len(body.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    user_id = await consume_token(body.token, RESET_PASSWORD)
    if not user_id:
        raise HTTPException(400, "Invalid or expired reset link")
    await db.users.update_one(
        {"id": user_id}, {"$set": {
            "password_hash": hash_secret(body.new_password),
            "credentials_set": True,
        }}
    )
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
