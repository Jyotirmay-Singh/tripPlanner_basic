from typing import Optional
from datetime import datetime

from fastapi import HTTPException

ALLOWED_EMAIL_DOMAIN = "gmail.com"


def email_is_verified(user: dict) -> bool:
    return (user.get("email_verified") is True
            and user.get("email_verified_for") == user.get("email")
            and isinstance(user.get("email_verified_at"), datetime)
            and user.get("email_verification_method") in ("email_link", "google"))


def normalize_email(email: Optional[str]) -> Optional[str]:
    if not email:
        return None
    e = email.strip().lower()
    return e or None


def is_allowed_email(email: Optional[str]) -> bool:
    e = normalize_email(email)
    if e is None:
        return True
    return e.endswith(f"@{ALLOWED_EMAIL_DOMAIN}")


def assert_gmail(email: Optional[str]) -> None:
    if not is_allowed_email(email):
        raise HTTPException(400, f"Only @{ALLOWED_EMAIL_DOMAIN} email addresses are allowed")
