"""Authenticated correction previews, approval and compensation in one transaction."""
from copy import deepcopy
from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from config import MULTI_CURRENCY_EXPENSES_ENABLED
from database import db
from models.expense import ExpenseUpdate
from services import settlement_intents as workflow
from services.correction_planner import affected_events, invalidate_intents, preview_effects, reversal_events
from services.coverage_allocations import _accounts
from services.coverage_support import CoverageError, fingerprint, money, stable_id, timestamp, whole_units
from services.expense_coverage import build_coverage_snapshot
from services.expense_conversion import (convert_expense, locked_exact_reallocation_update,
    serialize_bson, stored_original_amount, stored_original_currency, stored_original_custom_amounts)
from services.financial_ledger import financial_record, versioned_revision
from services.ledger_snapshot import load_ledger
from services.settlement_engine import SCALE, to_scaled
from services.trip_activity import with_trip_activity
from utils.common import now_utc
from utils.permissions import role_of, can_record_payment

ADMIN = {"owner", "admin", "super_admin"}
INDEXES = {
    "financial_correction_previews": [("correction_preview_id", [("id", 1)], True)],
    "financial_corrections": [("correction_id", [("id", 1)], True),
                              ("correction_trip_status", [("trip_id", 1), ("status", 1)], False)],
    "financial_correction_events": [("correction_event_id", [("id", 1)], True),
                                    ("correction_event_trip", [("trip_id", 1), ("sequence", 1)], False)],
    "financial_correction_actions": [("correction_action_id", [("id", 1)], True)],
    "cash_source_versions": [("cash_source_version_id", [("id", 1)], True),
                             ("cash_source_version_number", [("trip_id", 1), ("root_source_id", 1), ("version_number", 1)], True)],
    "ledger_identity_snapshots": [("ledger_identity_id", [("id", 1)], True),
                                  ("ledger_identity_trip", [("trip_id", 1), ("member_id", 1)], False)],
    "reconciliation_previews": [("reconciliation_preview_id", [("id", 1)], True)],
    "reconciliation_runs": [("reconciliation_run_id", [("id", 1)], True)],
    "reconciliation_staging": [("reconciliation_stage_id", [("id", 1)], True),
                               ("reconciliation_stage_position", [("run_id", 1), ("position", 1)], True)],
    "reconciliation_cases": [("reconciliation_case_id", [("id", 1)], True),
                             ("reconciliation_case_status", [("trip_id", 1), ("status", 1)], False)],
    "receipt_versions": [("receipt_version_id", [("id", 1)], True),
                         ("receipt_version_expense", [("trip_id", 1), ("expense_id", 1)], False)],
}


async def ensure_indexes(database):
    """Explicit prerequisite installer. Never called from application startup."""
    if await inspect_index_data(database):
        raise CoverageError("correction_index_data_review_required")
    for collection, specs in INDEXES.items():
        for name, keys, unique in specs:
            await database[collection].create_index(keys, name=name, unique=unique)
    await database.expense_share_revisions.create_index(
        [("trip_id", 1), ("expense_id", 1), ("revision_number", 1)], name="financial_revision_number", unique=True,
        partialFilterExpression={"schema_version": 2})
    await database.financial_correction_events.create_index("reverses_correction_id", unique=True,
        name="financial_correction_reversal", partialFilterExpression={"reverses_correction_id": {"$type": "string"}})
    await database.settlement_intents.create_index("legacy_settlement_id", unique=True,
        name="financial_legacy_settlement_alias", partialFilterExpression={"legacy_settlement_id": {"$type": "string"}})


async def index_prerequisites(database):
    missing = []
    for collection, specs in INDEXES.items():
        actual = await database[collection].index_information()
        for name, keys, unique in specs:
            spec = actual.get(name, {})
            if list(spec.get("key", [])) != keys or bool(spec.get("unique")) != unique or "expireAfterSeconds" in spec:
                missing.append(f"{collection}.{name}")
    for collection, name, keys, partial in (
        ("expense_share_revisions", "financial_revision_number", [("trip_id", 1), ("expense_id", 1), ("revision_number", 1)], {"schema_version": 2}),
        ("financial_correction_events", "financial_correction_reversal", [("reverses_correction_id", 1)], {"reverses_correction_id": {"$type": "string"}}),
        ("settlement_intents", "financial_legacy_settlement_alias", [("legacy_settlement_id", 1)], {"legacy_settlement_id": {"$type": "string"}})):
        actual = await database[collection].index_information()
        spec = actual.get(name, {})
        if not spec.get("unique") or list(spec.get("key", [])) != keys or spec.get("partialFilterExpression") != partial or "expireAfterSeconds" in spec:
            missing.append(f"{collection}.{name}")
    required = {
        "expense_share_revisions": [[("id", 1)], [("trip_id", 1), ("expense_id", 1), ("revision", 1)]],
        "expense_coverage_events": [[("id", 1)], [("trip_id", 1), ("actor_user_id", 1), ("client_mutation_id", 1)],
                                    [("trip_id", 1), ("reverses_event_id", 1)], [("plan.reservation_intent_id", 1)]],
        "payment_mutation_receipts": [[("actor_user_id", 1), ("operation", 1), ("client_mutation_id", 1)]],
        "expense_mutation_receipts": [[("actor_user_id", 1), ("operation", 1), ("client_mutation_id", 1)]],
        "payments": [[("settlement_intent_id", 1), ("settlement_leg_id", 1)], [("payment_attempt_id", 1)]],
        "settlement_quotes": [[("id", 1)]], "settlement_intent_actions": [[("id", 1)]],
        "settlement_intents": [[("id", 1)]], "payment_attempts": [[("id", 1)], [("quote_id", 1)]],
        "notification_outbox": [[("event_key", 1)]],
    }
    partials = {
        ("expense_coverage_events", (("trip_id", 1), ("reverses_event_id", 1))): {"reverses_event_id": {"$type": "string"}},
        ("expense_coverage_events", (("plan.reservation_intent_id", 1),)): {"kind": "allocation", "plan.reservation_intent_id": {"$type": "string"}},
        ("payments", (("settlement_intent_id", 1), ("settlement_leg_id", 1))): {"settlement_intent_id": {"$type": "string"}, "settlement_leg_id": {"$type": "string"}},
        ("payments", (("payment_attempt_id", 1),)): {"payment_attempt_id": {"$type": "string"}},
        ("payment_attempts", (("quote_id", 1),)): {"quote_id": {"$type": "string"}},
    }
    for collection, keys in required.items():
        actual = await database[collection].index_information()
        for key in keys:
            if not any(list(spec.get("key", [])) == key and spec.get("unique")
                       and "expireAfterSeconds" not in spec
                       and spec.get("partialFilterExpression", {}) == partials.get((collection, tuple(key)), {})
                       for spec in actual.values()):
                missing.append(f"{collection}:{key}")
    return missing


