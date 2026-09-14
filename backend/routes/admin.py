"""Application-super-admin overview and immutable activity APIs."""

import base64
import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from database import db
from services.money_audit import serialize_money_audit_value
from utils.deps import require_super_admin


router = APIRouter(prefix="/admin", tags=["application-admin"])


def _encode_cursor(document: dict) -> str:
    raw = json.dumps(
        [document.get("created_at") or "", document.get("id") or ""],
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(raw: Optional[str]) -> Optional[tuple[str, str]]:
    if not raw:
        return None
    try:
        padded = raw + "=" * (-len(raw) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if not isinstance(value, list) or len(value) != 2 or not all(
            isinstance(part, str) for part in value
        ):
            raise ValueError
        return value[0], value[1]
    except Exception as exc:
        raise HTTPException(400, "Invalid pagination cursor") from exc


def _after_cursor(cursor: tuple[str, str], created_at_field: str = "created_at") -> dict:
    created_at, document_id = cursor
    return {"$or": [
        {created_at_field: {"$lt": created_at}},
        {created_at_field: created_at, "id": {"$lt": document_id}},
    ]}


def _owner_lookup() -> list[dict]:
    return [
        {"$lookup": {
            "from": "users",
            "localField": "owner_id",
            "foreignField": "id",
            "as": "owner_rows",
        }},
        {"$set": {"owner": {"$arrayElemAt": ["$owner_rows", 0]}}},
    ]


@router.get("/trips")
async def list_all_trips(
    query: str = Query(default="", max_length=120),
    limit: int = Query(default=25, ge=1, le=100),
    cursor: Optional[str] = Query(default=None, max_length=512),
    _admin=Depends(require_super_admin),
):
    decoded = _decode_cursor(cursor)
    pipeline: list[dict] = _owner_lookup()
    # Legacy trips may predate created_at. Give them a stable final page instead of dropping
    # them when a cursor predicate is applied.
    pipeline.append({"$set": {
        "_admin_created_at": {"$convert": {
            "input": "$created_at", "to": "string", "onError": "", "onNull": "",
        }},
    }})
    term = query.strip()
    if term:
        regex = {"$regex": re.escape(term), "$options": "i"}
        pipeline.append({"$match": {"$or": [
            {"name": regex},
            {"code": regex},
            {"owner.email": regex},
            {"owner.name": regex},
        ]}})

    total_pipeline = [*pipeline, {"$count": "count"}]
    total_rows = await db.trips.aggregate(total_pipeline).to_list(1)
    total = int(total_rows[0]["count"]) if total_rows else 0

    if decoded:
        pipeline.append({"$match": _after_cursor(decoded, "_admin_created_at")})
    pipeline.extend([
        {"$sort": {"_admin_created_at": -1, "id": -1}},
        {"$limit": limit + 1},
        {"$lookup": {
            "from": "expenses",
            "let": {"trip_id": "$id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": ["$trip_id", "$$trip_id"]}}},
                {"$group": {"_id": None, "count": {"$sum": 1}, "net_spend": {"$sum": "$amount"}}},
            ],
            "as": "expense_metrics",
        }},
        {"$project": {
            "_id": 0,
            "id": 1,
            "name": 1,
            "code": 1,
            "start_date": 1,
            "end_date": 1,
            "travel_date": 1,
            "currency": 1,
            "budget": 1,
            "created_at": "$_admin_created_at",
            "owner": {
                "id": "$owner.id",
                "name": "$owner.name",
                "email": "$owner.email",
            },
            "member_count": {"$size": {"$ifNull": ["$members", []]}},
            "expense_count": {"$ifNull": [
                {"$arrayElemAt": ["$expense_metrics.count", 0]}, 0,
            ]},
            "net_spend": {"$ifNull": [
                {"$arrayElemAt": ["$expense_metrics.net_spend", 0]}, 0,
            ]},
        }},
    ])
    rows = await db.trips.aggregate(pipeline).to_list(limit + 1)
    has_more = len(rows) > limit
    items = rows[:limit]
    return {
        "items": items,
        "total": total,
        "next_cursor": _encode_cursor(items[-1]) if has_more and items else None,
    }


