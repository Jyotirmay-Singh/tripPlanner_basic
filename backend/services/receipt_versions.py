"""Stage blob writes, then transactionally version the visible attachment pointer."""
from uuid import uuid4

from services import settlement_intents as workflow
from services.coverage_support import CoverageError, stable_id
from utils.common import now_utc
from utils.permissions import role_of


async def switch(trip_id, expense_id, receipt_id, user):
    version_id = str(uuid4())
    async def commit(session):
        trip, actor = await workflow.context(trip_id, user, session, require_activation=False)
        row = await workflow.db.expenses.find_one({"id": expense_id, "trip_id": trip_id}, {"_id": 0}, session=session)
        if not row or row.get("deleted_at"):
            raise workflow.error("expense_not_found", 404)
        if row.get("created_by") != actor["id"] and role_of(trip, actor) not in workflow.ADMIN_ROLES:
            raise workflow.error("insufficient_authority", 403)
        at = now_utc().isoformat()
        previous = row.get("receipt_version_id")
        if not previous and (row.get("receipt_id") or row.get("receipt_base64")):
            previous = stable_id(trip_id, expense_id, "original-receipt")
            await workflow.db.receipt_versions.update_one({"id": previous}, {"$setOnInsert": {
                "id": previous, "trip_id": trip_id, "expense_id": expense_id,
                "receipt_id": row.get("receipt_id"), "legacy_inline": row.get("receipt_base64"),
                "created_at": at, "evidence": "retained_original"}}, upsert=True, session=session)
        await workflow.db.receipt_versions.insert_one({"id": version_id, "trip_id": trip_id, "expense_id": expense_id,
            "receipt_id": receipt_id, "previous_version_id": previous, "actor_user_id": actor["id"], "created_at": at}, session=session)
        await workflow.db.expenses.update_one({"id": expense_id, "trip_id": trip_id},
            {"$set": {"receipt_version_id": version_id, "receipt_id": receipt_id}, "$unset": {"receipt_base64": ""}}, session=session)
        await workflow.db.users.update_one({"id": actor["id"]}, {"$inc": {"settlement_action_version": 1}}, session=session)
        await workflow.db.trips.update_one({"id": trip_id}, {"$inc": {"version": 1}}, session=session)
        from services.admin_audit import record_admin_action
        await record_admin_action(actor, "receipt.versioned", trip=trip, resource_type="expense_receipt",
            resource_id=expense_id, changed_fields=("receipt_id",), event_id=f"receipt.versioned:{version_id}", session=session)
        return {"receipt_id": receipt_id, "receipt_version_id": version_id}
    return await workflow.transaction(commit)
