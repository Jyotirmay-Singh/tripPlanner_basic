import math
from typing import Dict, List, Optional, Literal

from pydantic import BaseModel, field_validator

from utils.date_rules import normalize_time

SplitMode = Literal["PER_CAPITA", "PER_FAMILY", "EXACT"]


def _validate_amount(v):
    """Signed amount rule: any finite non-zero real. Positive = an expense, negative = money
    coming back to the group (refund/reimbursement/cancellation). Rejects 0 and NaN/inf. Used by
    both ExpenseIn (required) and ExpenseUpdate (optional -> None passes through)."""
    if v is None:
        return v
    if not math.isfinite(v) or v == 0:
        raise ValueError("amount must be a non-zero number")
    return v


class ExpenseIn(BaseModel):
    amount: float
    category: str
    description: Optional[str] = ""
    date: str  # DD-MM-YY
    time: Optional[str] = None  # optional wall-clock "HH:MM" (24h); None = no time
    paid_by_member_id: str  # member id (individual or family) who paid
    split_member_ids: List[str] = []  # if empty, split among all
    split_mode: SplitMode = "PER_CAPITA"
    weight_snapshots: Optional[dict] = None  # member_id -> custom weight (e.g. partial family)
    # Intra-family participation (PER_CAPITA and PER_FAMILY): family entity id -> list of
    # participating family_member_ids. Absent / family not a key / empty list => ALL members
    # participate (exact back-compat). Only the family's INTERNAL per-member display split changes;
    # the family's entity total, the trip headcount, the ledger net, and every other entity are
    # untouched.
    family_participants: Optional[Dict[str, List[str]]] = None
    custom_amounts: Optional[Dict[str, float]] = None  # EXACT mode: person-level member_id -> exact amount
    receipt_id: Optional[str] = None  # GridFS receipt id (Step 22); set via the upload endpoint
    receipt_base64: Optional[str] = None  # legacy/read-only inline receipt (superseded by receipt_id)

    @field_validator("time")
    @classmethod
    def _validate_time(cls, v):
        return normalize_time(v)

    @field_validator("amount")
    @classmethod
    def _check_amount(cls, v):
        return _validate_amount(v)


class ExpenseUpdate(BaseModel):
    amount: Optional[float] = None
    category: Optional[str] = None
    description: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None  # optional wall-clock "HH:MM" (24h); explicit null clears it
    paid_by_member_id: Optional[str] = None
    split_member_ids: Optional[List[str]] = None
    split_mode: Optional[SplitMode] = None
    weight_snapshots: Optional[dict] = None
    family_participants: Optional[Dict[str, List[str]]] = None
    custom_amounts: Optional[Dict[str, float]] = None  # EXACT mode: person-level member_id -> exact amount
    receipt_id: Optional[str] = None  # GridFS receipt id (Step 22); set via the upload endpoint
    receipt_base64: Optional[str] = None  # legacy/read-only inline receipt (superseded by receipt_id)
    force: Optional[bool] = False

    @field_validator("time")
    @classmethod
    def _validate_time(cls, v):
        return normalize_time(v)

    @field_validator("amount")
    @classmethod
    def _check_amount(cls, v):
        return _validate_amount(v)
