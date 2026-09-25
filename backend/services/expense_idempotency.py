"""Durable retry contract for expense creates on transaction-capable MongoDB."""

import hashlib
import json
import logging
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException

from database import db
from services.ledger_transactions import run_required_transaction
from services.member_breakdown import family_member_ids


logger = logging.getLogger(__name__)
_transaction_verified = False
OPERATION = "expense.create"


def expense_protocol_ready() -> bool:
    return _transaction_verified


def disable_expense_protocol() -> None:
    global _transaction_verified
    _transaction_verified = False


async def verify_expense_transactions() -> bool:
    global _transaction_verified
    _transaction_verified = False
    marker = f"expense-probe:{uuid4()}"

    async def probe(session):
        await db.expense_mutation_receipts.insert_one({"_id": marker}, session=session)
        await db.expense_mutation_receipts.delete_one({"_id": marker}, session=session)

    try:
        await db.command("ping")
        await run_required_transaction(probe)
    except Exception as exc:
        logger.warning(
            "Expense retry protocol disabled: MongoDB transaction probe failed (%s)",
            type(exc).__name__,
        )
        return False
    _transaction_verified = True
    return True


def receipt_key(user_id: str, mutation_id: str) -> dict:
    return {"actor_user_id": user_id, "operation": OPERATION, "client_mutation_id": mutation_id}


def _canonical_value(value):
    if isinstance(value, Decimal):
        return "0" if value == 0 else format(value.normalize(), "f")
    if isinstance(value, dict):
        return {key: _canonical_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_canonical_value(item) for item in value]
    return value


def intent_fingerprint(body) -> str:
    intent = body.model_dump(
        exclude={"client_mutation_id", "receipt_id", "receipt_base64"},
    )
    intent["description"] = intent["description"] or ""
    intent["weight_snapshots"] = intent["weight_snapshots"] or None
    intent["expected_roster"]["members"].sort(key=lambda member: member["id"])
    intent = _canonical_value(intent)
    encoded = json.dumps(intent, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def verify_roster(trip: dict, body) -> None:
    relevant_ids = set(body.split_member_ids) | {body.paid_by_member_id}
    selected = {member["id"]: member for member in trip["members"] if member["id"] in relevant_ids}
    current = {
        "currency": trip.get("currency", "INR"),
        "members": [
            {
                "id": member_id,
                "kind": selected[member_id].get("kind", "individual"),
                "family_member_ids": (
                    family_member_ids(selected[member_id])
                    if selected[member_id].get("kind") == "family" else []
                ),
            }
            for member_id in sorted(selected)
        ],
    }
    expected = body.expected_roster.model_dump()
    expected["members"].sort(key=lambda member: member["id"])
    if set(selected) != relevant_ids or expected != current:
        raise HTTPException(409, detail={"code": "expense_roster_changed"})


def replay_or_conflict(receipt: dict, trip_id: str, fingerprint: str) -> dict:
    if receipt["trip_id"] != trip_id or receipt["fingerprint"] != fingerprint:
        raise HTTPException(409, detail={"code": "client_mutation_conflict"})
    return receipt["response"]
