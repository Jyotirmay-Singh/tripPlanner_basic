"""Authenticated coverage reads and reviewed settlement report/approval endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query

from config import EXPENSE_SETTLEMENT_ENABLED
from database import db
from services.coverage_journal import run_snapshot_transaction
from services.coverage_read import coverage_response, unavailable_response
from services.coverage_support import CoverageError
from services.expense_coverage import build_coverage_snapshot
from services.ledger_snapshot import load_ledger
from services.ledger_transactions import TransactionUnavailableError
from services.settlement_engine import SettlementLedgerError
from utils.deps import _trip_or_404, get_current_user
from utils.permissions import is_super_admin, viewer_id

router = APIRouter()

from models.settlement_intent import SettlementQuoteRequest, SettlementIntentCreate, IntentAction, IntentApproval
from services import settlement_intents
from models.financial_correction import CorrectionPreview, CorrectionCreate, CorrectionAction
from services import financial_corrections
from models.financial_correction import ReconciliationRequest, ReconciliationApply
from services import financial_reconciliation


@router.get("/trips/{trip_id}/historical-reconciliation")
async def historical_review(trip_id: str, user=Depends(get_current_user)):
    """Read-only, redacted report; this endpoint never upgrades or activates a group."""
    from services.historical_reconciliation import load_review_report
    from utils.permissions import role_of
    async def read(session):
        trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
        actor = await db.users.find_one({"id": user["id"]}, {"_id": 0}, session=session)
        if not trip:
            raise HTTPException(404, "Group not found")
        from services.coverage_allocations import _current_access
        if not _current_access(trip, actor) or role_of(trip, actor or {}) not in {"owner", "admin", "super_admin"}:
            raise HTTPException(403, "Admin review required")
        report = await load_review_report(trip_id, db, trip=trip, session=session,
            prerequisites=await financial_corrections.index_prerequisites(db))
        report["runs"] = await db.reconciliation_runs.find({"trip_id": trip_id},
            {"_id": 0, "id": 1, "status": 1, "plan_hash": 1, "created_at": 1, "applied_at": 1,
             "record_count": 1, "staged_count": 1}, session=session).to_list(None)
        return report
    return await settlement_intents.transaction(read)


@router.post("/trips/{trip_id}/reconciliation-previews")
async def reconciliation_preview(trip_id: str, body: ReconciliationRequest, user=Depends(get_current_user)):
    return await financial_reconciliation.preview(trip_id, body, user)


@router.post("/trips/{trip_id}/reconciliations")
async def reconciliation_apply(trip_id: str, body: ReconciliationApply, user=Depends(get_current_user)):
    return await financial_reconciliation.apply(trip_id, body, user)


@router.post("/trips/{trip_id}/correction-previews")
async def correction_preview(trip_id: str, body: CorrectionPreview, user=Depends(get_current_user)):
    return await financial_corrections.preview(trip_id, body, user)


@router.post("/trips/{trip_id}/corrections")
async def correction_create(trip_id: str, body: CorrectionCreate, user=Depends(get_current_user)):
    return await financial_corrections.create(trip_id, body, user)


@router.get("/trips/{trip_id}/corrections")
async def correction_history(trip_id: str, user=Depends(get_current_user)):
    return await financial_corrections.history(trip_id, user)


@router.get("/trips/{trip_id}/corrections/{correction_id}")
async def correction_detail(trip_id: str, correction_id: str, user=Depends(get_current_user)):
    return await financial_corrections.history(trip_id, user, correction_id)


@router.post("/trips/{trip_id}/corrections/{correction_id}/actions")
async def correction_action(trip_id: str, correction_id: str, body: CorrectionAction, user=Depends(get_current_user)):
    return await financial_corrections.action(trip_id, correction_id, body, user)


@router.post("/trips/{trip_id}/settlement-quotes")
async def settlement_quote(trip_id: str, body: SettlementQuoteRequest, user=Depends(get_current_user)):
    return await settlement_intents.quote(trip_id, body, user)


@router.post("/trips/{trip_id}/settlement-intents")
async def settlement_intent_create(trip_id: str, body: SettlementIntentCreate, user=Depends(get_current_user)):
    return await settlement_intents.create(trip_id, body, user)


@router.get("/trips/{trip_id}/settlement-intents")
async def settlement_intent_list(trip_id: str, user=Depends(get_current_user)):
    return await settlement_intents.list_intents(trip_id, user)


@router.get("/trips/{trip_id}/settlement-intents/{intent_id}")
async def settlement_intent_detail(trip_id: str, intent_id: str, user=Depends(get_current_user)):
    return await settlement_intents.detail(trip_id, intent_id, user)


@router.post("/trips/{trip_id}/settlement-intents/{intent_id}/legs/{leg_id}/actions")
async def settlement_leg_action(trip_id: str, intent_id: str, leg_id: str, body: IntentAction, user=Depends(get_current_user)):
    return await settlement_intents.leg_action(trip_id, intent_id, leg_id, body, user)


@router.post("/trips/{trip_id}/settlement-intents/{intent_id}/approvals")
async def settlement_intent_approval(trip_id: str, intent_id: str, body: IntentApproval, user=Depends(get_current_user)):
    return await settlement_intents.approve(trip_id, intent_id, body, user)


@router.get("/trips/{trip_id}/expense-settlement")
async def expense_settlement(trip_id: str, detail_expense_id: list[str] = Query(default=[]),
                             expected_snapshot_id: str | None = None, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user)
    if len(detail_expense_id) > 100:
        raise HTTPException(422, detail={"code": "too_many_detail_expenses", "limit": 100})
    if trip.get("expense_settlement_activation_version") != 1 and trip.get("financial_write_guard_version") != 2:
        return unavailable_response(trip, "disabled" if not EXPENSE_SETTLEMENT_ENABLED else "not_activated")

    async def read(session):
        current_trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
        if current_trip is None:
            raise HTTPException(404, "Group not found")
        if not is_super_admin(user) and viewer_id(user) not in current_trip.get("user_ids", []):
            raise HTTPException(403, "Not a member of this group")
        if current_trip.get("expense_settlement_activation_version") != 1 and current_trip.get("financial_write_guard_version") != 2:
            return unavailable_response(current_trip, "not_activated")
        ledger = await load_ledger(trip_id, db, coverage=True, session=session, trip=current_trip)
        snapshot = build_coverage_snapshot(ledger)
        if expected_snapshot_id and expected_snapshot_id != snapshot.snapshot_id:
            raise HTTPException(409, detail={"code": "coverage_snapshot_changed", "retryable": True,
                                             "snapshot_id": snapshot.snapshot_id})
        if set(detail_expense_id) - {revision["expense_id"] for revision in snapshot.revisions}:
            raise HTTPException(404, detail={"code": "expense_not_found"})
        return coverage_response(snapshot, user, set(detail_expense_id), capability=EXPENSE_SETTLEMENT_ENABLED and
                                 current_trip.get("expense_settlement_activation_version") == 1,
                                 actions_ready=settlement_intents.actions_ready() and
                                 current_trip.get("financial_write_guard_version") in {1, 2})

    try:
        return await run_snapshot_transaction(read)
    except TransactionUnavailableError:
        return unavailable_response(trip, "unavailable", reasons=["snapshot_transactions_unavailable"])
    except (CoverageError, SettlementLedgerError) as exc:
        return unavailable_response(trip, "review_required", reasons=[exc.code])
