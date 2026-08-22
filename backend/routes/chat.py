import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from starlette.websockets import WebSocketDisconnect

from database import db
from models.chat import ChatMessageCreate, ChatMessagePatch, ChatReadIn
from services.chat import public_chat_message, resolve_chat_sender
from services.chat_realtime import chat_connections
from utils.common import gen_id, now_utc
from utils.deps import get_current_user, _trip_or_404, _trip_owner_or_403
from utils.security import decode_token

router = APIRouter()


async def _chat_state(trip_id: str) -> dict:
    return await db.chat_counters.find_one({"trip_id": trip_id}, {"_id": 0}) or {
        "trip_id": trip_id,
        "latest_sequence": 0,
        "cleared_through_sequence": 0,
    }


async def _broadcast(trip: dict, event: dict) -> None:
    # Re-read access before fan-out so a removal racing a message mutation cannot receive the event.
    current = await db.trips.find_one({"id": trip["id"]}, {"_id": 0, "user_ids": 1})
    await chat_connections.broadcast(
        trip["id"], event, (current or {}).get("user_ids", [])
    )


async def _message_or_404(trip_id: str, message_id: str) -> dict:
    state = await _chat_state(trip_id)
    message = await db.chat_messages.find_one(
        {
            "id": message_id,
            "trip_id": trip_id,
            "sequence": {"$gt": state.get("cleared_through_sequence", 0)},
        }
    )
    if not message:
        raise HTTPException(404, "Message not found")
    return message


