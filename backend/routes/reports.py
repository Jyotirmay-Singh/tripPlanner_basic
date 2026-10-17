"""Report endpoints: unchanged download contracts, one reconciled snapshot per export."""

import io

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse

from database import db
from utils.deps import get_current_user, _trip_or_404, is_trip_admin
from utils.date_rules import ensure_date_range
from utils.balances import _compute_balances
from utils.security import decode_token
from utils.money_policy import whole_money
from services.report_model import ReportSnapshot, ReportReconciliationError, build_report_data
from services.report_xlsx import build_report_xlsx
from services.report_pdf import build_report_pdf

router = APIRouter()


def _money_value(value, currency: str = "INR") -> int:
    return whole_money(value, reject_nonzero_to_zero=False)


async def _load_report_expenses(trip_id: str) -> list:
    """Load the complete transaction set, including money-back entries."""
    return await db.expenses.find({"trip_id": trip_id}, {"_id": 0}).to_list(length=None)


async def _load_migration_adjustment(trip_id: str):
    collection = getattr(db, "money_migration_adjustments", None)
    if collection is None:
        return None
    return await collection.find_one({"trip_id": trip_id}, {"_id": 0})


async def _download_report_data(trip_id: str, token: str):
    payload = decode_token(token)
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user:
        raise HTTPException(401, "User not found")
    trip = ensure_date_range(await _trip_or_404(trip_id, user))
    expenses = await _load_report_expenses(trip_id)
    settlements = await db.settlements.find(
        {"trip_id": trip_id, "status": {"$ne": "pending"}}, {"_id": 0}
    ).to_list(None)
    payments = await db.payments.find({"trip_id": trip_id}, {"_id": 0}).to_list(None)
    migration = await _load_migration_adjustment(trip_id)
    snapshot = ReportSnapshot(trip, tuple(expenses), tuple(settlements), tuple(payments), migration)
    try:
        return build_report_data(snapshot, diagnostic=is_trip_admin(trip, user))
    except ReportReconciliationError as exc:
        raise HTTPException(
            409, "This report could not be reconciled with the group's balances. "
            "Ask a group admin to review the source records. " + str(exc)
        ) from exc


@router.get("/trips/{trip_id}/report")
async def report(trip_id: str, user=Depends(get_current_user)):
    trip = ensure_date_range(await _trip_or_404(trip_id, user))
    expenses = await _load_report_expenses(trip_id)
    bal = await _compute_balances(trip_id, diagnostic=is_trip_admin(trip, user))
    # category breakdown — signed amounts net together (a refund reduces its category + the total).
    by_cat = {}
    by_date = {}
    total_expense = 0.0
    for e in expenses:
        by_cat[e["category"]] = by_cat.get(e["category"], 0) + e["amount"]
        by_date[e["date"]] = by_date.get(e["date"], 0) + e["amount"]
        total_expense += e["amount"]
    currency = trip.get("currency", "INR")
    return {
        "trip": trip,
        "total_expense": _money_value(total_expense, currency),
        "budget": trip.get("budget"),
        "by_category": [
            {"category": k, "amount": _money_value(v, currency)}
            for k, v in by_cat.items()
        ],
        "by_date": [
            {"date": k, "amount": _money_value(v, currency)}
            for k, v in sorted(by_date.items())
        ],
        "balances": bal,
    }


@router.get("/trips/{trip_id}/report.xlsx")
async def report_xlsx(trip_id: str, token: str, _unused=None):
    data = await _download_report_data(trip_id, token)
    filename = f"{data.snapshot.trip['name'].replace(' ', '_')}_report.xlsx"
    return StreamingResponse(
        io.BytesIO(build_report_xlsx(data)),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/trips/{trip_id}/report.pdf")
async def report_pdf(trip_id: str, token: str, _unused=None):
    data = await _download_report_data(trip_id, token)
    filename = f"{data.snapshot.trip['name'].replace(' ', '_')}_report.pdf"
    return StreamingResponse(
        io.BytesIO(build_report_pdf(data)),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
