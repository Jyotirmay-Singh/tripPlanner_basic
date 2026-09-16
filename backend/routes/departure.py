from fastapi import APIRouter, Depends, Response

from models.departure import AccountDeletionIn, MembershipDepartureIn
from services.chat_realtime import chat_connections
from services.departure import (
    account_deletion_impact,
    delete_account,
    leave_membership,
    membership_leave_impact,
)
from utils.deps import _trip_or_404, get_current_user


router = APIRouter()


@router.get("/auth/me/deletion-impact")
async def get_account_deletion_impact(
    response: Response,
    user=Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    return await account_deletion_impact(user)


@router.delete("/auth/me")
async def remove_account(body: AccountDeletionIn, user=Depends(get_current_user)):
    result = await delete_account(
        user,
        confirmation=body.confirmation,
        acknowledge_unsettled=body.acknowledge_unsettled,
        trip_actions=[item.model_dump() for item in body.trip_actions],
    )
    trip_ids = [*result.get("kept_trip_ids", []), *result.get("departed_trip_ids", [])]
    for trip_id in dict.fromkeys(trip_ids):
        await chat_connections.disconnect_users(trip_id, [user["id"]])
    return result


@router.get("/trips/{trip_id}/membership/leave-impact")
async def get_membership_leave_impact(
    trip_id: str,
    response: Response,
    user=Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    trip = await _trip_or_404(trip_id, user)
    return await membership_leave_impact(trip, user["id"])


@router.delete("/trips/{trip_id}/membership")
async def remove_membership(
    trip_id: str,
    body: MembershipDepartureIn,
    user=Depends(get_current_user),
):
    # Preserve the normal 403/404 access contract, then rebuild everything inside the transaction.
    await _trip_or_404(trip_id, user)
    result = await leave_membership(
        trip_id,
        user,
        dissolve_family=body.dissolve_family,
    )
    await chat_connections.disconnect_users(trip_id, [user["id"]])
    return result
