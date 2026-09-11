from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel, Field, StrictStr, field_validator


class PaymentCreate(BaseModel):
    # Record a (possibly partial) payment along a suggested debtor->creditor pair
    # (POST /trips/{id}/payments). `currency`/`created_at`/`recorded_by` are server-controlled.
    # The debtor (from_member_id) is the payer; the creditor (to_member_id) is the receiver.
    from_member_id: str
    to_member_id: str
    amount: Decimal = Field(gt=0, allow_inf_nan=False)
    note: Optional[str] = None


class PaymentPatch(BaseModel):
    # Edit an existing payment (PATCH /trips/{id}/payments/{pid}). Only amount/note are mutable;
    # the direction (from/to members) is fixed. Both fields optional so either can be sent alone.
    amount: Optional[Decimal] = Field(default=None, gt=0, allow_inf_nan=False)
    note: Optional[str] = None


class PaymentRecipientCandidate(BaseModel):
    """One person who can receive a future app-to-app payment handoff."""

    person_id: str
    name: str
    family_id: Optional[str] = None
    family_name: Optional[str] = None
    account_linked: bool
    upi_id: Optional[str] = None
    upi_updated_at: Optional[str] = None


class PaymentRecipientDetails(BaseModel):
    """Fresh, pair-scoped recipient details; deliberately excludes account identities."""

    trip_id: str
    from_member_id: str
    to_member_id: str
    recipients: List[PaymentRecipientCandidate]


class PaymentHandoffPreviewRequest(BaseModel):
    """Payer-authenticated request for a reviewable external UPI handoff."""

    from_member_id: str
    to_member_id: str
    # Keep money exact at the API boundary. The route applies the trip currency's precision and
    # optional whole-unit policy after the trip has been loaded.
    amount: StrictStr
    quote_id: Optional[StrictStr] = None

    @field_validator("amount")
    @classmethod
    def _non_empty_amount(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Amount must be a decimal string")
        return normalized

    @field_validator("quote_id")
    @classmethod
    def _non_empty_quote_id(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("quote_id cannot be empty")
        return normalized


class PaymentHandoffQuote(BaseModel):
    quote_id: str
    rate: str
    effective_rate_date: Optional[str] = None
    provider: str
    stale: bool
    expires_at: str


class PaymentHandoffPreview(BaseModel):
    """Authoritative, non-ledger preview used immediately before copy/launch."""

    trip_id: str
    trip_name: str
    from_member_id: str
    from_name: str
    to_member_id: str
    to_name: str
    source_amount: str
    source_currency: str
    current_payable: str
    inr_amount: str
    quote: PaymentHandoffQuote
    recipients: List[PaymentRecipientCandidate]
