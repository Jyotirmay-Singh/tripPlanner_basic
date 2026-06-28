from typing import List, Optional, Literal

from pydantic import BaseModel, field_validator


class JoinRequest(BaseModel):
    """Contextual join payload (Step 12).

    ``mode`` is the joiner's explicit intent. ``None`` preserves the legacy
    auto-behavior (email auto-link, else new individual) for backward compatibility.
    """

    code: str
    mode: Optional[Literal["individual", "family", "new_family"]] = None
    family_id: Optional[str] = None  # required when mode == "family"
    family_name: Optional[str] = None  # required when mode == "new_family"
    family_members: List[str] = []  # extra human names, only honored for "new_family"
    # Phase 11 — discriminated join-commit. action=None keeps the legacy contract (hardened to
    # never create a same-email duplicate). action="claim" links the caller to an existing stub
    # carrying their OWN email (member_id). action="join_new" creates a new identity per `mode`,
    # removing the caller's own CLEAN stub first (replace_member_id is an advisory hint; the
    # server re-resolves and enforces the financial-history guard regardless).
    action: Optional[Literal["claim", "join_new"]] = None
    member_id: Optional[str] = None  # required when action == "claim"
    replace_member_id: Optional[str] = None  # advisory hint when action == "join_new"

    @field_validator("family_name")
    @classmethod
    def _normalize_family_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = " ".join(v.split())
        if not v:
            raise ValueError("Family name cannot be empty")
        return v


class JoinPreviewRequest(BaseModel):
    code: str
