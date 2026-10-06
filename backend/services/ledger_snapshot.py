"""One complete input for balances and coverage; no per-expense database reads."""

from dataclasses import dataclass, field


@dataclass
class LedgerSnapshot:
    trip: dict
    expenses: list = field(default_factory=list)
    settlements: list = field(default_factory=list)
    payments: list = field(default_factory=list)
    adjustments: dict = field(default_factory=dict)
    revisions: list = field(default_factory=list)
    events: list = field(default_factory=list)
    intents: list = field(default_factory=list)
    attempts: list = field(default_factory=list)


async def load_ledger(trip_id: str, database, *, session=None, coverage=False, trip=None) -> LedgerSnapshot:
    options = {"session": session} if session is not None else {}
    trip = trip or await database.trips.find_one({"id": trip_id}, {"_id": 0}, **options)
    if not trip:
        from fastapi import HTTPException
        raise HTTPException(404, "Group not found")

    async def rows(collection, query=None, projection=None):
        return await getattr(database, collection).find(
            query or {"trip_id": trip_id}, projection or {"_id": 0}, **options,
        ).to_list(None)

    # Indexes make these trip-scoped scans bounded by the ledger, never an arbitrary row cap.
    expenses = await rows("expenses", projection={"_id": 0, "receipt_base64": 0})
    evidence_projection = {"_id": 0, "upi_id": 0, "upi_reference": 0, "external_reference": 0,
                           "transaction_reference": 0, "receipt_base64": 0, "upi_id_snapshot": 0,
                           "payer_snapshot": 0, "recipient_snapshot": 0, "conversion_snapshot": 0, "note": 0}
    settlements = await rows("settlements", {"trip_id": trip_id} if coverage else
                             {"trip_id": trip_id, "status": {"$ne": "pending"}}, evidence_projection)
    payments = await rows("payments", projection=evidence_projection)
    adjustment_collection = getattr(database, "money_migration_adjustments", None)
    adjustment = await adjustment_collection.find_one({"trip_id": trip_id}, {"_id": 0}, **options) \
        if adjustment_collection is not None else None
    result = LedgerSnapshot(trip, expenses, settlements, payments, (adjustment or {}).get("vector") or {})
    if coverage:
        result.revisions = await rows("expense_share_revisions")
        result.events = await rows("expense_coverage_events")
        result.intents = await rows("settlement_intents", projection={"_id": 0,
            "cash_legs.upi_id_snapshot": 0, "cash_legs.upi_updated_at_snapshot": 0,
            "cash_legs.conversion_snapshot": 0, "cash_legs.payer.user_id": 0, "cash_legs.recipient.user_id": 0})
        result.attempts = await rows("payment_attempts", projection=evidence_projection)
    return result