async def inspect_index_data(database):
    """Read-only duplicate/malformed prerequisite audit, with no private values in diagnostics."""
    issues = []
    specs = [(collection, name, keys, {}) for collection, entries in INDEXES.items()
             for name, keys, unique in entries if unique]
    specs += [("expense_share_revisions", "financial_revision_number",
               [("trip_id", 1), ("expense_id", 1), ("revision_number", 1)], {"schema_version": 2}),
              ("financial_correction_events", "financial_correction_reversal", [("reverses_correction_id", 1)],
               {"reverses_correction_id": {"$type": "string"}}),
              ("settlement_intents", "financial_legacy_settlement_alias", [("legacy_settlement_id", 1)], {"legacy_settlement_id": {"$type": "string"}})]
    # Audit every already-installed permanent unique prerequisite before adding indexes.
    for collection in ("expense_share_revisions", "expense_coverage_events", "expense_mutation_receipts",
                       "payment_mutation_receipts", "payments", "settlement_quotes", "settlement_intents",
                       "settlement_intent_actions", "payment_attempts", "notification_outbox"):
        for name, spec in (await database[collection].index_information()).items():
            if name != "_id_" and spec.get("unique"):
                specs.append((collection, name, spec["key"], spec.get("partialFilterExpression", {})))
    for collection, name, keys, partial in specs:
        bad = {"$or": [{field: {"$exists": False}} for field, _ in keys] + [{field: None} for field, _ in keys]}
        malformed = await database[collection].count_documents({"$and": [partial, bad]})
        groups = await database[collection].aggregate([
            {"$match": partial}, {"$group": {"_id": {str(index): "$" + field for index, (field, _) in enumerate(keys)}, "count": {"$sum": 1}}},
            {"$match": {"count": {"$gt": 1}}}, {"$count": "count"}]).to_list(1)
        if malformed or groups:
            issues.append({"collection": collection, "index": name, "malformed_count": malformed,
                           "duplicate_key_count": groups[0]["count"] if groups else 0})
    return issues


async def context(trip_id, user, session, *, require_activation=False):
    trip, actor = await workflow.context(trip_id, user, session, require_activation=False)
    if require_activation and trip.get("expense_settlement_activation_version") != 1:
        raise workflow.error("group_not_ready")
    if trip.get("financial_write_guard_version") != 2 or trip.get("expense_settlement_schema_version") != 2:
        raise workflow.error("correction_migration_required")
    if await index_prerequisites(db):
        raise workflow.error("correction_indexes_required", 503)
    return trip, actor


def basis(ledger):
    clone = deepcopy(ledger)
    clone.trip["version"] = 0
    return build_coverage_snapshot(clone, infer_history=False).snapshot_id


def public(row):
    return serialize_bson({key: deepcopy(row.get(key)) for key in (
        "id", "trip_id", "operation", "target_id", "reason", "status", "version", "plan_hash",
        "created_at", "created_by", "effects", "required_person_ids", "requires_admin",
        "review_reasons", "applied_at", "reverses_correction_id")}
        | {"approvals": [{key: value for key, value in approval.items() if key != "account_id_snapshot"}
                         for approval in row.get("approvals", [])]})


