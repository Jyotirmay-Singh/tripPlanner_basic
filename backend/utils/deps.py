from typing import Optional

from fastapi import HTTPException, Header

from database import db
from utils.permissions import role_of
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
