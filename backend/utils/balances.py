"""Database-loading boundary for authoritative trip balances."""

from fastapi import HTTPException
from database import db
from services.balance_snapshot import _weight_of_member, compute_balance_snapshot


async def _compute_balances(
    trip_id: str,
    *,
    diagnostic: bool = False,
    session=None,
) -> dict:
    session_options = {"session": session} if session is not None else {}
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, **session_options)
    if not trip:
        raise HTTPException(404, "Group not found")
    # Canonical expense amounts were fixed when saved. Settlement never calls the FX service and
    # never mutates historical conversion metadata. There is deliberately no accounting row cap.
    expenses = await db.expenses.find(
        {"trip_id": trip_id}, {"_id": 0}, **session_options
    ).to_list(None)
    settlements = await db.settlements.find(
        {"trip_id": trip_id, "status": {"$ne": "pending"}}, {"_id": 0}, **session_options
    ).to_list(None)
    payments = await db.payments.find(
        {"trip_id": trip_id}, {"_id": 0}, **session_options
    ).to_list(None)
    adjustment_collection = getattr(db, "money_migration_adjustments", None)
    migration_adjustment = await adjustment_collection.find_one(
        {"trip_id": trip_id}, {"_id": 0}, **session_options
    ) if adjustment_collection is not None else None

    return compute_balance_snapshot(
        trip, expenses, settlements, payments, migration_adjustment, diagnostic=diagnostic
    )