async def expense_candidate(trip, actor, expense, changes, members):
    allowed = set(ExpenseUpdate.model_fields) - {"force", "receipt_id", "receipt_base64"}
    if set(changes) - allowed - {"paid_by_person_id"}:
        raise CoverageError("invalid_correction_fields")
    body = ExpenseUpdate(**{key: value for key, value in changes.items() if key != "paid_by_person_id"})
    updated = deepcopy(expense)
    updated.pop("_frozen_entity_shares", None)
    for field in ("paid_by_member_id", "paid_by_person_id", "split_member_ids", "split_mode",
                  "weight_snapshots", "family_participants", "date", "time", "description", "category"):
        if field in changes:
            updated[field] = changes[field]
    ids = {row["id"] for row in members}
    if updated["paid_by_member_id"] not in ids or not updated.get("split_member_ids") or set(updated["split_member_ids"]) - ids:
        raise CoverageError("invalid_expense_participants")
    from config import CATEGORIES
    if updated.get("category") and updated["category"] not in CATEGORIES:
        raise CoverageError("invalid_category")
    from routes.expenses import _clean_family_participants
    updated["family_participants"] = _clean_family_participants(updated.get("family_participants"),
        updated.get("split_mode", "PER_CAPITA"), updated["split_member_ids"], members)
    currency = trip.get("currency", "INR")
    source_currency = changes.get("original_currency", stored_original_currency(expense, currency))
    if "currency" in changes and changes["currency"] != currency:
        raise CoverageError("trip_currency_immutable")
    if "amount" in changes and stored_original_currency(expense, currency) != currency:
        if to_scaled(changes["amount"]) != to_scaled(expense["amount"]):
            raise CoverageError("canonical_foreign_amount_immutable")
    # A canonical foreign amount echoed by a form is not an original-currency amount.
    source_amount = changes.get("original_amount", stored_original_amount(expense)) if stored_original_currency(expense, currency) != currency \
        else changes.get("original_amount", changes.get("amount", stored_original_amount(expense)))
    whole_units(source_amount, positive=False)
    if to_scaled(source_amount) == 0:
        raise CoverageError("invalid_whole_amount")
    source_inputs_changed = (to_scaled(source_amount) != to_scaled(stored_original_amount(expense)) or
        source_currency != stored_original_currency(expense, currency) or updated.get("date") != expense.get("date")
        or body.conversion is not None)
    custom = changes.get("original_custom_amounts", stored_original_custom_amounts(expense))
    if "custom_amounts" in changes:
        if source_currency != currency:
            raise CoverageError("canonical_foreign_amount_immutable")
        if any(to_scaled(value) < 0 for value in (changes["custom_amounts"] or {}).values()):
            raise CoverageError("invalid_exact_amounts")
        custom = {key: abs(whole_units(value, positive=False)) // SCALE
                  for key, value in (changes["custom_amounts"] or {}).items()}
    next_version = int(expense.get("conversion_version") or 0) + 1
    if source_inputs_changed:
        if source_currency != currency and not MULTI_CURRENCY_EXPENSES_ENABLED:
            raise CoverageError("multi_currency_disabled")
        converted = await convert_expense(user_id=actor["id"], trip_currency=currency,
            date=updated.get("date"), split_mode=updated.get("split_mode", "PER_CAPITA"), members=members,
            original_amount=source_amount, original_currency=source_currency,
            original_custom_amounts=custom, conversion=body.conversion, version=next_version,
            reason="financial_correction", paid_by_member_id=updated["paid_by_member_id"])
        updated.update(amount=converted["amount"], currency=currency, custom_amounts=converted["custom_amounts"],
                       **converted["metadata"])
        updated["conversion_history"] = deepcopy(expense.get("conversion_history", [])) + [converted["history"]]
    elif updated.get("split_mode") == "EXACT":
        converted = locked_exact_reallocation_update(expense=expense, original_custom_amounts=custom or {},
            members=members, user_id=actor["id"], version=next_version)
        updated.update(custom_amounts=converted["custom_amounts"], **converted["metadata"])
        updated["conversion_history"] = deepcopy(expense.get("conversion_history", [])) + [converted["history"]]
    else:
        updated["custom_amounts"] = None
        updated["original_custom_amounts"] = None
    return updated


