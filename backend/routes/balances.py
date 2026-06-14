from fastapi import APIRouter, Depends

from database import db
from models.settlement import SettleIn
from utils.common import gen_id, now_utc
from utils.deps import get_current_user, _trip_or_404
from utils.balances import _compute_balances

router = APIRouter()


# ---------- Balances / Settle Up ----------
@router.get("/trips/{trip_id}/balances")
async def balances(trip_id: str, user=Depends(get_current_user)):
    await _trip_or_404(trip_id, user["id"])
    return await _compute_balances(trip_id)


@router.post("/trips/{trip_id}/settle")
async def settle(trip_id: str, body: SettleIn, user=Depends(get_current_user)):
    await _trip_or_404(trip_id, user["id"])
    doc = {"id": gen_id(), "trip_id": trip_id,
           "from_member_id": body.from_member_id,
           "to_member_id": body.to_member_id,
           "amount": float(body.amount),
           "created_at": now_utc().isoformat(),
           "created_by": user["id"]}
    await db.settlements.insert_one(doc)
    doc.pop("_id", None)
    return doc
