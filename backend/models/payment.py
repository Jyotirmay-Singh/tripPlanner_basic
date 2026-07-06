from typing import Optional

from pydantic import BaseModel, Field


class PaymentCreate(BaseModel):
    # Record a (possibly partial) payment along a suggested debtor->creditor pair
    # (POST /trips/{id}/payments). `currency`/`created_at`/`recorded_by` are server-controlled.
    # The debtor (from_member_id) is the payer; the creditor (to_member_id) is the receiver.
    from_member_id: str
    to_member_id: str
    amount: float = Field(gt=0, allow_inf_nan=False)
    note: Optional[str] = None


class PaymentPatch(BaseModel):
    # Edit an existing payment (PATCH /trips/{id}/payments/{pid}). Only amount/note are mutable;
    # the direction (from/to members) is fixed. Both fields optional so either can be sent alone.
    amount: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    note: Optional[str] = None