async def plan(trip, actor, ledger, body, operation_id, at, *, session=None):
    snapshot = build_coverage_snapshot(ledger, infer_history=False)
    if snapshot.snapshot_id != body.expected_snapshot_id:
        raise CoverageError("coverage_snapshot_changed")
    admin = role_of(trip, actor) in ADMIN
    new_expenses, revisions, cash_changes, expense_ids, source_ids = [], [], [], [], []
    events, required_people, new_members = [], [], None
    access_change = None
    trip_change = None
    requires_admin = True
    reverse_id = None
    if body.operation in {"replace_expense", "void_expense"}:
        expense = next((row for row in ledger.expenses if row["id"] == body.target_id), None)
        if not expense:
            raise workflow.error("expense_not_found", 404)
        if not admin and expense.get("created_by") != actor["id"]:
            raise workflow.error("insufficient_authority", 403)
        revision = next(row for row in snapshot.revisions if row["expense_id"] == expense["id"])
        expense_ids = [expense["id"]]
        events = affected_events(ledger, expense_ids=expense_ids)
        reserved = any(row["reservations"] for row in snapshot.shares.values() if row["expense_id"] == expense["id"])
        claims = any(set(case["share_ids"]) & {row["id"] for row in snapshot.shares.values()
                                               if row["expense_id"] == expense["id"]} for case in snapshot.review_cases)
        requires_admin = bool(events or reserved or claims)
        if body.operation == "void_expense":
            if body.changes:
                raise CoverageError("invalid_correction_fields")
            updated = {**deepcopy(expense), "deleted_at": at}
        else:
            roster_changed = bool(set(body.changes) & {"paid_by_member_id", "paid_by_person_id", "split_member_ids", "family_participants"})
            members = trip["members"] if roster_changed else revision["members_snapshot"]
            updated = await expense_candidate(trip, actor, expense, body.changes, members)
            revision_number = max([row.get("revision_number", 0) for row in ledger.revisions if row["expense_id"] == expense["id"]] + [0]) + 1
            new_revision = versioned_revision(updated, members, trip["id"], revision_number,
                                              revision["id"], operation_id, at)
            updated["active_revision_id"] = new_revision["id"]
            revisions.append(new_revision)
        new_expenses.append(updated)
    elif body.operation in {"replace_cash", "void_cash"}:
        source = snapshot.sources.get(body.target_id)
        if not source:
            raise workflow.error("payment_not_found", 404)
        if not admin and not can_record_payment(trip, source["to_member_id"], actor):
            raise workflow.error("insufficient_authority", 403)
        if set(body.changes) - {"amount"} or (body.operation == "void_cash" and body.changes):
            raise CoverageError("invalid_correction_fields")
        source_ids = [source["id"]]
        events = affected_events(ledger, source_ids=source_ids)
        after = None
        if body.operation == "replace_cash":
            amount = whole_units(body.changes.get("amount")) // SCALE
            after = {**financial_record(source["row"]), "id": stable_id(operation_id, "cash"), "amount": amount,
                     "created_at": at, "correction_id": operation_id, "source": "corrected_receipt",
                     "original_source_id": source["id"]}
        cash_changes = [{"source_id": source["id"], "before": financial_record(source["row"]), "after": after,
                         "replacement_source_id": f"payments:{after['id']}" if after else None}]
    elif body.operation == "reverse_allocation":
        if body.changes:
            raise CoverageError("invalid_correction_fields")
        events = affected_events(ledger, event_ids=[body.target_id])
        event = events[0]
        if event["plan"]["mode"] == "offset":
            requires_admin = False
            required_people = event["plan"]["required_person_ids"]
            if not admin and actor["id"] not in {_accounts(trip).get(person) for person in required_people}:
                raise workflow.error("insufficient_authority", 403)
        elif not admin:
            raise workflow.error("insufficient_authority", 403)
    elif body.operation == "reverse_correction":
        if not admin or body.changes:
            raise workflow.error("insufficient_authority", 403)
        original = next((row for row in ledger.corrections
                         if row.get("proposal_id", row["id"]) == body.target_id), None)
        if not original or any(row.get("reverses_correction_id") == body.target_id for row in ledger.corrections):
            raise CoverageError("invalid_reversal")
        reverse_id = body.target_id
        if not original.get("expense_changes") and not original.get("cash_changes") and not original.get("member_change") and not original.get("trip_change"):
            raise CoverageError("replacement_allocation_review_required")
        for change in original.get("expense_changes", []):
            current = next((row for row in (ledger.raw_expenses or ledger.expenses)
                            if row["id"] == change["expense_id"]), None)
            if (not current or current.get("active_revision_id") != change.get("after_revision_id") or
                    bool(current.get("deleted_at")) != bool(change.get("deleted_at"))):
                raise CoverageError("correction_dependencies_changed")
            previous = deepcopy(change["before"])
            previous.pop("deleted_at", None)
            old_revision = next(row for row in ledger.revisions if row["id"] == change["before_revision_id"])
            revision = versioned_revision(previous, old_revision["members_snapshot"], trip["id"],
                max(row.get("revision_number", 0) for row in ledger.revisions if row["expense_id"] == previous["id"]) + 1,
                current.get("active_revision_id") if current else change.get("after_revision_id"), operation_id, at)
            previous["active_revision_id"] = revision["id"]
            revisions.append(revision)
            new_expenses.append(previous)
            expense_ids.append(previous["id"])
        for change in original.get("cash_changes", []):
            if change.get("after"):
                current_id = change["replacement_source_id"]
                current = snapshot.sources.get(current_id)
                if not current:
                    raise CoverageError("correction_dependencies_changed")
                restored = {**deepcopy(change["before"]), "id": stable_id(operation_id, current_id), "correction_id": operation_id}
                cash_changes.append({"source_id": current_id, "before": financial_record(current["row"]),
                    "after": restored, "replacement_source_id": f"payments:{restored['id']}"})
                source_ids.append(current_id)
            else:
                # Restore a void through an explicit additional source, preserving the original void event.
                restored = {**deepcopy(change["before"]), "id": stable_id(operation_id, change["source_id"]), "correction_id": operation_id}
                cash_changes.append({"source_id": None, "before": None, "after": restored,
                                     "replacement_source_id": f"payments:{restored['id']}"})
        events = affected_events(ledger, expense_ids=expense_ids, source_ids=source_ids)
        if original.get("member_change"):
            if trip["members"] != original["member_change"]["after"]:
                raise CoverageError("correction_dependencies_changed")
            from services.roster_corrections import restore_financial_roster
            new_members = restore_financial_roster(original["member_change"]["before"], trip["members"])
        if original.get("trip_change"):
            if trip.get("archived_at") != original["trip_change"]["after"].get("archived_at"):
                raise CoverageError("correction_dependencies_changed")
            trip_change = {"before": {"archived_at": trip.get("archived_at")}, "after": {"archived_at": None}}
    elif body.operation == "leave_group":
        if _accounts(trip).get(body.target_id) != actor["id"] or actor["id"] == trip["owner_id"]:
            raise workflow.error("ownership_transfer_required", 403)
        if set(body.changes) - {"dissolve_family"} or not isinstance(body.changes.get("dissolve_family", False), bool):
            raise CoverageError("invalid_correction_fields")
        from services.roster_corrections import removal_blockers, people, validate_roster
        identity = people(trip["members"])[body.target_id]
        new_members = deepcopy(trip["members"])
        wallet = next(row for row in new_members if row["id"] == identity["wallet_id"])
        whole = wallet["kind"] != "family" or len(wallet["family_member_ids"]) == 1
        if wallet["kind"] == "family" and whole and not body.changes.get("dissolve_family"):
            raise CoverageError("nonempty_family_required")
        removal_blockers(ledger, {body.target_id}, {wallet["id"]} if whole else set())
        if whole:
            new_members.remove(wallet)
        else:
            index = wallet["family_member_ids"].index(body.target_id)
            for field in ("family_member_ids", "family_members", "family_member_emails", "family_member_user_ids"):
                wallet[field].pop(index)
        validate_roster(trip, new_members)
        requires_admin = False
    elif body.operation == "archive_trip":
        if role_of(trip, actor) not in {"owner", "super_admin"} or body.target_id != trip["id"] or body.changes:
            raise workflow.error("insufficient_authority", 403)
        from services.roster_corrections import removal_blockers, people
        removal_blockers(ledger, set(people(trip["members"])), {row["id"] for row in (ledger.accounting_members or trip["members"])})
        trip_change = {"before": {"archived_at": trip.get("archived_at")}, "after": {"archived_at": at}}
    elif body.operation in {"grant_admin", "revoke_admin", "transfer_owner"}:
        if role_of(trip, actor) not in {"owner", "super_admin"} or body.changes:
            raise workflow.error("insufficient_authority", 403)
        if body.target_id not in trip.get("user_ids", []) or body.target_id not in set(_accounts(trip).values()):
            raise CoverageError("current_person_link_required")
        admins = set(trip.get("admin_ids", []))
        owner = trip["owner_id"]
        if body.operation == "revoke_admin":
            if body.target_id == owner:
                raise CoverageError("owner_identity_required")
            admins.discard(body.target_id)
        else:
            admins.add(body.target_id)
        if body.operation == "transfer_owner":
            owner = body.target_id
        access_change = {"owner_id": owner, "admin_ids": sorted(admins)}
    else:
        if not admin:
            raise workflow.error("insufficient_authority", 403)
        from services.roster_corrections import plan_roster_change
        new_members, new_expenses, revisions = await plan_roster_change(trip, ledger, body, operation_id, at, database=db, session=session)
        expense_ids = [row["id"] for row in new_expenses]
        events = affected_events(ledger, expense_ids=expense_ids)
    event = {"id": operation_id, "trip_id": trip["id"], "schema_version": 2,
        "sequence": trip.get("version", 0) + 1, "operation": body.operation,
        "reason": body.reason, "created_at": at, "actor_user_id": actor["id"],
        "cash_changes": cash_changes, "reversed_event_ids": [row["id"] for row in events],
        "expense_changes": [{"expense_id": row["id"],
            "before": financial_record(next((old for old in ledger.expenses if old["id"] == row["id"]), row)),
            "after": financial_record(row),
            "before_revision_id": next((old["id"] for old in snapshot.revisions if old["expense_id"] == row["id"]),
                                       next((old["previous_revision_id"] for old in revisions if old["expense_id"] == row["id"]), None)),
            "after_revision_id": row.get("active_revision_id"), "deleted_at": row.get("deleted_at")}
                            for row in new_expenses],
        "member_change": {"before": deepcopy(trip["members"]), "after": deepcopy(new_members)} if new_members is not None else None}
    event["access_change"] = access_change
    event["trip_change"] = trip_change
    event["receipt_bindings"] = [{"expense_id": row["id"], "receipt_id": row.get("receipt_id"),
        "receipt_version_id": row.get("receipt_version_id")} for row in ledger.expenses
        if row["id"] in expense_ids or row["id"] in {line["expense_id"] for bundle in events
            for line in bundle["plan"]["allocation_lines"] if "expense_id" in line}]
    if reverse_id:
        event["reverses_correction_id"] = reverse_id
    event["reversal_events"] = reversal_events(ledger, events, operation_id, actor["id"], body.reason, at)
    effects = preview_effects(ledger, event, revisions, new_expenses, new_members)
    return {"event": event, "revisions": revisions, "expenses": new_expenses, "members": new_members,
            "effects": effects, "requires_admin": requires_admin, "required_person_ids": required_people,
            "basis_hash": basis(ledger), "source_snapshot_id": snapshot.snapshot_id}


