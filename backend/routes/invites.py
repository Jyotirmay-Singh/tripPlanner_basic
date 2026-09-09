from fastapi import APIRouter, Depends, Response

from config import INVITE_LINKS_ENABLED
from services.invites import (
    create_invite,
    list_invites,
    public_invite_status,
    revoke_invite,
)
from utils.deps import _trip_or_404, get_current_user, is_trip_admin
from services.admin_audit import record_admin_action


router = APIRouter()


@router.post("/trips/{trip_id}/invites")
async def issue_trip_invite(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user)
    if not INVITE_LINKS_ENABLED:
        from services.invites import _invite_error
        raise _invite_error("disabled")
    created = await create_invite(trip, user)
    await record_admin_action(
        user, "invite.created", trip=trip, resource_type="invite", resource_id=created["id"],
    )
    return created


@router.get("/trips/{trip_id}/invites")
async def get_trip_invites(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user)
    return await list_invites(
        trip_id,
        created_by=None if is_trip_admin(trip, user) else user["id"],
    )


@router.post("/trips/{trip_id}/invites/{invite_id}/revoke")
async def revoke_trip_invite(trip_id: str, invite_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user)
    revoked = await revoke_invite(
        trip_id,
        invite_id,
        user["id"],
        can_revoke_all=is_trip_admin(trip, user),
    )
    await record_admin_action(
        user, "invite.revoked", trip=trip, resource_type="invite", resource_id=invite_id,
        changed_fields=("status", "revoked_at", "revoked_by"),
    )
    return revoked


@router.get("/invites/{token}")
async def inspect_invite(token: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return await public_invite_status(token)
