"""Compatibility URLs delegate reviewed contracts without inventing cash or consent."""
from models.financial_correction import CorrectionCreate, ReviewedWrite
from models.settlement_intent import SettlementIntentCreate
from services import financial_corrections, settlement_intents
from services.coverage_support import CoverageError


async def submit(trip_id, body: ReviewedWrite, user, *, legacy_settlement_id=None):
    return await settlement_intents.create(trip_id, SettlementIntentCreate(
        quote_id=body.quote_id, quote_hash=body.quote_hash, client_mutation_id=body.client_mutation_id,
        submission_action=body.submission_action, transaction_reference=body.transaction_reference,
        note=body.note), user, legacy_settlement_id=legacy_settlement_id)


async def correct(trip_id, target_id, operations, body: CorrectionCreate, user):
    # Validate path/operation inside the same mutation transaction as approval and application.
    return await financial_corrections.create(trip_id, body, user,
        binding={"target_id": target_id, "operations": sorted(operations)})
