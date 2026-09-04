from fastapi import APIRouter, Depends, Response

from config import INVITE_LINKS_ENABLED
from services.invites import (
    create_invite,
    list_invites,
    public_invite_status,
    revoke_invite,
)
from utils.deps import _trip_admin_or_403, get_current_user


router = APIRouter()


@router.post("/trips/{trip_id}/invites")
async def issue_trip_invite(trip_id: str, user=Depends(get_current_user)):
    if not INVITE_LINKS_ENABLED:
        from services.invites import _invite_error
        raise _invite_error("disabled")
    trip = await _trip_admin_or_403(trip_id, user["id"])
    return await create_invite(trip, user["id"])


@router.get("/trips/{trip_id}/invites")
async def get_trip_invites(trip_id: str, user=Depends(get_current_user)):
    await _trip_admin_or_403(trip_id, user["id"])
    return await list_invites(trip_id)


@router.post("/trips/{trip_id}/invites/{invite_id}/revoke")
async def revoke_trip_invite(trip_id: str, invite_id: str, user=Depends(get_current_user)):
    await _trip_admin_or_403(trip_id, user["id"])
    return await revoke_invite(trip_id, invite_id, user["id"])


@router.get("/invites/{token}")
async def inspect_invite(token: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return await public_invite_status(token)
