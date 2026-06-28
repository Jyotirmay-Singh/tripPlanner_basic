from typing import Literal, Optional

from pydantic import BaseModel


class SettleIn(BaseModel):
    # Legacy one-shot "record a completed payment" body (POST /trips/{id}/settle).
    # Kept for backward compatibility; the doc it creates is now stamped status:"paid".
    from_member_id: str
    to_member_id: str
    amount: float


class SettlementCreate(BaseModel):
    # Record a suggested transfer as a durable pending settlement (POST /trips/{id}/settlements).
    # `status` is server-controlled and always starts "pending" — it is not accepted here.
    from_member_id: str
    to_member_id: str
    amount: float
    note: Optional[str] = None


class SettlementPatch(BaseModel):
    # Flip a pending settlement to paid (PATCH /trips/{id}/settlements/{sid}). Only the forward
    # transition is exposed; "paid" is the single accepted value.
    status: Literal["paid"]
