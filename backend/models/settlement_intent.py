"""Reviewed settlement contracts. Money is exact whole-unit text, never trusted floats."""
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator

from models.payment_attempt import PaymentHandoffMethod, normalize_transaction_reference
from services.coverage_support import money, whole_units


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ShareSelection(Contract):
    share_id: StrictStr
    amount: StrictStr

    @field_validator("amount")
    @classmethod
    def amount_is_whole(cls, value):
        return money(whole_units(value))


class CashSelection(Contract):
    from_member_id: StrictStr
    to_member_id: StrictStr
    amount: StrictStr

    @field_validator("amount")
    @classmethod
    def amount_is_whole(cls, value):
        return money(whole_units(value))


class PartySelection(Contract):
    from_member_id: StrictStr
    to_member_id: StrictStr
    payer_person_id: StrictStr
    recipient_person_id: StrictStr


class SettlementQuoteRequest(Contract):
    mode: Literal["direct", "group", "offset"]
    method: Literal["upi", "cash", "bank", "offset"]
    expected_snapshot_id: StrictStr
    shares: list[ShareSelection] = Field(default_factory=list, max_length=100)
    cash_legs: list[CashSelection] = Field(default_factory=list, max_length=100)
    parties: list[PartySelection] = Field(default_factory=list, max_length=100)


class Mutation(Contract):
    client_mutation_id: UUID


class SettlementIntentCreate(Mutation):
    submission_action: Literal["propose", "report_paid"] = "report_paid"
    quote_id: UUID
    quote_hash: StrictStr
    transaction_reference: StrictStr | None = None
    note: StrictStr | None = Field(default=None, max_length=1000)

    @field_validator("transaction_reference", mode="before")
    @classmethod
    def reference(cls, value):
        return normalize_transaction_reference(value)


class IntentAction(Mutation):
    expected_intent_version: int = Field(ge=0)
    plan_hash: StrictStr
    action: Literal["start", "report_paid", "cancel"]
    handoff_method: PaymentHandoffMethod = "copy"
    transaction_reference: StrictStr | None = None
    note: StrictStr | None = Field(default=None, max_length=1000)

    @field_validator("transaction_reference", mode="before")
    @classmethod
    def reference(cls, value):
        return normalize_transaction_reference(value)


class IntentApproval(Mutation):
    expected_intent_version: int = Field(ge=0)
    plan_hash: StrictStr
    action: Literal["confirm_received", "report_not_received", "reject", "resolve_not_sent",
                    "consent", "decline_allocation", "admin_override", "reverse_allocation", "cancel"]
    leg_id: StrictStr | None = None
    person_id: StrictStr | None = None
    reason: StrictStr | None = Field(default=None, max_length=1000)