@router.get("/trips/{trip_id}/chat/messages")
async def list_chat_messages(
    trip_id: str,
    before_sequence: int | None = Query(default=None, ge=1),
    after_sequence: int | None = Query(default=None, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
    user=Depends(get_current_user),
):
    await _trip_or_404(trip_id, user["id"])
    if before_sequence is not None and after_sequence is not None:
        raise HTTPException(400, "Use either before_sequence or after_sequence, not both")

    state = await _chat_state(trip_id)
    cleared = state.get("cleared_through_sequence", 0)
    query: dict = {"trip_id": trip_id, "sequence": {"$gt": cleared}}
    direction = -1
    if before_sequence is not None:
        query["sequence"]["$lt"] = before_sequence
    elif after_sequence is not None:
        query["sequence"]["$gt"] = max(cleared, after_sequence)
        direction = 1

    rows = await db.chat_messages.find(query).sort("sequence", direction).limit(limit + 1).to_list(
        limit + 1
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    if direction == -1:
        rows.reverse()
    return {
        "items": [public_chat_message(row) for row in rows],
        "has_more_before": has_more if direction == -1 else False,
        "has_more_after": has_more if direction == 1 else False,
        "cleared_through_sequence": cleared,
    }


@router.post("/trips/{trip_id}/chat/messages")
async def create_chat_message(
    trip_id: str, body: ChatMessageCreate, user=Depends(get_current_user)
):
    trip = await _trip_or_404(trip_id, user["id"])
    sender = resolve_chat_sender(trip, user["id"])
    if not sender:
        raise HTTPException(409, "Your account is not linked to a person in this trip")

    client_message_id = str(body.client_message_id)
    existing = await db.chat_messages.find_one(
        {
            "trip_id": trip_id,
            "sender_user_id": user["id"],
            "client_message_id": client_message_id,
        }
    )
    if existing:
        return public_chat_message(existing)

    counter = await db.chat_counters.find_one_and_update(
        {"trip_id": trip_id},
        {
            "$inc": {"latest_sequence": 1},
            "$setOnInsert": {"cleared_through_sequence": 0},
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    sequence = counter["latest_sequence"]
    doc = {
        "id": gen_id(),
        "client_message_id": client_message_id,
        "trip_id": trip_id,
        "sequence": sequence,
        "sender_user_id": user["id"],
        **sender,
        "text": body.text,
        "created_at": now_utc().isoformat(),
        "edited_at": None,
        "deleted_at": None,
    }
    try:
        await db.chat_messages.insert_one(doc)
    except DuplicateKeyError:
        # A concurrent retry can win the unique idempotency index between our read and insert.
        existing = await db.chat_messages.find_one(
            {
                "trip_id": trip_id,
                "sender_user_id": user["id"],
                "client_message_id": client_message_id,
            }
        )
        if existing:
            return public_chat_message(existing)
        raise

    # If an owner cleared through this sequence while insertion was in flight, do not resurrect it.
    current_state = await _chat_state(trip_id)
    if sequence <= current_state.get("cleared_through_sequence", 0):
        await db.chat_messages.delete_one({"id": doc["id"]})
        raise HTTPException(409, "Chat was cleared while this message was sending. Retry to send it now.")

    public = public_chat_message(doc)
    await _broadcast(trip, {"type": "message.created", "data": public})
    return public


@router.patch("/trips/{trip_id}/chat/messages/{message_id}")
async def update_chat_message(
    trip_id: str,
    message_id: str,
    body: ChatMessagePatch,
    user=Depends(get_current_user),
):
    trip = await _trip_or_404(trip_id, user["id"])
    message = await _message_or_404(trip_id, message_id)
    if message.get("sender_user_id") != user["id"]:
        raise HTTPException(403, "You can only edit your own messages")
    if message.get("deleted_at"):
        raise HTTPException(409, "Deleted messages cannot be edited")

    edited_at = now_utc().isoformat()
    updated = await db.chat_messages.find_one_and_update(
        {
            "id": message_id,
            "trip_id": trip_id,
            "sender_user_id": user["id"],
            "deleted_at": None,
        },
        {"$set": {"text": body.text, "edited_at": edited_at}},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        # Deletion can race the ownership check above. Never reconstruct an edited response from
        # the stale pre-delete document or announce text that MongoDB did not persist.
        current = await _message_or_404(trip_id, message_id)
        if current.get("deleted_at"):
            raise HTTPException(409, "Deleted messages cannot be edited")
        raise HTTPException(409, "Message changed while it was being edited. Try again.")

    public = public_chat_message(updated)
    await _broadcast(trip, {"type": "message.updated", "data": public})
    return public


@router.delete("/trips/{trip_id}/chat/messages/{message_id}")
async def delete_chat_message(
    trip_id: str, message_id: str, user=Depends(get_current_user)
):
    trip = await _trip_or_404(trip_id, user["id"])
    message = await _message_or_404(trip_id, message_id)
    if message.get("sender_user_id") != user["id"]:
        raise HTTPException(403, "You can only delete your own messages")
    if not message.get("deleted_at"):
        deleted_at = now_utc().isoformat()
        await db.chat_messages.update_one(
            {"id": message_id, "trip_id": trip_id},
            {"$unset": {"text": ""}, "$set": {"deleted_at": deleted_at}},
        )
        message.pop("text", None)
        message["deleted_at"] = deleted_at
    public = public_chat_message(message)
    await _broadcast(trip, {"type": "message.updated", "data": public})
    return public


@router.get("/trips/{trip_id}/chat/unread")
async def chat_unread(trip_id: str, user=Depends(get_current_user)):
    await _trip_or_404(trip_id, user["id"])
    state = await _chat_state(trip_id)
    read = await db.chat_reads.find_one(
        {"trip_id": trip_id, "user_id": user["id"]}, {"_id": 0}
    )
    floor = max(
        state.get("cleared_through_sequence", 0),
        (read or {}).get("last_read_sequence", 0),
    )
    count = await db.chat_messages.count_documents(
        {
            "trip_id": trip_id,
            "sequence": {"$gt": floor},
            "sender_user_id": {"$ne": user["id"]},
            "deleted_at": None,
        }
    )
    latest = await db.chat_messages.find_one(
        {
            "trip_id": trip_id,
            "sequence": {"$gt": state.get("cleared_through_sequence", 0)},
        },
        {"_id": 0, "sequence": 1},
        sort=[("sequence", -1)],
    )
    return {"count": count, "latest_sequence": (latest or {}).get("sequence", 0)}


@router.put("/trips/{trip_id}/chat/read")
async def mark_chat_read(trip_id: str, body: ChatReadIn, user=Depends(get_current_user)):
    await _trip_or_404(trip_id, user["id"])
    state = await _chat_state(trip_id)
    if body.through_sequence > state.get("cleared_through_sequence", 0):
        exists = await db.chat_messages.find_one(
            {"trip_id": trip_id, "sequence": body.through_sequence}, {"_id": 0, "id": 1}
        )
        if not exists:
            raise HTTPException(400, "Read position is not a message in this trip")
    through = max(body.through_sequence, state.get("cleared_through_sequence", 0))
    await db.chat_reads.update_one(
        {"trip_id": trip_id, "user_id": user["id"]},
        {
            "$max": {"last_read_sequence": through},
            "$set": {"updated_at": now_utc().isoformat()},
            "$setOnInsert": {"id": gen_id()},
        },
        upsert=True,
    )
    return {"ok": True, "last_read_sequence": through}


@router.delete("/trips/{trip_id}/chat/history")
async def clear_chat_history(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_owner_or_403(trip_id, user["id"])
    state = await db.chat_counters.find_one_and_update(
        {"trip_id": trip_id},
        [
            {
                "$set": {
                    "latest_sequence": {"$ifNull": ["$latest_sequence", 0]},
                    "cleared_through_sequence": {"$ifNull": ["$latest_sequence", 0]},
                }
            }
        ],
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    boundary = state.get("cleared_through_sequence", 0)
    await db.chat_messages.delete_many({"trip_id": trip_id, "sequence": {"$lte": boundary}})
    await _broadcast(
        trip, {"type": "chat.cleared", "data": {"through_sequence": boundary}}
    )
    return {"ok": True, "cleared_through_sequence": boundary}


@router.websocket("/trips/{trip_id}/chat/ws")
async def chat_websocket(websocket: WebSocket, trip_id: str):
    await websocket.accept()
    connected = False
    try:
        try:
            first = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        except asyncio.TimeoutError:
            await websocket.close(code=4401)
            return
        if not isinstance(first, dict) or first.get("type") != "auth" or not first.get("token"):
            await websocket.close(code=4401)
            return
        try:
            payload = decode_token(first["token"])
        except HTTPException:
            await websocket.close(code=4401)
            return
        user = await db.users.find_one({"id": payload.get("sub")}, {"_id": 0, "id": 1})
        if not user:
            await websocket.close(code=4401)
            return
        trip = await db.trips.find_one({"id": trip_id}, {"_id": 0, "user_ids": 1})
        if not trip or user["id"] not in trip.get("user_ids", []):
            await websocket.close(code=4403)
            return
        await chat_connections.connect(trip_id, user["id"], websocket)
        connected = True
        await websocket.send_json({"type": "ready"})
        while True:
            incoming = await websocket.receive_json()
            if isinstance(incoming, dict) and incoming.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        if connected:
            await chat_connections.disconnect(trip_id, websocket)