async def preview(trip_id, body, user):
    async def read(session):
        trip, actor = await context(trip_id, user, session)
        ledger = await load_ledger(trip_id, db, coverage=True, trip=trip, session=session)
        at = now_utc()
        operation_id = str(uuid4())
        proposal = await plan(trip, actor, ledger, body, operation_id, at.isoformat(), session=session)
        expiry = at + timedelta(minutes=5)
        conversion = body.changes.get("conversion") or {}
        if conversion.get("quote_id"):
            fx = await db.exchange_rate_quotes.find_one({"id": conversion["quote_id"]}, session=session)
            if not fx or not timestamp(fx.get("expires_at")):
                raise CoverageError("conversion_quote_expired")
            expiry = min(expiry, timestamp(fx["expires_at"]))
        document = {"id": operation_id, "trip_id": trip_id, "actor_user_id": actor["id"],
                    "request": body.model_dump(mode="json"), "plan": proposal,
                    "created_at": at.isoformat(), "expires_at": expiry.isoformat()}
        document["preview_hash"] = fingerprint(document)
        await db.financial_correction_previews.insert_one(deepcopy(document), session=session)
        return {"id": operation_id, "preview_hash": document["preview_hash"], "expires_at": document["expires_at"],
                "operation": body.operation, "target_id": body.target_id, "effects": proposal["effects"],
                "requires_admin": proposal["requires_admin"], "required_person_ids": proposal["required_person_ids"]}
    return serialize_bson(await workflow.transaction(read))


