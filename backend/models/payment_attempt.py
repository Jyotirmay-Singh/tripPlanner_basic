import re
from typing import Literal, Optional

from pydantic import BaseModel, StrictStr, field_validator, model_validator


PaymentHandoffMethod = Literal["copy", "google-pay", "phonepe", "paytm", "bhim"]
PaymentAttemptSenderAction = Literal["report_paid", "cancel"]
PaymentAttemptRecipientAction = Literal[
    "confirm_received",
    "report_not_received",
    "close_review",
]

_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def normalize_transaction_reference(value: object) -> Optional[str]:
    """Return a private, user-entered reference without implying bank verification."""

    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Transaction reference must be text")
    normalized = value.strip()
    if not normalized:
        return None
    if len(normalized) > 100:
        raise ValueError("Transaction reference must be 100 characters or fewer")
    if _CONTROL_CHARACTERS.search(normalized):
        raise ValueError("Transaction reference cannot contain control characters")
    return normalized


def _clean_identifier(value: str, label: str) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > 200 or _CONTROL_CHARACTERS.search(normalized):
        raise ValueError(f"{label} is invalid")
    return normalized


class PaymentAttemptCreate(BaseModel):
    quote_id: StrictStr
    recipient_person_id: StrictStr
    handoff_method: PaymentHandoffMethod

    @field_validator("quote_id")
    @classmethod
    def _quote_id(cls, value: str) -> str:
        return _clean_identifier(value, "quote_id")

    @field_validator("recipient_person_id")
    @classmethod
    def _recipient_person_id(cls, value: str) -> str:
        return _clean_identifier(value, "recipient_person_id")


class PaymentAttemptSenderPatch(BaseModel):
    action: PaymentAttemptSenderAction
    transaction_reference: Optional[StrictStr] = None

    @field_validator("transaction_reference", mode="before")
    @classmethod
    def _transaction_reference(cls, value: object) -> Optional[str]:
        return normalize_transaction_reference(value)

    @model_validator(mode="after")
    def _reference_only_for_paid_report(self):
        if self.action == "cancel" and self.transaction_reference is not None:
            raise ValueError("A canceled attempt cannot include a transaction reference")
        return self


class PaymentAttemptRecipientPatch(BaseModel):
    action: PaymentAttemptRecipientAction
