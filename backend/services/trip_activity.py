"""Server-authoritative recency tracking for trips.

Only qualifying domain mutations should call these helpers.  Live touches use MongoDB ``$max`` so
late or retried writes can never move a trip backwards.  Child-collection callers use the safe
wrapper after their primary write; recency is auxiliary and must not turn a committed ledger write
into an apparent failure.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Iterable, Optional

from utils.common import now_utc


logger = logging.getLogger(__name__)
ACTIVITY_FIELD = "last_activity_at"


def _as_utc(value: object) -> Optional[datetime]:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def activity_timestamp(value: object = None) -> str:
    """Return a canonical ISO-8601 UTC timestamp, defaulting to server time."""

    parsed = now_utc() if value is None else _as_utc(value)
    if parsed is None:
        raise ValueError("Activity timestamp must be an ISO-8601 date-time")
    return parsed.astimezone(timezone.utc).isoformat()


def activity_update(timestamp: object = None) -> dict:
    """Build the monotonic MongoDB update used by all qualifying trip touches."""

    return {"$max": {ACTIVITY_FIELD: activity_timestamp(timestamp)}}


def with_trip_activity(update: dict, timestamp: object = None) -> dict:
    """Merge a monotonic activity touch into an existing trip update without mutating it."""

    merged = {
        operator: dict(fields) if isinstance(fields, dict) else fields
        for operator, fields in update.items()
    }
    maximums = dict(merged.get("$max") or {})
    maximums[ACTIVITY_FIELD] = activity_timestamp(timestamp)
    merged["$max"] = maximums
    return merged


def ensure_activity_payload(trip: dict) -> dict:
    """Normalize a trip response and provide the creation-time fallback for legacy rows."""

    parsed = _as_utc(trip.get(ACTIVITY_FIELD)) or _as_utc(trip.get("created_at"))
    if parsed is not None:
        trip[ACTIVITY_FIELD] = activity_timestamp(parsed)
    return trip


async def touch_trip_activity(
    database, trip_id: str, *, timestamp: object = None, session=None,
):
    options = {"session": session} if session is not None else {}
    return await database.trips.update_one(
        {"id": trip_id}, activity_update(timestamp), **options,
    )


async def touch_trip_activity_safely(
    database, trip_id: str, *, timestamp: object = None,
) -> bool:
    """Best-effort touch for a primary write that has already committed."""

    try:
        result = await touch_trip_activity(database, trip_id, timestamp=timestamp)
        matched = getattr(result, "matched_count", None)
        if isinstance(matched, int) and matched == 0:
            logger.warning(
                "Could not update activity for missing trip %s after a committed mutation",
                trip_id,
            )
            return False
        return True
    except Exception:
        logger.exception("Could not update activity for trip %s after a committed mutation", trip_id)
        return False


def reconstructed_activity_at(
    trip: dict,
    *,
    expenses: Iterable[dict] = (),
    payments: Iterable[dict] = (),
    settlements: Iterable[dict] = (),
) -> Optional[str]:
    """Recover the latest reconstructable qualifying historical activity for one trip."""

    candidates = [_as_utc(trip.get("created_at"))]
    candidates.extend(_as_utc(row.get("created_at")) for row in expenses)
    candidates.extend(_as_utc(row.get("created_at")) for row in payments)
    candidates.extend(
        _as_utc(row.get("paid_at") or row.get("created_at"))
        for row in settlements
        if row.get("status") in (None, "paid")
    )
    valid = [candidate for candidate in candidates if candidate is not None]
    return activity_timestamp(max(valid)) if valid else None


async def _scan_latest(cursor, latest: dict[str, datetime], *, paid_only: bool = False) -> None:
    oldest = datetime.min.replace(tzinfo=timezone.utc)
    async for row in cursor:
        # A missing status is the legacy one-shot paid-settlement shape.  Any explicit state other
        # than ``paid`` is not effective financial activity.
        if paid_only and row.get("status") not in (None, "paid"):
            continue
        if paid_only:
            value = row.get("paid_at") or row.get("created_at")
        else:
            value = row.get("created_at")
        parsed = _as_utc(value)
        trip_id = row.get("trip_id")
        if parsed is not None and trip_id and parsed > latest.get(trip_id, oldest):
            latest[trip_id] = parsed


async def backfill_trip_activity(database) -> int:
    """Idempotently initialize/repair activity from reconstructable historical writes.

    A conditional ``$set`` is used only to repair a non-canonical legacy value.  Its equality guard
    prevents a concurrent newer touch from being overwritten.  Canonical or missing values use the
    normal monotonic ``$max`` update.
    """

    latest: dict[str, datetime] = {}
    await _scan_latest(
        database.expenses.find({}, {"_id": 0, "trip_id": 1, "created_at": 1}), latest,
    )
    await _scan_latest(
        database.payments.find({}, {"_id": 0, "trip_id": 1, "created_at": 1}), latest,
    )
    await _scan_latest(
        database.settlements.find(
            {}, {"_id": 0, "trip_id": 1, "status": 1, "paid_at": 1, "created_at": 1},
        ),
        latest,
        paid_only=True,
    )

    changed = 0
    async for trip in database.trips.find(
        {}, {"_id": 0, "id": 1, "created_at": 1, ACTIVITY_FIELD: 1},
    ):
        created = _as_utc(trip.get("created_at"))
        recovered = latest.get(trip.get("id"))
        candidate = max(
            (value for value in (created, recovered) if value is not None),
            default=None,
        )
        if candidate is None:
            logger.warning("Could not reconstruct activity for trip %s", trip.get("id"))
            continue

        candidate_text = activity_timestamp(candidate)
        existing_raw = trip.get(ACTIVITY_FIELD)
        existing = _as_utc(existing_raw)
        canonical_existing = activity_timestamp(existing) if existing is not None else None
        if ACTIVITY_FIELD in trip and existing_raw != canonical_existing:
            if existing is not None:
                replacement = activity_timestamp(max(existing, candidate))
            else:
                replacement = candidate_text
            result = await database.trips.update_one(
                {"id": trip["id"], ACTIVITY_FIELD: existing_raw},
                {"$set": {ACTIVITY_FIELD: replacement}},
            )
        else:
            result = await database.trips.update_one(
                {"id": trip["id"]}, activity_update(candidate_text),
            )
        modified = getattr(result, "modified_count", None)
        if not isinstance(modified, int) or modified > 0:
            changed += 1
    return changed
