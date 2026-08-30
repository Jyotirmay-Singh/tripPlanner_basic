from typing import List, Literal, Optional

from pydantic import BaseModel, field_validator

from utils.currency_rules import normalize_currency


class TripIn(BaseModel):
    name: str
    start_date: Optional[str] = None  # YYYY-MM-DD (timezone-free calendar date)
    end_date: Optional[str] = None    # YYYY-MM-DD; when both exist, must be >= start_date
    budget: Optional[float] = None
    currency: str = "INR"
    # Phase 26 — the creator's own identity in this trip. Default "individual" preserves the legacy
    # behavior (creator is a standalone member carrying their login email). "family" makes the creator
    # ONE member inside a family they set up here: family_name + family_members (names) + self_index
    # (which row is them); the server attaches their login email + account to that member slot only.
    self_kind: Literal["individual", "family"] = "individual"
    family_name: Optional[str] = None
    family_members: Optional[List[str]] = None
    self_index: Optional[int] = None

    @field_validator("currency")
    @classmethod
    def _validate_currency(cls, value):
        return normalize_currency(value)


class TripUpdate(BaseModel):
    name: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    budget: Optional[float] = None
    currency: Optional[str] = None

    @field_validator("currency")
    @classmethod
    def _validate_currency(cls, value):
        return normalize_currency(value, allow_none=True)


class AdminGrant(BaseModel):
    user_id: str


class OwnershipTransfer(BaseModel):
    user_id: str