@router.get("/audit")
async def list_admin_activity(
    limit: int = Query(default=50, ge=1, le=100),
    cursor: Optional[str] = Query(default=None, max_length=512),
    trip_id: Optional[str] = None,
    action: Optional[str] = Query(default=None, max_length=100),
    _admin=Depends(require_super_admin),
):
    match: dict = {}
    if trip_id:
        match["trip_id"] = trip_id
    if action:
        match["action"] = action
    total = await db.admin_audit_logs.count_documents(match)
    decoded = _decode_cursor(cursor)
    if decoded:
        match = {"$and": [match, _after_cursor(decoded)]} if match else _after_cursor(decoded)
    rows = await db.admin_audit_logs.find(match, {"_id": 0}).sort([
        ("created_at", -1), ("id", -1),
    ]).limit(limit + 1).to_list(limit + 1)
    has_more = len(rows) > limit
    items = rows[:limit]
    return {
        "items": items,
        "total": total,
        "next_cursor": _encode_cursor(items[-1]) if has_more and items else None,
    }


@router.get("/money-audit")
async def list_money_audit(
    limit: int = Query(default=50, ge=1, le=100),
    cursor: Optional[str] = Query(default=None, max_length=512),
    trip_id: Optional[str] = None,
    record_type: Optional[str] = Query(default=None, max_length=32),
    _admin=Depends(require_super_admin),
):
    """Immutable normalization/migration history plus private adjustment vectors."""

    allowed = {"normalization", "migration", "adjustment"}
    if record_type and record_type not in allowed:
        raise HTTPException(400, "Invalid money-audit record type")
    selected = {record_type} if record_type else allowed
    base_match = {"trip_id": trip_id} if trip_id else {}
    decoded = _decode_cursor(cursor)
    cursor_match = _after_cursor(decoded) if decoded else None
    match = {"$and": [base_match, cursor_match]} if base_match and cursor_match \
        else (cursor_match or base_match)

    rows: list[dict] = []
    total = 0
    sources = (
        ("normalization", db.money_normalization_audits),
        ("migration", db.money_migration_audits),
    )
    for kind, collection in sources:
        if kind not in selected:
            continue
        total += await collection.count_documents(base_match)
        found = await collection.find(match, {"_id": 0}).sort([
            ("created_at", -1), ("id", -1),
        ]).limit(limit + 1).to_list(limit + 1)
        rows.extend({**row, "record_type": kind} for row in found)

    if "adjustment" in selected:
        adjustment_rows = await db.money_migration_adjustments.find(
            base_match, {"_id": 0}
        ).to_list(None)
        normalized_adjustments = []
        for row in adjustment_rows:
            normalized = {
                **row,
                "id": f"adjustment:{row.get('trip_id', '')}",
                "record_type": "adjustment",
            }
            if decoded and (
                normalized.get("created_at") or "",
                normalized["id"],
            ) >= decoded:
                continue
            normalized_adjustments.append(normalized)
        total += len(adjustment_rows)
        rows.extend(normalized_adjustments)

    rows.sort(key=lambda row: (row.get("created_at") or "", row.get("id") or ""), reverse=True)
    has_more = len(rows) > limit
    items = rows[:limit]
    trip_ids = sorted({row.get("trip_id") for row in items if row.get("trip_id")})
    trip_rows = await db.trips.find(
        {"id": {"$in": trip_ids}}, {"_id": 0, "id": 1, "name": 1, "currency": 1}
    ).to_list(None) if trip_ids else []
    trip_meta = {row["id"]: row for row in trip_rows}
    for item in items:
        meta = trip_meta.get(item.get("trip_id")) or {}
        item["trip_name"] = meta.get("name")
        item["currency"] = meta.get("currency")
    items = [serialize_money_audit_value(item) for item in items]
    return {
        "items": items,
        "total": total,
        "next_cursor": _encode_cursor(items[-1]) if has_more and items else None,
    }
