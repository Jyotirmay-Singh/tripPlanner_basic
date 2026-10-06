"""Close evidenced review cases only after an explicit reviewed financial action."""
from services.expense_coverage import build_coverage_snapshot
from services.ledger_snapshot import load_ledger
from services.settlement_engine import to_scaled
from utils.common import now_utc


async def resolve_evidenced_cases(database, trip_id, action_id, actor_id, reason, session):
    ledger = await load_ledger(trip_id, database, coverage=True, session=session)
    snapshot = build_coverage_snapshot(ledger, infer_history=False)
    for case in ledger.reconciliation_cases:
        evidence = case["evidence"]
        source_id = evidence.get("source_id")
        source = snapshot.sources.get(source_id)
        resolved = False
        if evidence.get("code") in {"historical_cash_unallocated", "confirmed_credit_unallocated", "allocation_pending"} and source_id:
            resolved = source is None or to_scaled(source["amount"]) == snapshot.claimed.get(source_id, 0)
        if evidence.get("code") in {"legacy_precision_review", "historical_participants_unknown"}:
            shares = evidence.get("share_ids", [])
            resolved = bool(shares) and not set(shares).intersection(snapshot.shares)
        if resolved:
            await database.reconciliation_cases.update_one({"id": case["id"], "status": "open"}, {"$set": {
                "status": "resolved", "resolved_by_action_id": action_id, "resolved_by": actor_id,
                "resolution_reason": reason, "resolved_at": now_utc().isoformat()}}, session=session)
