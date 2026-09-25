"""Durable retry contract for manual payment creates on transactional MongoDB."""

import hashlib
import json
import logging
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException

from database import db
from services.ledger_transactions import run_required_transaction


logger = logging.getLogger(__name__)
_transaction_verified = False
OPERATION = "payment.create"


def payment_protocol_ready() -> bool:
    return _transaction_verified


def disable_payment_protocol() -> None:
    global _transaction_verified
    _transaction_verified = False


async def verify_payment_transactions() -> bool:
    global _transaction_verified
    _transaction_verified = False
    marker = f"payment-probe:{uuid4()}"

    async def probe(session):
        await db.payment_mutation_receipts.insert_one({"_id": marker}, session=session)
        await db.payment_mutation_receipts.delete_one({"_id": marker}, session=session)

    try:
        await db.command("ping")
        await run_required_transaction(probe)
    except Exception as exc:
        logger.warning(
            "Payment retry protocol disabled: MongoDB transaction probe failed (%s)",
            type(exc).__name__,
        )
        return False
    _transaction_verified = True
    return True


def receipt_key(user_id: str, mutation_id: str) -> dict:
    return {"actor_user_id": user_id, "operation": OPERATION, "client_mutation_id": mutation_id}


def intent_fingerprint(body) -> str:
    intent = body.model_dump(exclude={"client_mutation_id"})
    for field in ("amount", "expected_payable"):
        value = intent.get(field)
        if isinstance(value, Decimal):
            intent[field] = format(value.normalize(), "f")
    encoded = json.dumps(intent, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def replay_or_conflict(receipt: dict, trip_id: str, fingerprint: str) -> dict:
    if receipt["trip_id"] != trip_id or receipt["fingerprint"] != fingerprint:
        raise HTTPException(409, detail={"code": "client_mutation_conflict"})
    return receipt["response"]
