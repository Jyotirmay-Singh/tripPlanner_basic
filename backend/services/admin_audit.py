"""Immutable, privacy-conscious audit events for application-super-admin mutations."""

from typing import Iterable, Optional

from config import logger
from database import db
from utils.common import gen_id, now_utc
from utils.permissions import is_super_admin


async def record_admin_action(
    user: dict,
    action: str,
    *,
    trip: Optional[dict] = None,
    trip_id: Optional[str] = None,
    trip_name: Optional[str] = None,
    resource_type: str = "trip",
    resource_id: Optional[str] = None,
    changed_fields: Optional[Iterable[str]] = None,
) -> None:
    """Best-effort append after a successful privileged mutation.

    Values and request bodies are deliberately excluded.  The log records enough context to
    identify the intervention without copying financial notes, chat text, receipt data, or tokens.
    """
    if not is_super_admin(user):
        return
    resolved_trip_id = trip_id or (trip or {}).get("id")
    resolved_trip_name = trip_name or (trip or {}).get("name")
    document = {
        "id": gen_id(),
        "actor_user_id": user["id"],
        "actor_email": user["email"],
        "action": action,
        "trip_id": resolved_trip_id,
        "trip_name": resolved_trip_name,
        "resource_type": resource_type,
        "resource_id": resource_id or resolved_trip_id,
        "changed_fields": sorted({str(field) for field in (changed_fields or []) if field}),
        "created_at": now_utc().isoformat(),
    }
    try:
        await db.admin_audit_logs.insert_one(document)
    except Exception:
        # The domain mutation has already committed.  Never turn a successful write into a retryable
        # 500 (which could duplicate money movement); surface the audit outage to operators instead.
        logger.exception(
            "super_admin.audit_failed action=%s trip_id=%s resource_id=%s",
            action,
            resolved_trip_id,
            document["resource_id"],
        )
