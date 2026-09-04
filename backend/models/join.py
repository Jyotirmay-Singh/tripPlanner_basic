from typing import List, Optional, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class JoinCredential(BaseModel):
    """Exactly one bearer credential for resolving a trip join.

    ``code`` keeps every existing client compatible. ``invite_token`` is the revocable,
    expiring credential used by verified HTTPS invitation links.
    """

    code: Optional[str] = None
    invite_token: Optional[str] = None

    @model_validator(mode="after")
    def _exactly_one_credential(self):
        if bool((self.code or "").strip()) == bool((self.invite_token or "").strip()):
            raise ValueError("Provide exactly one of code or invite_token")
        return self


class JoinRequest(JoinCredential):
    """Contextual join payload (Step 12).

    ``mode`` is the joiner's explicit intent. ``None`` preserves the legacy
    auto-behavior (email auto-link, else new individual) for backward compatibility.
    """

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
    # Phase 25 — when set, action="claim" links the caller to ONE family sub-member (this stable
    # per-member id) inside the family `member_id`, stamping its per-member linked-account slot rather
    # than the whole family entity's user_id. Requires the caller's OWN email on that slot.
    family_member_id: Optional[str] = None
    replace_member_id: Optional[str] = None  # advisory hint when action == "join_new"
    # When a clean, exact-email match belongs to a family member and the caller chooses a new
    # identity, this identifies the sub-member whose incorrect email should be detached.  The server
    # always re-resolves the caller's email and treats this only as an advisory UI hint.
    replace_family_member_id: Optional[str] = None

    @field_validator("family_name")
    @classmethod
    def _normalize_family_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = " ".join(v.split())
        if not v:
            raise ValueError("Family name cannot be empty")
        return v


class JoinPreviewRequest(JoinCredential):
    pass


class JoinClaimRequest(JoinCredential):
    """Request owner/admin approval to take an unlinked existing person."""

    member_id: str
    family_member_id: Optional[str] = None


class JoinRejectRequest(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=500)

    @field_validator("reason")
    @classmethod
    def _normalize_reason(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = " ".join(value.split())
        return normalized or None
