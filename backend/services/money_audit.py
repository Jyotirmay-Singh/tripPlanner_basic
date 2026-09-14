"""Immutable audit records for decimal-to-whole normalization at write boundaries."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Iterable, Optional

from bson.decimal128 import Decimal128

from database import db
from utils.common import gen_id, now_utc
from utils.money_policy import MONEY_POLICY_VERSION


def serialize_money_audit_value(value: Any) -> Any:
    """Recursively preserve exact decimal audit evidence in a JSON-safe representation."""

    if isinstance(value, Decimal128):
        return format(value.to_decimal(), "f")
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, dict):
        return {
            str(key): serialize_money_audit_value(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [serialize_money_audit_value(item) for item in value]
    return value


async def record_money_normalizations(
    changes: Iterable[Optional[dict]],
    *,
    actor_user_id: Optional[str],
    trip_id: Optional[str],
    resource_type: str,
    resource_id: Optional[str],
    source: str = "api",
    session=None,
) -> Optional[dict]:
    normalized = [dict(change) for change in changes if change]
    if not normalized:
        return None
    document = {
        "id": gen_id(),
        "policy_version": MONEY_POLICY_VERSION,
        "actor_user_id": actor_user_id,
        "trip_id": trip_id,
        "resource_type": resource_type,
        "resource_id": resource_id,
        "source": source,
        "changes": normalized,
        "created_at": now_utc().isoformat(),
    }
    options = {"session": session} if session is not None else {}
    await db.money_normalization_audits.insert_one(document, **options)
    document.pop("_id", None)
    return document
