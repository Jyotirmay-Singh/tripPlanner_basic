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
