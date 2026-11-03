"""Atomic Mongo rate limits, with HMAC keys instead of stored emails or client IPs."""
import hashlib
import hmac
import math
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from config import JWT_SECRET
from database import db


def _key(value: str) -> str:
    return hmac.new(JWT_SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()


def _now():
    return datetime.now(timezone.utc)


async def enforce_email_ip_limit(request: Request) -> None:
    now = _now()
    bucket = int(now.timestamp()) // 60
    # The server's trusted proxy configuration supplies request.client. Do not independently
    # trust a caller's X-Forwarded-For header.
    ip = request.client.host if request.client else "unknown"
    selector = {"_id": f"ip:{_key(ip)}:{bucket}"}
    update = {"$inc": {"count": 1}, "$setOnInsert": {"expires_at": now + timedelta(minutes=2)}}
    try:
        rec = await db.auth_rate_limits.find_one_and_update(
            selector, update, upsert=True, return_document=ReturnDocument.AFTER,
        )
    except DuplicateKeyError:
        rec = await db.auth_rate_limits.find_one_and_update(
            selector, update, return_document=ReturnDocument.AFTER,
        )
    if rec["count"] > 10:
        retry = max(1, 60 - int(now.timestamp()) % 60)
        raise HTTPException(429, {"code": "email_rate_limited", "message": "Too many requests. Please try again shortly."},
                            headers={"Retry-After": str(retry)})


async def claim_email_send(email: str, purpose: str) -> int:
    """Reserve a send or return seconds to wait. Also reserve for unknown addresses."""
    now = _now()
    hour_ago = now - timedelta(hours=1)
    selector = {
        "_id": f"email:{_key(email.lower().strip() + ':' + purpose)}",
        "$and": [
            {"$or": [{"next_at": {"$lte": now}}, {"next_at": {"$exists": False}}]},
            {"$or": [{"window_at": {"$lte": hour_ago}}, {"count": {"$lt": 5}}, {"count": {"$exists": False}}]},
        ],
    }
    fresh_window = {"$lte": [{"$ifNull": ["$window_at", hour_ago]}, hour_ago]}
    update = [{"$set": {
        "count": {"$cond": [fresh_window, 1, {"$add": ["$count", 1]}]},
        "window_at": {"$cond": [fresh_window, now, "$window_at"]},
        "next_at": now + timedelta(seconds=60), "expires_at": now + timedelta(hours=2),
    }}]
    try:
        await db.auth_rate_limits.find_one_and_update(selector, update, upsert=True)
        return 0
    except DuplicateKeyError:
        rec = await db.auth_rate_limits.find_one({"_id": selector["_id"]})
        if not rec:
            return 60
        deadline = rec["next_at"]
        if rec.get("count", 0) >= 5:
            deadline = max(deadline, rec["window_at"] + timedelta(hours=1))
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        return max(1, math.ceil((deadline - now).total_seconds()))
