from typing import List, Optional, Literal

from pydantic import AliasChoices, BaseModel, EmailStr, Field, field_validator


class MemberIn(BaseModel):
    name: str
    kind: Literal["individual", "family"] = "individual"
    family_members: List[str] = []  # names of family members
    # Stable per-member ids, parallel (same order/length) to family_members. Entries may be null for
    # newly-added rows (the structured editor sends null -> the server mints an id); when the whole
    # list is omitted the server mints all. Used by per-expense `family_participants` so intra-family
    # participation survives roster edits.
    family_member_ids: Optional[List[Optional[str]]] = None
    email: Optional[EmailStr] = Field(
        default=None, validation_alias=AliasChoices("email", "linked_email")
    )  # optional email to auto-link an app user

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, v: str) -> str:
        v = " ".join((v or "").split())
        if not v:
            raise ValueError("Name is required")
        return v


class MemberUpdate(BaseModel):
    name: Optional[str] = None
    kind: Optional[Literal["individual", "family"]] = None
    family_members: Optional[List[str]] = None
    # Parallel to family_members; entries may be null for newly-added rows (server mints ids),
    # and existing ids are preserved so past expenses keep pointing at the same person.
    family_member_ids: Optional[List[Optional[str]]] = None
    email: Optional[str] = Field(
        default=None, validation_alias=AliasChoices("email", "linked_email")
    )  # can be empty string to clear
    reweight_past: Optional[bool] = True  # if False, snapshot old weights onto past expenses

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = " ".join(v.split())
        if not v:
            raise ValueError("Name cannot be empty")
        return v
