"""Reusable transactional-email helper for the new verify-email + reset-password flows.

Mirrors the existing forgot-PIN behavior: send via Resend off the event loop, and if Resend
isn't configured (or the send fails) log the link/token so local + free-tier flows still work.
The legacy forgot-PIN endpoint keeps its own inline send untouched -this helper is only used
by the new flows.
"""
import asyncio
from typing import Optional

import resend

from config import logger, RESEND_API_KEY, SENDER_EMAIL, APP_URL


def sender_mode_summary() -> str:
    """One-line, secret-free description of the active email delivery mode (for the startup log).
    Pure detection from existing config - never prints the API key or any token."""
    if not RESEND_API_KEY:
        return ("EMAIL: no RESEND_API_KEY configured - verification/reset links are only LOGGED "
                "(look for '[EMAIL] ... link='); no email is sent")
    if SENDER_EMAIL.strip().lower() == "onboarding@resend.dev":
        return ("EMAIL: Resend test sender (onboarding@resend.dev) - delivers ONLY to the Resend "
                "account owner's inbox; all other recipients fall back to logged links")
    return f"EMAIL: live sender {SENDER_EMAIL} - delivering to all recipients"


def build_link(path: str, token: str) -> str:
    """Build the app deep link for an emailed token. Falls back to the bare token when
    APP_URL is unset (same fallback the forgot-PIN flow uses)."""
    base = APP_URL.rstrip("/") if APP_URL else ""
    if not base:
        return token
    return f"{base}/{path.lstrip('/')}?token={token}"


async def send_email(to: str, subject: str, html: str, *, link_for_log: Optional[str] = None) -> None:
    """Send an email via Resend in a worker thread. The link is always logged (so the flow
    is testable and survives an unconfigured / unreachable sender); a send failure is logged,
    never raised, so email problems can't break the request that triggered them."""
    if link_for_log:
        logger.info(f"[EMAIL] to={to} subject={subject!r} link={link_for_log}")
    if not RESEND_API_KEY:
        logger.debug(f"[EMAIL] send skipped (no RESEND_API_KEY) - link logged only, to={to}")
        return
    try:
        await asyncio.to_thread(resend.Emails.send, {
            "from": SENDER_EMAIL, "to": [to], "subject": subject, "html": html,
        })
        logger.debug(f"[EMAIL] dispatched via Resend (sender={SENDER_EMAIL}) to={to}")
    except Exception as e:  # never let an email failure surface to the caller
        logger.warning(f"Resend send failed: {e}")


def _button(link: str, label: str) -> str:
    return (
        f"<p><a href='{link}' style='background:#1C3F39;color:#fff;padding:12px 20px;"
        f"border-radius:24px;text-decoration:none;display:inline-block'>{label}</a></p>"
    )


def verification_html(name: str, link: str, token: str) -> str:
    return (
        f"<div style='font-family:sans-serif'>"
        f"<h2>Verify your email</h2>"
        f"<p>Hi {name},</p>"
        f"<p>Confirm your email to finish setting up your Trip Splitter account. "
        f"This link expires in 24 hours.</p>"
        f"{_button(link, 'Verify email')}"
        f"<p>Or paste this token in the app: <b>{token}</b></p>"
        f"<p style='color:#888;font-size:12px'>If you didn't create this account, ignore this email.</p>"
        f"</div>"
    )


def password_reset_html(name: str, link: str, token: str) -> str:
    return (
        f"<div style='font-family:sans-serif'>"
        f"<h2>Reset your password</h2>"
        f"<p>Hi {name},</p>"
        f"<p>Tap below to choose a new password. This link expires in 1 hour. "
        f"Your 4-digit PIN is not affected.</p>"
        f"{_button(link, 'Reset password')}"
        f"<p>Or paste this token in the app: <b>{token}</b></p>"
        f"<p style='color:#888;font-size:12px'>If you didn't request this, ignore this email.</p>"
        f"</div>"
    )
