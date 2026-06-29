from fastapi import APIRouter, Depends

from database import db
from services.spend_summary import aggregate_spend
from utils.deps import get_current_user, _trip_or_404

router = APIRouter()


# ---------- Spend insights (Phase 12) ----------
@router.get("/trips/{trip_id}/spend-summary")
async def spend_summary(trip_id: str, user=Depends(get_current_user)):
    # Read-only ranking of GROSS amount paid per entity (individual or family). Membership-gated
    # by _trip_or_404 (same gate as /balances): 404 unknown trip, 403 non-member. Reuses the pure
    # services.spend_summary.aggregate_spend — split/settlement-independent, refunds excluded.
    trip = await _trip_or_404(trip_id, user["id"])
    expenses = await db.expenses.find({"trip_id": trip_id}, {"_id": 0}).to_list(5000)
    out = aggregate_spend(trip["members"], expenses)
    out["currency"] = trip.get("currency", "INR")
    return out
