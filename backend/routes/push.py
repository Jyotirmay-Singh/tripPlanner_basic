from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from pymongo.errors import DuplicateKeyError

from config import logger
from database import db
from models.push import PushDeviceUpsert
from utils.common import now_utc
from utils.deps import get_current_user


router = APIRouter()


@router.put("/push/devices/{installation_id}")
async def register_push_device(
    installation_id: UUID,
    body: PushDeviceUpsert,
    user=Depends(get_current_user),
):
    """Bind one app installation and its current Expo token to the signed-in account.

    Tokens can rotate and phones can change accounts. Deactivating any other active owner before
    the upsert makes both cases self-healing while the partial unique token index prevents a token
    from delivering to two accounts at once.
    """
    installation = str(installation_id)
    timestamp = now_utc()
    await db.push_devices.update_many(
        {
            "token": body.token,
            "installation_id": {"$ne": installation},
            "active": True,
        },
        {"$set": {
            "active": False,
            "disabled_reason": "token_reassigned",
            "updated_at": timestamp,
        }},
    )
    update = {
        "$set": {
            "user_id": user["id"],
            "token": body.token,
            "provider": "expo",
            "platform": body.platform,
            "active": True,
            "disabled_reason": None,
            "last_seen_at": timestamp,
            "updated_at": timestamp,
        },
        "$setOnInsert": {
            "installation_id": installation,
            "created_at": timestamp,
        },
    }
    try:
        await db.push_devices.update_one(
            {"installation_id": installation}, update, upsert=True,
        )
    except DuplicateKeyError:
        # A concurrent login may have won the active-token race after update_many. Deactivate that
        # stale binding and retry once; the unique indexes remain the final source of truth.
        await db.push_devices.update_many(
            {
                "token": body.token,
                "installation_id": {"$ne": installation},
                "active": True,
            },
            {"$set": {
                "active": False,
                "disabled_reason": "token_reassigned",
                "updated_at": timestamp,
            }},
        )
        await db.push_devices.update_one(
            {"installation_id": installation}, update, upsert=True,
        )
    logger.info(
        "push.device_registered installation_id=%s user_id=%s platform=android",
        installation, user["id"],
    )
    return {"ok": True}


@router.delete(
    "/push/devices/{installation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def unregister_push_device(
    installation_id: UUID,
    reason: Literal["logout", "permission_denied"] = "logout",
    user=Depends(get_current_user),
):
    """Idempotently disable only the caller's registration for this installation."""
    timestamp = now_utc()
    await db.push_devices.update_one(
        {"installation_id": str(installation_id), "user_id": user["id"]},
        {"$set": {
            "active": False,
            "disabled_reason": reason,
            "updated_at": timestamp,
        }},
    )
    logger.info(
        "push.device_unregistered installation_id=%s user_id=%s reason=%s",
        str(installation_id), user["id"], reason,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
