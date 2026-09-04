import os

from fastapi import APIRouter

from config import (
    CATEGORIES,
    EMAIL_FEATURES_ENABLED,
    INVITE_LINKS_ENABLED,
    MULTI_CURRENCY_EXPENSES_ENABLED,
    WHOLE_UNIT_SETTLEMENTS_ENABLED,
)

router = APIRouter()
CHAT_PROTOCOL_VERSION = 1


def _deployment_revision() -> str:
    """Return a non-secret build identifier suitable for health diagnostics."""
    revision = os.environ.get("RENDER_GIT_COMMIT") or os.environ.get("GIT_COMMIT") or "local"
    return revision[:12]


# ---------- Meta ----------
@router.get("/meta/categories")
async def get_categories():
    return CATEGORIES


@router.get("/meta/config")
async def get_config():
    # Public, DB-free client bootstrap flags. `email_features_enabled` lets the app hide the
    # email-verification banner + "Forgot password?" link at runtime while those flows are
    # ghosted, so re-enabling is a backend env flip with no frontend rebuild.
    return {
        "email_features_enabled": EMAIL_FEATURES_ENABLED,
        "invite_links_enabled": INVITE_LINKS_ENABLED,
        "multi_currency_expenses_enabled": MULTI_CURRENCY_EXPENSES_ENABLED,
        "whole_unit_settlements_enabled": WHOLE_UNIT_SETTLEMENTS_ENABLED,
        "chat_protocol_version": CHAT_PROTOCOL_VERSION,
    }


@router.get("/health")
async def health():
    # Liveness probe for the hosting platform's health check (Render healthCheckPath=/api/health).
    # Deliberately does NOT touch the DB so a transient Mongo hiccup can't trigger a restart loop.
    return {
        "status": "ok",
        "revision": _deployment_revision(),
        "chat_protocol_version": CHAT_PROTOCOL_VERSION,
    }