async def load_preview(trip_id, preview_id, preview_hash, actor, session, *, owned=True):
    row = await db.financial_correction_previews.find_one({"id": str(preview_id), "trip_id": trip_id}, {"_id": 0}, session=session)
    if not row or row["preview_hash"] != preview_hash or timestamp(row["expires_at"]) <= now_utc():
        raise CoverageError("correction_preview_expired_or_changed")
    if owned and row["actor_user_id"] != actor["id"]:
        raise workflow.error("preview_not_owned", 403)
    return row


async def apply(trip, actor, correction, session):
    plan_doc = correction["plan"]
    ledger = await load_ledger(trip["id"], db, coverage=True, trip=trip, session=session)
    if basis(ledger) != plan_doc["basis_hash"]:
        raise CoverageError("correction_dependencies_changed")
    if timestamp(correction["expires_at"]) <= now_utc():
        raise CoverageError("correction_preview_expired_or_changed")
    if role_of(trip, actor) not in ADMIN and not correction["required_person_ids"]:
        if correction["operation"] in {"replace_expense", "void_expense"}:
            target = next((row for row in ledger.expenses if row["id"] == correction["target_id"]), {})
            if target.get("created_by") != actor["id"]:
                raise workflow.error("insufficient_authority", 403)
        elif correction["operation"] == "leave_group":
            if _accounts(trip).get(correction["target_id"]) != actor["id"] or trip["owner_id"] == actor["id"]:
                raise workflow.error("insufficient_authority", 403)
        else:
            raise workflow.error("insufficient_authority", 403)
    # Approvals are durable before application and evaluated against current links and roles.
    admin_override = role_of(trip, actor) in ADMIN and any(
        a["actor_user_id"] == actor["id"] and a.get("action") == "admin_approve"
        and a.get("plan_hash") == correction["plan_hash"] and str(a.get("reason") or "").strip()
        for a in correction["approvals"])
    if not admin_override:
        if correction["requires_admin"]:
            raise workflow.error("reasoned_admin_action_required", 403)
        accounts = _accounts(trip)
        consent_actors = {row["id"]: row for row in await db.users.find(
            {"id": {"$in": sorted({a["actor_user_id"] for a in correction["approvals"]})}}, {"_id": 0}, session=session).to_list(None)}
        from services.coverage_allocations import _current_access
        for person_id in correction["required_person_ids"]:
            if not any(a.get("person_id") == person_id and a["actor_user_id"] == accounts.get(person_id)
                       and _current_access(trip, consent_actors.get(a["actor_user_id"]))
                       for a in correction["approvals"]):
                return False
    event = deepcopy(plan_doc["event"])
    if (event.get("access_change") or event.get("trip_change")) and role_of(trip, actor) not in {"owner", "super_admin"}:
        raise workflow.error("insufficient_authority", 403)
    event.update(sequence=trip.get("version", 0) + 1, proposal_id=correction["id"],
                 approval_evidence=deepcopy(correction["approvals"]))
    for reversal in event["reversal_events"]:
        reversal.update(sequence=event["sequence"], actor_user_id=actor["id"])
        await db.expense_coverage_events.insert_one(deepcopy(reversal), session=session)
    for revision in plan_doc["revisions"]:
        await db.expense_share_revisions.insert_one(deepcopy(revision), session=session)
    for index, change in enumerate(event["cash_changes"]):
        await db.cash_source_versions.insert_one({"id": stable_id(event["id"], "source-version", index),
            "trip_id": trip["id"], "root_source_id": change["source_id"] or event["reverses_correction_id"],
            "version_number": event["sequence"], "correction_event_id": event["id"], **deepcopy(change)}, session=session)
    for expense in plan_doc["expenses"]:
        fields = {key: value for key, value in expense.items() if not key.startswith("_") and key != "id"}
        fields["correction_id"] = correction["id"]
        # Current metadata/attachment pointers are never overwritten by an earlier financial preview.
        for key in ("description", "category", "time", "receipt_id", "receipt_base64", "receipt_version_id"):
            fields.pop(key, None)
        await db.expenses.update_one({"id": expense["id"], "trip_id": trip["id"]},
            {"$set": fields, **({"$unset": {"deleted_at": ""}} if not expense.get("deleted_at") else {})}, session=session)
    if plan_doc["members"] is not None:
        from services.roster_corrections import apply_roster_change
        await apply_roster_change(trip, plan_doc["members"], correction["id"], session, db)
    if event.get("access_change"):
        await db.trips.update_one({"id": trip["id"]},
            {"$set": event["access_change"], "$inc": {"membership_revision": 1}}, session=session)
    if event.get("trip_change"):
        await db.trips.update_one({"id": trip["id"]}, {"$set": event["trip_change"]["after"]}, session=session)
    changed_accounts = set()
    if plan_doc["members"] is not None:
        from services.roster_corrections import people
        old, new = people(trip["members"]), people(plan_doc["members"])
        for pid in set(old) | set(new):
            if tuple(old.get(pid, {}).get(key) for key in ("wallet_id", "user_id", "email")) != tuple(new.get(pid, {}).get(key) for key in ("wallet_id", "user_id", "email")):
                changed_accounts.update((old.get(pid, {}).get("user_id"), new.get(pid, {}).get("user_id")))
    if event.get("access_change") and correction["operation"] == "revoke_admin":
        changed_accounts.add(correction["target_id"])
    if changed_accounts - {None}:
        from services.financial_bindings import invalidate_bindings
        await invalidate_bindings(db, trip["id"], changed_accounts, correction["id"], "current_authority_changed", session)
    affected = invalidate_intents(ledger, [row["id"] for row in plan_doc["expenses"]], event["reversed_event_ids"],
                                  [row["source_id"] for row in event["cash_changes"]], correction["id"])
    for intent in affected:
        # ledger projections redact private party/UPI fields; update only mutable state, not the row.
        state = {key: intent[key] for key in ("status", "allocation_status", "version", "correction_id")}
        state.update({key: intent[key] for key in ("expires_at", "review_reasons") if key in intent})
        await db.settlement_intents.update_one({"id": intent["id"], "trip_id": trip["id"]}, {"$set": state}, session=session)
        if intent["status"] == "canceled":
            await db.payment_attempts.update_many({"settlement_intent_id": intent["id"]},
                {"$set": {"status": "canceled", "correction_id": correction["id"]}, "$unset": {"active_key": ""}}, session=session)
        elif intent["status"] == "needs_review":
            await db.payment_attempts.update_many({"settlement_intent_id": intent["id"], "status": {"$ne": "settled_recipient_confirmed"}},
                {"$set": {"status": "needs_review", "expires_at": None, "reason": "financial_correction"}}, session=session)
    await db.financial_correction_events.insert_one(event, session=session)
    from services.reconciliation_cases import resolve_evidenced_cases
    await resolve_evidenced_cases(db, trip["id"], correction["id"], actor["id"], correction["reason"], session)
    current_trip = await db.trips.find_one({"id": trip["id"]}, {"_id": 0}, session=session)
    build_coverage_snapshot(await load_ledger(trip["id"], db, coverage=True, trip=current_trip, session=session), infer_history=False)
    correction.update(status="applied", applied_at=now_utc().isoformat())
    return True


