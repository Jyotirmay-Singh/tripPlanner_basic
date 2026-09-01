import math
from decimal import Decimal
from typing import Dict, List, Optional, Literal

from pydantic import BaseModel, field_validator, model_validator

from utils.date_rules import normalize_time
from utils.currency_rules import normalize_currency
from models.exchange_rate import ConversionRequest, finite_decimal

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
    # Legacy clients send amount/currency and are supported for same-currency writes. New clients
    # send original_amount/original_currency; the response's existing amount/currency fields remain
    # the canonical trip-currency ledger values.
    amount: Optional[float] = None
    currency: Optional[str] = None  # defaults to the trip's locked official currency
    original_amount: Optional[Decimal] = None
    original_currency: Optional[str] = None
    conversion: Optional[ConversionRequest] = None
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
    original_custom_amounts: Optional[Dict[str, Decimal]] = None
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

    @field_validator("currency")
    @classmethod
    def _check_currency(cls, v):
        return normalize_currency(v, allow_none=True)

    @field_validator("original_currency")
    @classmethod
    def _check_original_currency(cls, v):
        return normalize_currency(v, allow_none=True)

    @field_validator("original_amount", mode="before")
    @classmethod
    def _check_original_amount(cls, v):
        if v is None:
            return None
        parsed = finite_decimal(v, label="original amount")
        if parsed == 0:
            raise ValueError("original amount must be non-zero")
        return parsed

    @field_validator("original_custom_amounts", mode="before")
    @classmethod
    def _check_original_custom_amounts(cls, v):
        if v is None:
            return None
        if not isinstance(v, dict):
            raise ValueError("original custom amounts must be an object")
        return {str(k): finite_decimal(value, label="exact amount") for k, value in v.items()}

    @model_validator(mode="after")
    def _one_amount_contract(self):
        if self.amount is None and self.original_amount is None:
            raise ValueError("amount or original_amount is required")
        if self.amount is not None and self.original_amount is not None:
            raise ValueError("Use original_amount for converted expenses; do not also send amount")
        return self


class ExpenseUpdate(BaseModel):
    amount: Optional[float] = None
    currency: Optional[str] = None
    original_amount: Optional[Decimal] = None
    original_currency: Optional[str] = None
    conversion: Optional[ConversionRequest] = None
    expected_conversion_version: Optional[int] = None
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
    original_custom_amounts: Optional[Dict[str, Decimal]] = None
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

    @field_validator("currency")
    @classmethod
    def _check_currency(cls, v):
        return normalize_currency(v, allow_none=True)

    @field_validator("original_currency")
    @classmethod
    def _check_original_currency(cls, v):
        return normalize_currency(v, allow_none=True)

    @field_validator("original_amount", mode="before")
    @classmethod
    def _check_original_amount(cls, v):
        if v is None:
            return None
        parsed = finite_decimal(v, label="original amount")
        if parsed == 0:
            raise ValueError("original amount must be non-zero")
        return parsed

    @field_validator("original_custom_amounts", mode="before")
    @classmethod
    def _check_original_custom_amounts(cls, v):
        if v is None:
            return None
        if not isinstance(v, dict):
            raise ValueError("original custom amounts must be an object")
        return {str(k): finite_decimal(value, label="exact amount") for k, value in v.items()}
