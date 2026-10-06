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
    if trip.get("expense_settlement_activation_version") != 1:
        return unavailable_response(trip, "disabled" if not EXPENSE_SETTLEMENT_ENABLED else "not_activated")

    async def read(session):
        current_trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
        if current_trip is None:
            raise HTTPException(404, "Group not found")
        if not is_super_admin(user) and viewer_id(user) not in current_trip.get("user_ids", []):
            raise HTTPException(403, "Not a member of this group")
        if current_trip.get("expense_settlement_activation_version") != 1:
            return unavailable_response(current_trip, "not_activated")
        ledger = await load_ledger(trip_id, db, coverage=True, session=session, trip=current_trip)
        snapshot = build_coverage_snapshot(ledger)
        if expected_snapshot_id and expected_snapshot_id != snapshot.snapshot_id:
            raise HTTPException(409, detail={"code": "coverage_snapshot_changed", "retryable": True,
                                             "snapshot_id": snapshot.snapshot_id})
        if set(detail_expense_id) - {revision["expense_id"] for revision in snapshot.revisions}:
            raise HTTPException(404, detail={"code": "expense_not_found"})
        return coverage_response(snapshot, user, set(detail_expense_id), capability=EXPENSE_SETTLEMENT_ENABLED,
                                 actions_ready=settlement_intents.actions_ready() and
                                 current_trip.get("financial_write_guard_version") == 1)

    try:
        return await run_snapshot_transaction(read)
    except TransactionUnavailableError:
        return unavailable_response(trip, "unavailable", reasons=["snapshot_transactions_unavailable"])
    except (CoverageError, SettlementLedgerError) as exc:
        return unavailable_response(trip, "review_required", reasons=[exc.code])
