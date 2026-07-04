from typing import Optional

from fastapi import HTTPException, Header

from database import db
from utils.permissions import role_of, can_record_payment
from utils.security import decode_token


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    payload = decode_token(authorization[7:])
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0, "password_hash": 0, "pin_hash": 0})
    if not user:
        raise HTTPException(401, "User not found")
    return user


async def _trip_or_404(trip_id: str, user_id: str) -> dict:
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    if not trip:
        raise HTTPException(404, "Trip not found")
    if user_id not in trip.get("user_ids", []):
        raise HTTPException(403, "Not a member of this trip")
    return trip


def is_trip_admin(trip: dict, user_id: str) -> bool:
    # Owner is always seeded into admin_ids; role_of treats owner as admin-or-above.
    return role_of(trip, user_id) in ("owner", "admin")


async def _trip_admin_or_403(trip_id: str, user_id: str) -> dict:
    trip = await _trip_or_404(trip_id, user_id)
    if not is_trip_admin(trip, user_id):
        raise HTTPException(403, "Admin privileges required")
    return trip


async def _trip_owner_or_403(trip_id: str, user_id: str) -> dict:
    trip = await _trip_or_404(trip_id, user_id)
    if role_of(trip, user_id) != "owner":
        raise HTTPException(403, "Only the trip owner can perform this action")
    return trip


async def _expense_or_404(trip_id: str, expense_id: str) -> dict:
    expense = await db.expenses.find_one({"id": expense_id, "trip_id": trip_id}, {"_id": 0})
    if not expense:
        raise HTTPException(404, "Expense not found")
    return expense


def can_modify_expense(trip: dict, expense: dict, user_id: str) -> bool:
    # Step 10: an expense may be edited/deleted only by its creator or a trip admin
    # (the trip owner is always seeded into admin_ids). Legacy rows without created_by
    # fall through to admin-only.
    return expense.get("created_by") == user_id or is_trip_admin(trip, user_id)


async def _expense_modify_or_403(trip_id: str, expense_id: str, user_id: str) -> tuple[dict, dict]:
    trip = await _trip_or_404(trip_id, user_id)
    expense = await _expense_or_404(trip_id, expense_id)
    if not can_modify_expense(trip, expense, user_id):
        raise HTTPException(403, "Only the expense creator or a trip admin can modify this expense")
    return trip, expense


def can_mark_settlement_paid(trip: dict, settlement: dict, user_id: str) -> bool:
    # Phase 10: a settlement may be flipped pending->paid only by a trip admin (owner is always
    # seeded into admin_ids) or by the LENDER — the app user linked to the creditor member
    # (to_member_id). The lender is who actually knows the money arrived; this stops a borrower
    # from self-marking their own debt paid. Returns False for unmatched/missing ids.
    if is_trip_admin(trip, user_id):
        return True
    lender = next((m for m in trip.get("members", []) if m["id"] == settlement.get("to_member_id")), None)
    return bool(lender and lender.get("user_id") == user_id)


async def _settlement_mark_paid_or_403(trip_id: str, settlement_id: str, user_id: str) -> tuple[dict, dict]:
    trip = await _trip_or_404(trip_id, user_id)
    settlement = await db.settlements.find_one({"id": settlement_id, "trip_id": trip_id}, {"_id": 0})
    if not settlement:
        raise HTTPException(404, "Settlement not found")
    if not can_mark_settlement_paid(trip, settlement, user_id):
        raise HTTPException(403, "Only the lender or a trip admin can mark this settlement paid")
    return trip, settlement


async def _payment_or_403(trip_id: str, payment_id: str, user_id: str) -> tuple[dict, dict]:
    # Phase 20: edit/delete guard for a recorded payment. Gated (via can_record_payment on the stored
    # doc's creditor member) to the RECEIVER or a trip admin — the payer can never touch it.
    trip = await _trip_or_404(trip_id, user_id)
    payment = await db.payments.find_one({"id": payment_id, "trip_id": trip_id}, {"_id": 0})
    if not payment:
        raise HTTPException(404, "Payment not found")
    if not can_record_payment(trip, payment.get("to_member_id"), user_id):
        raise HTTPException(403, "Only the receiver or a trip admin can modify this payment")
    return trip, payment
