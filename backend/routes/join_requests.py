from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from database import db
from models.join import JoinClaimRequest, JoinRejectRequest
from services.join_requests import (
    approve_request,
    cancel_request,
    create_request,
    get_request_for_user,
    list_requests,
    reject_request,
    request_payload,
)
from services.push_notifications import enqueue_notification_event
from utils.deps import _trip_admin_or_403, get_current_user


router = APIRouter()


async def _request_for_trip_or_404(trip_id: str, request_id: str) -> dict:
    document = await db.join_requests.find_one(
        {"id": request_id, "trip_id": trip_id}, {"_id": 0},
    )
    if not document:
        raise HTTPException(404, "Join request not found")
    return document


@router.post("/trips/join-requests")
async def request_existing_person(
    body: JoinClaimRequest,
    background_tasks: BackgroundTasks,
    user=Depends(get_current_user),
):
    code = (body.code or "").upper().strip()
    trip = await db.trips.find_one({"code": code}, {"_id": 0})
    if not trip:
        raise HTTPException(404, "Trip not found")
    document = await create_request(trip, user, body.member_id, body.family_member_id)
    await enqueue_notification_event(
        event_type="join.request.created",
        source_id=document["id"],
        trip_id=trip["id"],
        actor_user_id=user["id"],
        recipient_user_ids_override=trip.get("admin_ids", []),
        background_tasks=background_tasks,
    )
    return request_payload(document)


@router.get("/trips/join-requests/{request_id}")
async def get_own_join_request(request_id: str, user=Depends(get_current_user)):
    return request_payload(await get_request_for_user(request_id, user["id"]))


@router.delete("/trips/join-requests/{request_id}")
async def cancel_own_join_request(request_id: str, user=Depends(get_current_user)):
    return request_payload(await cancel_request(request_id, user["id"]))


@router.get("/trips/{trip_id}/join-requests")
async def admin_join_requests(
    trip_id: str,
    status: Optional[Literal["pending", "approved", "rejected", "cancelled", "obsolete"]] = "pending",
    user=Depends(get_current_user),
):
    await _trip_admin_or_403(trip_id, user["id"])
    return [request_payload(row, admin=True) for row in await list_requests(trip_id, status)]


@router.post("/trips/{trip_id}/join-requests/{request_id}/approve")
async def approve_join_request(
    trip_id: str,
    request_id: str,
    background_tasks: BackgroundTasks,
    user=Depends(get_current_user),
):
    await _trip_admin_or_403(trip_id, user["id"])
    original = await _request_for_trip_or_404(trip_id, request_id)
    document, _trip = await approve_request(request_id, user["id"])
    await enqueue_notification_event(
        event_type="join.request.approved",
        source_id=document["id"],
        trip_id=trip_id,
        actor_user_id=user["id"],
        recipient_user_ids_override=[original["requester_user_id"]],
        background_tasks=background_tasks,
    )
    return request_payload(document, admin=True)


@router.post("/trips/{trip_id}/join-requests/{request_id}/reject")
async def reject_join_request(
    trip_id: str,
    request_id: str,
    body: JoinRejectRequest,
    background_tasks: BackgroundTasks,
    user=Depends(get_current_user),
):
    await _trip_admin_or_403(trip_id, user["id"])
    original = await _request_for_trip_or_404(trip_id, request_id)
    document = await reject_request(request_id, user["id"], body.reason)
    await enqueue_notification_event(
        event_type="join.request.rejected",
        source_id=document["id"],
        trip_id=trip_id,
        actor_user_id=user["id"],
        recipient_user_ids_override=[original["requester_user_id"]],
        background_tasks=background_tasks,
    )
    return request_payload(document, admin=True)
