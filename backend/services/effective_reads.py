"""Current access and the complete effective ledger from the same required snapshot."""
from fastapi import HTTPException
from services.coverage_allocations import _current_access
from services.coverage_journal import run_snapshot_transaction
from services.ledger_snapshot import load_ledger


async def read_effective_ledger(trip_id, user, database, *, coverage=False):
    async def read(session):
        trip = await database.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
        actor = await database.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 0}, session=session)
        if not trip:
            raise HTTPException(404, "Group not found")
        if not _current_access(trip, actor):
            raise HTTPException(403, "Group access unavailable")
        ledger = await load_ledger(trip_id, database, trip=trip, session=session, coverage=coverage)
        # Inline receipt bytes remain excluded; only their existence is read for the visible flag.
        inline = await database.expenses.find({"trip_id": trip_id, "receipt_base64": {"$exists": True, "$nin": [None, ""]}},
            {"_id": 0, "id": 1}, session=session).to_list(None)
        inline_ids = {row["id"] for row in inline}
        for expense in ledger.expenses:
            expense["has_receipt"] = bool(expense.get("receipt_id") or expense["id"] in inline_ids)
        return ledger
    return await run_snapshot_transaction(read)
