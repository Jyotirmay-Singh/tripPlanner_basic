from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class CommunityInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class TermsAcceptance(CommunityInput):
    version: str
    age_band: Literal["under_13", "13_17", "18_plus"]


class GuardianRequest(CommunityInput):
    email: EmailStr


class GuardianCode(CommunityInput):
    code: str = Field(min_length=32, max_length=32, pattern=r"^[a-fA-F0-9]{32}$")


class GuardianControls(CommunityInput):
    chat_enabled: bool
    receipts_enabled: bool
    contacts_enabled: bool


class GuardianConsent(GuardianControls, GuardianCode):
    is_parent_or_guardian: Literal[True]


class GuardianVerification(CommunityInput):
    verification_reference: str = Field(min_length=8, max_length=300)


class AgeCorrection(GuardianVerification):
    age_band: Literal["under_13", "13_17", "18_plus"]


class CommunityReport(CommunityInput):
    client_report_id: UUID
    target_type: Literal["message", "receipt", "user"]
    target_id: str = Field(min_length=1, max_length=120)
    reason: Literal["harassment", "inappropriate", "spam", "privacy", "other"]
    details: str = Field(default="", max_length=2000)


class ReportResolution(CommunityInput):
    action: Literal["dismiss", "remove_content", "suspend_user"]
    note: str = Field(min_length=8, max_length=1000)

    @field_validator("note")
    @classmethod
    def require_explanation(cls, value):
        if len(value.strip()) < 8:
            raise ValueError("Explain the moderation decision")
        return value.strip()