async def mutate(trip_id, body, user, operation, callback, binding=None, *, require_activation=False):
    key = {"actor_user_id": user["id"], "operation": f"correction.{operation}", "client_mutation_id": str(body.client_mutation_id)}
    request_hash = fingerprint({"body": body.model_dump(mode="json"), "binding": binding, "trip_id": trip_id})
    async def commit(session):
        trip, actor = await context(trip_id, user, session, require_activation=require_activation)
        previous = await db.payment_mutation_receipts.find_one(key, {"_id": 0}, session=session)
        if previous:
            if previous["fingerprint"] != request_hash:
                raise CoverageError("client_mutation_conflict")
            return previous["response"]
        row = await callback(trip, actor, session)
        row["version"] += 1
        await db.financial_corrections.replace_one({"id": row["id"]}, deepcopy(row), upsert=True, session=session)
        await db.users.update_one({"id": actor["id"]}, {"$inc": {"settlement_action_version": 1}}, session=session)
        changed = await db.trips.update_one({"id": trip_id, "version": trip.get("version", 0)},
            with_trip_activity({"$inc": {"version": 1}}, now_utc().isoformat()), session=session)
        if changed.matched_count != 1:
            raise CoverageError("eligibility_changed")
        action_id = stable_id(trip_id, *key.values())
        await db.financial_correction_actions.insert_one({"id": action_id, "trip_id": trip_id, "correction_id": row["id"],
            "actor_user_id": actor["id"], "actor_name_snapshot": actor.get("name"), "actor_role": role_of(trip, actor),
            "operation": operation, "reason": getattr(body, "reason", None) or row["reason"],
            "created_at": now_utc().isoformat(), "result_status": row["status"]}, session=session)
        # A durable financial-review event is delivered only after the transaction commits.
        from services.push_notifications import enqueue_notification_event
        await enqueue_notification_event(event_type="financial_review.updated", source_id=row["id"],
            trip_id=trip_id, actor_user_id=actor["id"], event_id=action_id, session=session)
        response = public(row)
        await db.payment_mutation_receipts.insert_one({**key, "trip_id": trip_id, "fingerprint": request_hash,
            "response": response, "created_at": now_utc().isoformat()}, session=session)
        return response
    try:
        return await workflow.transaction(commit)
    except DuplicateKeyError:
        return await workflow.transaction(commit)


