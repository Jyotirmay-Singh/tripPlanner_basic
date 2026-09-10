from fastapi import APIRouter, Depends, HTTPException, Response

from config import INVITE_LINKS_ENABLED
from services.invites import (
    _invite_error,
    current_invite_link,
    public_invite_status,
    reset_invite_link,
)
from utils.deps import _trip_admin_or_403, _trip_or_404, get_current_user
from services.admin_audit import record_admin_action


router = APIRouter()


def _require_invite_links() -> None:
    if not INVITE_LINKS_ENABLED:
        raise _invite_error("disabled")


@router.get("/trips/{trip_id}/invite-link")
async def get_trip_invite_link(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user)
    _require_invite_links()
    return current_invite_link(trip)


@router.post("/trips/{trip_id}/invite-link/reset")
async def reset_trip_invite_link(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_admin_or_403(trip_id, user)
    _require_invite_links()
    link = await reset_invite_link(trip_id)
    await record_admin_action(
        user, "invite.reset", trip=trip, resource_type="trip_invite", resource_id=trip_id,
        changed_fields=("invite_generation",),
    )
    return link


@router.post("/trips/{trip_id}/invites")
async def issue_trip_invite(trip_id: str, user=Depends(get_current_user)):
    """Compatibility alias for installed clients that still call the plural create route."""
    trip = await _trip_or_404(trip_id, user)
    _require_invite_links()
    return current_invite_link(trip)


@router.get("/trips/{trip_id}/invites")
async def get_trip_invites(trip_id: str, user=Depends(get_current_user)):
    """Retired history contract: old clients receive no revoked/expired rows."""
    await _trip_or_404(trip_id, user)
    _require_invite_links()
    return []


@router.post("/trips/{trip_id}/invites/{invite_id}/revoke")
async def revoke_trip_invite(trip_id: str, invite_id: str, user=Depends(get_current_user)):
    await _trip_or_404(trip_id, user)
    raise HTTPException(
        410,
        detail={
            "code": "invite_endpoint_retired",
            "message": "Invite history was replaced by the trip's single resettable link.",
        },
    )


@router.get("/invites/{token}")
async def inspect_invite(token: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return await public_invite_status(token)
