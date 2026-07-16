from typing import List, Literal, Optional

from pydantic import BaseModel


class TripIn(BaseModel):
    name: str
    start_date: str  # YYYY-MM-DD (timezone-free calendar date)
    end_date: str    # YYYY-MM-DD, must be >= start_date
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


class TripUpdate(BaseModel):
    name: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    budget: Optional[float] = None
    currency: Optional[str] = None


class AdminGrant(BaseModel):
    user_id: str


class OwnershipTransfer(BaseModel):
    user_id: str
