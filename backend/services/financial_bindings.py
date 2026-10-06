"""Revoke obsolete sending and pending consent while preserving reported evidence."""
from types import SimpleNamespace

from services.correction_planner import invalidate_intents
from services.coverage_support import stable_id
from utils.common import now_utc


async def invalidate_bindings(database, trip_id, account_ids, operation_id, reason, session):
    accounts = set(account_ids) - {None}
    rows = await database.settlement_intents.find({"trip_id": trip_id, "status": {"$in": [
        "initiated", "reported", "awaiting_confirmation", "needs_review", "awaiting_consent"]}}, {"_id": 0}, session=session).to_list(None)
    affected = [row for row in rows if any(
        leg.get("payer", {}).get("user_id") in accounts or leg.get("recipient", {}).get("user_id") in accounts
        for leg in row.get("cash_legs", [])) or any(a.get("actor_user_id") in accounts for a in row.get("approvals", []))
        or (row.get("mode") == "offset" and accounts)]
    for row in invalidate_intents(SimpleNamespace(revisions=[], intents=affected), [], [], [], operation_id, binding_changed=True):
        state = {key: row[key] for key in ("status", "allocation_status", "version", "correction_id")}
        state.update({key: row[key] for key in ("expires_at", "review_reasons") if key in row})
        await database.settlement_intents.update_one({"id": row["id"], "trip_id": trip_id}, {"$set": state}, session=session)
        if row["status"] == "canceled":
            await database.payment_attempts.update_many({"settlement_intent_id": row["id"], "status": "initiated"},
                {"$set": {"status": "canceled", "reason": reason}, "$unset": {"active_key": ""}}, session=session)
        else:
            await database.payment_attempts.update_many({"settlement_intent_id": row["id"], "status": {"$ne": "settled_recipient_confirmed"}},
                {"$set": {"status": "needs_review", "expires_at": None, "reason": reason}}, session=session)
        action_id = stable_id(operation_id, row["id"], "binding-invalidated")
        await database.settlement_intent_actions.insert_one({"id": action_id,
            "trip_id": trip_id, "intent_id": row["id"], "actor_user_id": None, "actor_role": "system",
            "operation": "settlement.binding.invalidated", "event": row["status"], "reason": reason,
            "created_at": now_utc().isoformat()}, session=session)
        from services.push_notifications import enqueue_notification_event
        await enqueue_notification_event(event_type="settlement.review_required", source_id=row["id"],
            trip_id=trip_id, actor_user_id=None, event_id=action_id, session=session)
