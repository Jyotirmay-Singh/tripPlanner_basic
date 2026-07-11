import asyncio
import secrets
from datetime import datetime, timedelta

import resend
from fastapi import APIRouter, HTTPException, Depends
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from config import logger, RESEND_API_KEY, SENDER_EMAIL, APP_URL, GOOGLE_CLIENT_ID, EMAIL_FEATURES_ENABLED
from database import db
from models.auth import (
    RegisterIn, LoginIn, ForgotIn, ResetPinIn, ResetPinByPasswordIn, GoogleAuthIn,
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
    any caller-built dict behave as already-provisioned rather than locked out."""
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
    if not body.pin.isdigit():
        raise HTTPException(400, "PIN must be 4 digits")
    if len(body.password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    uid = gen_id()
    password_hash = hash_secret(body.password)
    doc = {
        "id": uid, "email": email, "name": body.name,
        "password_hash": password_hash,
        "pin_hash": hash_secret(body.pin),
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
    if not user:
        raise HTTPException(401, "Invalid credentials")
    if body.password:
        if not verify_secret(body.password, user["password_hash"]):
            raise HTTPException(401, "Invalid credentials")
    elif body.pin:
        if not verify_secret(body.pin, user["pin_hash"]):
            raise HTTPException(401, "Invalid PIN")
    else:
        raise HTTPException(400, "Provide password or pin")
    token = create_token(user["id"], email)
    return {"access_token": token, "user": _user_payload(user)}


@router.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return user


@router.post("/auth/forgot-pin")
async def forgot_pin(body: ForgotIn):
    email = body.email.lower().strip()
    assert_gmail(email)
    user = await db.users.find_one({"email": email})
    if user:
        token = secrets.token_urlsafe(32)
        await db.password_reset_tokens.insert_one({
            "token": token, "user_id": user["id"], "kind": "pin",
            "expires_at": (now_utc() + timedelta(hours=1)).isoformat(),
            "used": False,
        })
        reset_link = f"{APP_URL}/reset-pin?token={token}" if APP_URL else token
        logger.info(f"[PIN RESET] Email={email}  Token={token}  Link={reset_link}")
        if RESEND_API_KEY:
            try:
                await asyncio.to_thread(resend.Emails.send, {
                    "from": SENDER_EMAIL, "to": [email],
                    "subject": "Reset your Trip Splitter PIN",
                    "html": (
                        f"<div style='font-family:sans-serif'>"
                        f"<h2>Reset your PIN</h2>"
                        f"<p>Hi {user.get('name','there')},</p>"
                        f"<p>Tap the link below to reset your 4-digit PIN. This link expires in 1 hour.</p>"
                        f"<p><a href='{reset_link}' style='background:#1C3F39;color:#fff;padding:12px 20px;border-radius:24px;text-decoration:none;display:inline-block'>Reset PIN</a></p>"
                        f"<p>Or use this token in the app: <b>{token}</b></p>"
                        f"<p style='color:#888;font-size:12px'>If you didn't request this, ignore this email.</p>"
                        f"</div>"
                    ),
                })
            except Exception as e:
                logger.warning(f"Resend send failed: {e}")
    return {"ok": True, "message": "If this email exists, a reset link has been sent."}


@router.post("/auth/reset-pin")
async def reset_pin(body: ResetPinIn):
    if not body.new_pin.isdigit():
        raise HTTPException(400, "PIN must be 4 digits")
    rec = await db.password_reset_tokens.find_one({"token": body.token})
    if not rec or rec.get("used"):
        raise HTTPException(400, "Invalid or already-used token")
    if datetime.fromisoformat(rec["expires_at"]) < now_utc():
        raise HTTPException(400, "Token expired")
    await db.users.update_one({"id": rec["user_id"]},
                              {"$set": {"pin_hash": hash_secret(body.new_pin)}})
    await db.password_reset_tokens.update_one({"token": body.token}, {"$set": {"used": True}})
    return {"ok": True}


@router.post("/auth/reset-pin-by-password")
async def reset_pin_by_password(body: ResetPinByPasswordIn):
    # Self-service PIN reset: prove ownership with the account password (no email round-trip),
    # then set a new PIN. Errors are deliberately generic so we never reveal whether the email
    # exists or which field was wrong.
    if not body.new_pin.isdigit():
        raise HTTPException(400, "PIN must be 4 digits")
    email = body.email.lower().strip()
    assert_gmail(email)
    user = await db.users.find_one({"email": email})
    if not user or not verify_secret(body.password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")
    await db.users.update_one({"id": user["id"]},
                              {"$set": {"pin_hash": hash_secret(body.new_pin)}})
    return {"ok": True}


@router.post("/auth/google")
async def google_auth(body: GoogleAuthIn):
    # GOOGLE_CLIENT_ID may be a single client ID or a comma-separated list of
    # accepted audiences (web + ios + android). expo-auth-session issues an
    # id_token whose `aud` is the *current platform's* client ID, so the backend
    # must accept every platform's client ID or native logins 401. google-auth's
    # verify_oauth2_token forwards `audience` to verify_token, which accepts a list.
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
            "password_hash": hash_secret(secrets.token_urlsafe(16)),
            "pin_hash": hash_secret(secrets.token_urlsafe(16)),
            "role": "user", "auth_provider": "google",
            # Phase 9: Google already verified the address, so skip email verification.
            # credentials_set=False routes the user through a one-time "set PIN + password"
            # step (their pin/password above are random placeholders) so email+PIN quick
            # login works afterwards.
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
    # burn the user's single-use link. PIN is intentionally left unchanged.
    if len(body.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    user_id = await consume_token(body.token, RESET_PASSWORD)
    if not user_id:
        raise HTTPException(400, "Invalid or expired reset link")
    await db.users.update_one(
        {"id": user_id}, {"$set": {"password_hash": hash_secret(body.new_password)}}
    )
    return {"ok": True}


# ---------- OAuth one-time credential setup (Phase 9) ----------
@router.post("/auth/set-credentials")
async def set_credentials(body: SetCredentialsIn, user=Depends(get_current_user)):
    # Lets a Google-OAuth user (whose pin/password are random placeholders) choose a real
    # 4-digit PIN + password so email+PIN and email+password login work afterwards.
    if not body.pin.isdigit():
        raise HTTPException(400, "PIN must be 4 digits")
    if len(body.password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    await db.users.update_one({"id": user["id"]}, {"$set": {
        "pin_hash": hash_secret(body.pin),
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
    # then set a new one. PIN, verification, and the JWT are all untouched. `get_current_user`
    # strips password_hash from its projection, so re-fetch the full doc to verify.
    if len(body.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    full = await db.users.find_one({"id": user["id"]})
    if not full or not verify_secret(body.current_password, full["password_hash"]):
        raise HTTPException(401, "Current password is incorrect")
    if verify_secret(body.new_password, full["password_hash"]):
        raise HTTPException(400, "New password must be different from your current password")
    await db.users.update_one(
        {"id": user["id"]}, {"$set": {"password_hash": hash_secret(body.new_password)}}
    )
    return {"ok": True}


# Backward-compat aliases (kept so old frontend builds keep working)
@router.post("/auth/forgot-password")
async def forgot_password_alias(body: ForgotIn):
    return await forgot_pin(body)
