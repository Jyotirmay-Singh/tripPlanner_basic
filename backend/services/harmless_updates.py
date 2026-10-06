"""Compare effective inputs before any normalization, FX request or financial write."""
from services import settlement_intents as workflow
from services.coverage_support import CoverageError
from services.expense_conversion import (serialize_bson, stored_original_amount,
    stored_original_currency, stored_original_custom_amounts)
from services.settlement_engine import to_scaled
from utils.permissions import role_of


def metadata_changes(expense, body, currency):
    from routes.expenses import _same_amount_map, _same_money
    sent = body.model_dump(exclude_unset=True)
    result = {}
    for key, value in sent.items():
        if key in {"force", "expected_conversion_version"}:
            continue
        if key in {"description", "category", "time"}:
            if value != expense.get(key):
                result[key] = value
            continue
        old = expense.get(key)
        if key == "original_amount":
            old = stored_original_amount(expense)
        elif key == "original_currency":
            old = stored_original_currency(expense, currency)
        elif key == "currency":
            old = currency
        elif key == "original_custom_amounts":
            old = stored_original_custom_amounts(expense)
        elif key == "split_mode":
            old = expense.get(key, "PER_CAPITA")
        equal = value == old
        if key in {"amount", "original_amount"}:
            equal = _same_money(value, old)
        elif key in {"custom_amounts", "original_custom_amounts"}:
            equal = _same_amount_map(value, old)
        elif key in {"weight_snapshots", "family_participants"}:
            equal = (value or None) == (old or None)
        if not equal or (key == "conversion" and value is not None):
            raise CoverageError("settlement_correction_required")
    from config import CATEGORIES
    if "category" in result and result["category"] not in CATEGORIES:
        raise workflow.error("invalid_category", 422)
    return result


async def expense_metadata(trip_id, expense_id, body, user):
    async def commit(session):
        trip, actor = await workflow.context(trip_id, user, session, require_activation=False)
        expense = await workflow.db.expenses.find_one({"id": expense_id, "trip_id": trip_id}, {"_id": 0}, session=session)
        if not expense or expense.get("deleted_at"):
            raise workflow.error("expense_not_found", 404)
        if expense.get("created_by") != actor["id"] and role_of(trip, actor) not in workflow.ADMIN_ROLES:
            raise workflow.error("insufficient_authority", 403)
        updates = metadata_changes(expense, body, trip.get("currency", "INR"))
        if updates:
            await workflow.db.expenses.update_one({"id": expense_id, "trip_id": trip_id}, {"$set": updates}, session=session)
            await workflow.db.users.update_one({"id": actor["id"]}, {"$inc": {"settlement_action_version": 1}}, session=session)
            await workflow.db.trips.update_one({"id": trip_id}, {"$inc": {"version": 1}}, session=session)
            from services.admin_audit import record_admin_action
            await record_admin_action(actor, "expense.updated", trip=trip, resource_type="expense",
                resource_id=expense_id, changed_fields=updates.keys(), session=session)
        return serialize_bson({**expense, **updates})
    return await workflow.transaction(commit)


async def payment_note(trip_id, payment_id, body, user):
    async def commit(session):
        trip, actor = await workflow.context(trip_id, user, session, require_activation=False)
        row = await workflow.db.payments.find_one({"id": payment_id, "trip_id": trip_id}, {"_id": 0}, session=session)
        if not row:
            raise workflow.error("payment_not_found", 404)
        from utils.permissions import can_record_payment
        if not can_record_payment(trip, row["to_member_id"], actor):
            raise workflow.error("insufficient_authority", 403)
        if body.amount is not None and to_scaled(body.amount) != to_scaled(row["amount"]):
            raise CoverageError("settlement_correction_required")
        if body.note is not None and body.note != row.get("note"):
            await workflow.db.payments.update_one({"id": payment_id, "trip_id": trip_id}, {"$set": {"note": body.note}}, session=session)
            await workflow.db.users.update_one({"id": actor["id"]}, {"$inc": {"settlement_action_version": 1}}, session=session)
            await workflow.db.trips.update_one({"id": trip_id}, {"$inc": {"version": 1}}, session=session)
            row["note"] = body.note
        # Restricted references in the stored receipt are never returned by a harmless edit.
        private = {"upi_id", "upi_id_snapshot", "transaction_reference", "external_reference", "upi_reference",
                   "payer_snapshot", "recipient_snapshot", "conversion_snapshot"}
        return {key: value for key, value in row.items() if key not in private}
    return await workflow.transaction(commit)
