from typing import Optional

from fastapi import HTTPException, Header

from database import db
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
    return user_id in trip.get("admin_ids", [])


async def _trip_admin_or_403(trip_id: str, user_id: str) -> dict:
    trip = await _trip_or_404(trip_id, user_id)
    if not is_trip_admin(trip, user_id):
        raise HTTPException(403, "Admin privileges required")
    return trip
