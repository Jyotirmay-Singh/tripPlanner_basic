"""Fail closed for activated ledgers until a writer implements reviewed corrections."""
from fastapi import HTTPException


def activated(trip):
    return bool(trip.get("expense_settlement_activation_version") or trip.get("financial_write_guard_version"))


def reject_legacy_write(trip, *, code="settlement_client_upgrade_required"):
    if activated(trip):
        raise HTTPException(409, detail={"code": code,
            "message": "This group requires the reviewed settlement/correction workflow."})


async def guard_existing_trip_write(trip_id, database, *, session=None):
    trip = await database.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
    if trip:
        reject_legacy_write(trip, code="settlement_correction_required")
