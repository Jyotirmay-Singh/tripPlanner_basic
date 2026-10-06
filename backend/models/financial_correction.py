"""Reviewed financial changes are a separate contract from legacy CRUD payloads."""
from typing import Literal
from uuid import UUID

from pydantic import ConfigDict, Field, StrictStr, field_validator
from models.settlement_intent import Contract, Mutation


class CorrectionPreview(Contract):
    expected_snapshot_id: StrictStr
    operation: Literal["replace_expense", "void_expense", "replace_cash", "void_cash",
                       "reverse_allocation", "reverse_correction", "update_member", "remove_member",
                       "reassign_family", "reallocate_history", "add_member", "link_person",
                       "grant_admin", "revoke_admin", "transfer_owner", "archive_trip", "leave_group"]
    target_id: StrictStr
    changes: dict = Field(default_factory=dict)
    reason: StrictStr = Field(min_length=1, max_length=1000)

    @field_validator("reason")
    @classmethod
    def reason_is_present(cls, value):
        if not value.strip():
            raise ValueError("A correction reason is required")
        return value.strip()


class CorrectionCreate(Mutation):
    protocol_version: Literal[2] = 2
    preview_id: UUID
    preview_hash: StrictStr


class CorrectionAction(Mutation):
    expected_version: int = Field(ge=0)
    plan_hash: StrictStr
    action: Literal["approve", "consent", "reject", "withdraw", "renew"]
    person_id: StrictStr | None = None
    reason: StrictStr | None = Field(default=None, max_length=1000)
    preview_id: UUID | None = None
    preview_hash: StrictStr | None = None


class ReviewedWrite(Contract):
    protocol_version: Literal[2] = 2
    quote_id: UUID
    quote_hash: StrictStr
    client_mutation_id: UUID
    submission_action: Literal["propose", "report_paid"] = "report_paid"
    transaction_reference: StrictStr | None = None
    note: StrictStr | None = Field(default=None, max_length=1000)


class ReconciliationRequest(Contract):
    mode: Literal["direct", "group", "offset"] = "direct"
    expected_snapshot_id: StrictStr | None = None
    source_ids: list[StrictStr] = Field(default_factory=list, max_length=100)
    shares: list[dict] = Field(default_factory=list, max_length=100)
    cash_legs: list[dict] = Field(default_factory=list, max_length=100)
    reason: StrictStr = Field(min_length=1, max_length=1000)


class ReconciliationApply(Mutation):
    preview_id: UUID
    preview_hash: StrictStr
