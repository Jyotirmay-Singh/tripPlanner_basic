from typing import List, Optional

from fastapi import HTTPException

from utils.common import gen_id
from utils.email_rules import normalize_email


def normalize_name(name: Optional[str]) -> str:
    if not name:
        return ""
    return " ".join(name.split())


def assign_family_member_ids(
    names: Optional[List[str]],
    provided_ids: Optional[List[Optional[str]]] = None,
    existing_ids: Optional[List[str]] = None,
) -> List[str]:
    """Stable ids parallel to a family's ``family_members`` names.

    - When the client SENT ``family_member_ids`` (``provided_ids`` not None), it is trusted per row:
      a real id is kept, a null/missing row gets a freshly minted id. (The new editor sends the
      existing id for retained rows so past expenses keep pointing at the same person.)
    - When the client did NOT send ids (legacy contract), existing ids are reused positionally
      (append-stable) and the tail is minted, so name-only edits don't churn ids.
    Duplicates/blank ids are always replaced with a fresh id so the array stays unique + full.
    """
    names = names or []
    client_sent = provided_ids is not None
    existing_ids = existing_ids or []
    out: List[str] = []
    used = set()
    for i in range(len(names)):
        pid = None
        if client_sent:
            pid = provided_ids[i] if i < len(provided_ids) else None
        elif i < len(existing_ids):
            pid = existing_ids[i]
        if not pid or pid in used:
            pid = gen_id()
        out.append(pid)
        used.add(pid)
    return out


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
