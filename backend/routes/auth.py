import asyncio
import secrets
from datetime import datetime, timedelta

import resend
from fastapi import APIRouter, HTTPException, Depends
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from config import logger, RESEND_API_KEY, SENDER_EMAIL, APP_URL, GOOGLE_CLIENT_ID
from database import db
from models.auth import RegisterIn, LoginIn, ForgotIn, ResetPinIn, ResetPinByPasswordIn, GoogleAuthIn
from utils.common import gen_id, now_utc
from utils.email_rules import assert_gmail, normalize_email
from utils.security import hash_secret, verify_secret, create_token
from utils.deps import get_current_user

router = APIRouter()

# Minimum account-password length (length-only; no complexity rules). Mirrored client-side in
# frontend/src/validation.ts (MIN_PASSWORD_LENGTH).
MIN_PASSWORD_LENGTH = 9


# ---------- Auth ----------
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
        "created_at": now_utc().isoformat(),
    }
    await db.users.insert_one(doc)
    token = create_token(uid, email)
    return {"access_token": token, "user": {"id": uid, "email": email, "name": body.name, "role": "user"}}


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
    return {"access_token": token,
            "user": {"id": user["id"], "email": email, "name": user["name"], "role": user.get("role", "user")}}


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
            "created_at": now_utc().isoformat(),
        }
        await db.users.insert_one(user)

    token = create_token(user["id"], email)
    return {"access_token": token,
            "user": {"id": user["id"], "email": email, "name": user["name"], "role": user.get("role", "user")}}


# Backward-compat aliases (kept so old frontend builds keep working)
@router.post("/auth/forgot-password")
async def forgot_password_alias(body: ForgotIn):
    return await forgot_pin(body)