async def create(trip_id, body, user, *, binding=None):
    async def commit(trip, actor, session):
        reviewed = await load_preview(trip_id, body.preview_id, body.preview_hash, actor, session)
        if binding and ((binding.get("target_id") is not None and reviewed["request"]["target_id"] != binding["target_id"]) or
                        reviewed["request"]["operation"] not in binding["operations"]):
            raise CoverageError("correction_target_changed")
        if binding and binding.get("removed_person_id"):
            from services.roster_corrections import people
            pid = binding["removed_person_id"]
            if (pid not in people(trip["members"]) or
                    people(trip["members"])[pid]["wallet_id"] != binding["target_id"] or
                    pid in people(reviewed["plan"]["members"] or trip["members"])):
                raise CoverageError("correction_target_changed")
        existing = await db.financial_corrections.find_one({"id": reviewed["id"]}, {"_id": 0}, session=session)
        if existing:
            raise CoverageError("correction_preview_already_used")
        plan_doc = reviewed["plan"]
        ledger = await load_ledger(trip_id, db, trip=trip, coverage=True, session=session)
        if basis(ledger) != plan_doc["basis_hash"]:
            raise CoverageError("correction_dependencies_changed")
        row = {"id": reviewed["id"], "trip_id": trip_id, "operation": reviewed["request"]["operation"],
            "target_id": reviewed["request"]["target_id"], "reason": reviewed["request"]["reason"],
            "status": "awaiting_approval", "version": 0, "created_by": actor["id"], "created_at": now_utc().isoformat(),
            "expires_at": reviewed["expires_at"], "plan": deepcopy(plan_doc), "plan_hash": fingerprint(plan_doc),
            "effects": deepcopy(plan_doc["effects"]), "requires_admin": plan_doc["requires_admin"],
            "required_person_ids": plan_doc["required_person_ids"], "approvals": []}
        if role_of(trip, actor) in ADMIN or (not row["requires_admin"] and not row["required_person_ids"]):
            row["approvals"].append({"actor_user_id": actor["id"], "role_snapshot": role_of(trip, actor),
                                     "action": "admin_approve" if role_of(trip, actor) in ADMIN else "creator_approve",
                                     "plan_hash": row["plan_hash"], "reason": row["reason"], "created_at": row["created_at"]})
            await apply(trip, actor, row, session)
        return row
    return await mutate(trip_id, body, user, "create", commit, binding=binding)


async def action(trip_id, correction_id, body, user):
    async def commit(trip, actor, session):
        row = await db.financial_corrections.find_one({"id": correction_id, "trip_id": trip_id}, {"_id": 0}, session=session)
        if not row:
            raise workflow.error("correction_not_found", 404)
        if row["version"] != body.expected_version or row["plan_hash"] != body.plan_hash:
            raise CoverageError("correction_changed")
        if row["status"] != "awaiting_approval":
            raise CoverageError("invalid_transition")
        admin = role_of(trip, actor) in ADMIN
        if body.action == "withdraw":
            if actor["id"] != row["created_by"] and not admin:
                raise workflow.error("insufficient_authority", 403)
            row["status"] = "withdrawn"
        elif body.action == "reject":
            if not admin or not (body.reason or "").strip():
                raise workflow.error("reasoned_admin_action_required", 403)
            row.update(status="rejected", review_reasons=[body.reason])
        elif body.action == "renew":
            if actor["id"] != row["created_by"] and not admin:
                raise workflow.error("insufficient_authority", 403)
            review = await load_preview(trip_id, body.preview_id, body.preview_hash, actor, session)
            if review["request"]["operation"] != row["operation"] or review["request"]["target_id"] != row["target_id"]:
                raise CoverageError("correction_target_changed")
            # Keep the new plan's financial identity so revision/event IDs remain unique after renewal.
            row.update(plan=review["plan"], plan_hash=fingerprint(review["plan"]), effects=review["plan"]["effects"],
                       expires_at=review["expires_at"], requires_admin=review["plan"]["requires_admin"],
                       required_person_ids=review["plan"]["required_person_ids"], reason=review["request"]["reason"], approvals=[])
        else:
            if body.action == "approve":
                if not admin or not (body.reason or "").strip():
                    raise workflow.error("reasoned_admin_action_required", 403)
            elif body.person_id not in row["required_person_ids"] or _accounts(trip).get(body.person_id) != actor["id"]:
                raise workflow.error("insufficient_authority", 403)
            approval = {"actor_user_id": actor["id"], "person_id": body.person_id if body.action == "consent" else None,
                        "action": "admin_approve" if body.action == "approve" else "person_consent",
                        "role_snapshot": role_of(trip, actor), "plan_hash": row["plan_hash"],
                        "created_at": now_utc().isoformat(), "reason": body.reason}
            if not any(a["actor_user_id"] == actor["id"] and a.get("person_id") == approval["person_id"] for a in row["approvals"]):
                row["approvals"].append(approval)
            await apply(trip, actor, row, session)
        return row
    return await mutate(trip_id, body, user, f"action.{body.action}", commit, binding=correction_id)


async def history(trip_id, user, correction_id=None):
    async def read(session):
        trip, actor = await workflow.context(trip_id, user, session, require_activation=False)
        query = {"trip_id": trip_id, **({"id": correction_id} if correction_id else {})}
        rows = await db.financial_corrections.find(query, {"_id": 0}, session=session).sort("created_at", -1).to_list(None)
        if correction_id and not rows:
            raise workflow.error("correction_not_found", 404)
        responses = []
        for row in rows:
            response = public(row)
            if correction_id:
                actions = await db.financial_correction_actions.find({"trip_id": trip_id, "correction_id": row["id"]},
                    {"_id": 0}, session=session).sort("created_at", 1).to_list(None)
                response["action_history"] = actions
                if actor["id"] == row["created_by"] or role_of(trip, actor) in ADMIN:
                    original = await db.financial_correction_previews.find_one({"id": row["plan"]["event"]["id"], "trip_id": trip_id},
                        {"_id": 0, "request": 1}, session=session)
                    response["renewal_request"] = original.get("request") if original else None
            responses.append(response)
        return responses[0] if correction_id else responses
    return await workflow.transaction(read)
