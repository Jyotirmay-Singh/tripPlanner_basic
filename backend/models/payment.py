from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel, Field


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
