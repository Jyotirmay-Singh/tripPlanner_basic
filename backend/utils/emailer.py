"""Server-only EmailJS delivery. Never log payloads, credentials or action links."""
import asyncio
import time
from urllib.parse import quote, urlsplit

import httpx

from config import (
    logger, APP_NAME, APP_URL, EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY,
    EMAILJS_PRIVATE_KEY, EMAILJS_VERIFICATION_TEMPLATE_ID, EMAILJS_RESET_TEMPLATE_ID,
)

EMAILJS_URL = "https://api.emailjs.com/api/v1.0/email/send"
_send_lock = asyncio.Lock()
_last_send = 0.0


class EmailDeliveryError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__("Email delivery is temporarily unavailable. Please try again later.")


def _trusted_origin() -> str:
    parsed = urlsplit(APP_URL)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise EmailDeliveryError("invalid_app_url")
    return APP_URL.rstrip("/")


def sender_mode_summary() -> str:
    configured = all((EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY,
                      EMAILJS_VERIFICATION_TEMPLATE_ID, EMAILJS_RESET_TEMPLATE_ID))
    return "EMAIL: EmailJS configured" if configured else "EMAIL: EmailJS unavailable (configuration incomplete)"


def build_link(path: str, token: str) -> str:
    if path not in ("verify-email", "reset-password"):
        raise ValueError("Unsupported email action")
    # Fragments never enter HTTP requests to Vercel or Referrer headers.
    return f"{_trusted_origin()}/{path}#token={quote(token, safe='')}"


async def send_auth_email(to: str, purpose: str, link: str) -> None:
    global _last_send
    templates = {"verify_email": EMAILJS_VERIFICATION_TEMPLATE_ID,
                 "reset_password": EMAILJS_RESET_TEMPLATE_ID}
    template = templates.get(purpose)
    if not all((EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, template)):
        raise EmailDeliveryError("unconfigured")
    expected_path = "verify-email" if purpose == "verify_email" else "reset-password"
    if not link.startswith(f"{_trusted_origin()}/{expected_path}#token="):
        raise EmailDeliveryError("invalid_action_url")
    params = {"to_email": to, "app_name": APP_NAME,
              "verification_url" if purpose == "verify_email" else "reset_url": link}
    payload = {"service_id": EMAILJS_SERVICE_ID, "template_id": template,
               "user_id": EMAILJS_PUBLIC_KEY, "accessToken": EMAILJS_PRIVATE_KEY,
               "template_params": params}
    # Production runs one worker. Pace both templates and concurrent requests together.
    try:
        await asyncio.wait_for(_send_lock.acquire(), timeout=5.0)
    except asyncio.TimeoutError:
        logger.warning("email.delivery_failed reason=busy")
        raise EmailDeliveryError("busy") from None
    try:
        await asyncio.sleep(max(0, 1.05 - (time.monotonic() - _last_send)))
        _last_send = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
                response = await client.post(EMAILJS_URL, json=payload)
        except httpx.HTTPError:
            logger.warning("email.delivery_failed reason=network")
            raise EmailDeliveryError("network") from None
    finally:
        _send_lock.release()
    if response.status_code != 200:
        # Provider responses can echo variables. Retain only the status code.
        logger.warning("email.delivery_failed status=%s", response.status_code)
        raise EmailDeliveryError("provider_rejected")
    logger.info("email.dispatched purpose=%s", purpose)
