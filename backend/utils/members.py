from typing import Optional

from fastapi import HTTPException

from utils.email_rules import normalize_email


def normalize_name(name: Optional[str]) -> str:
    if not name:
        return ""
    return " ".join(name.split())


def email_exists(members: list, email: Optional[str], exclude_id: Optional[str] = None) -> bool:
    target = normalize_email(email)
    if not target:
        return False
    for m in members:
        if exclude_id and m.get("id") == exclude_id:
            continue
        if normalize_email(m.get("email")) == target:
            return True
    return False


def assert_unique_email(members: list, email: Optional[str], exclude_id: Optional[str] = None) -> None:
    norm = normalize_email(email)
    if norm and email_exists(members, email, exclude_id):
        raise HTTPException(400, f"A member with email '{norm}' already exists in this trip")
