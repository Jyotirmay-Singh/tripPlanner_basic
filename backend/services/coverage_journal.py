"""Atomic coverage journal, reusable inside the report approval transaction.

The journal never inserts or modifies cash ledger rows; the caller owns cash posting.
"""

from copy import deepcopy
from datetime import datetime, timezone
from uuid import UUID

from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from database import db
from config import EXPENSE_SETTLEMENT_ENABLED
from services import ledger_transactions
from services.coverage_allocations import _current_access, validate_allocation_bundle
from services.coverage_support import CoverageError, POLICY_VERSION, fingerprint, stable_id
from services.expense_coverage import build_coverage_snapshot, make_share_revision, _components, _review
from services.ledger_snapshot import load_ledger
from utils.permissions import role_of
from services.settlement_engine import to_scaled


async def run_snapshot_transaction(callback):
    """Read/write a consistent snapshot or fail closed, including on standalone MongoDB."""
    try:
        async with await ledger_transactions.client.start_session() as session:
            return await session.with_transaction(callback, read_concern=ReadConcern("snapshot"),
                                                  write_concern=WriteConcern("majority"))
    except Exception as exc:
        if ledger_transactions._transaction_unavailable(exc):
            raise ledger_transactions.TransactionUnavailableError("MongoDB transactions are unavailable") from exc
        raise


async def ensure_coverage_indexes(database):
    await database.expense_share_revisions.create_index("id", unique=True)
    await database.expense_share_revisions.create_index(
        [("trip_id", 1), ("expense_id", 1), ("revision", 1)], unique=True,
    )
    await database.expense_coverage_events.create_index("id", unique=True)
    await database.expense_coverage_events.create_index(
        [("trip_id", 1), ("actor_user_id", 1), ("client_mutation_id", 1)], unique=True,
    )
    await database.expense_coverage_events.create_index([("trip_id", 1), ("sequence", 1)])
    await database.expense_coverage_events.create_index(
        [("trip_id", 1), ("reverses_event_id", 1)], unique=True,
        partialFilterExpression={"reverses_event_id": {"$type": "string"}},
    )
    await database.settlement_intents.create_index([("trip_id", 1), ("status", 1)])
    await database.settlement_intents.create_index("id", unique=True)


async def store_new_share_revision(expense, members, trip_id, *, session):
    """Store the revision in the validated expense-create transaction, never as a backfill.

    recorded_at is the server time at this call. The source must be the expense being inserted
    by that same transaction; expense routes own that authorization boundary.
    """
    revision = make_share_revision(expense, members, trip_id,
                                   recorded_at=datetime.now(timezone.utc).isoformat())
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
    if trip and trip.get("expense_settlement_schema_version") == 2:
        from services.financial_ledger import versioned_revision
        revision = versioned_revision(expense, members, trip_id, 1, None, expense["id"],
                                      datetime.now(timezone.utc).isoformat())
        await db.expenses.update_one({"id": expense["id"], "trip_id": trip_id},
                                    {"$set": {"active_revision_id": revision["id"]}}, session=session)
        expense["active_revision_id"] = revision["id"]
    existing = await db.expense_share_revisions.find_one({"id": revision["id"]}, {"_id": 0}, session=session)
    if existing:
        if existing["financial_fingerprint"] != revision["financial_fingerprint"]:
            raise CoverageError("share_revision_changed")
        return existing
    await db.expense_share_revisions.insert_one(deepcopy(revision), session=session)
    return revision


def _freeze_projection_revision(revision):
    saved = deepcopy(revision)
    for row in saved["shares"]:
        for key in ("coverage_units", "coverage_explanations", "reservations"):
            row.pop(key, None)
    return saved


async def append_coverage_event(trip_id, *, plan=None, cash_uses=(), approvals=(), actor_user_id,
                                client_mutation_id, reverses_event_id=None, reason=None,
                                session=None, advance_trip=True, resolving_existing=False):
    if not EXPENSE_SETTLEMENT_ENABLED and not resolving_existing:
        raise CoverageError("feature_disabled")
    try:
        UUID(str(client_mutation_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise CoverageError("invalid_mutation_id") from exc
    if bool(plan) == bool(reverses_event_id):
        raise CoverageError("invalid_event")
    request_hash = fingerprint({"plan": plan, "cash_uses": cash_uses, "approvals": approvals,
                                "reverses_event_id": reverses_event_id, "reason": reason})

    async def commit(session):
        trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
        if (not trip or (trip.get("expense_settlement_activation_version") != 1 and not
                        (resolving_existing and trip.get("financial_write_guard_version") == 2)) or
                trip.get("financial_write_guard_version") not in {1, 2} or
                trip.get("expense_settlement_schema_version", 1) not in {1, 2}):
            raise CoverageError("group_not_ready")
        actor_ids = {actor_user_id, *(approval.get("actor_user_id") for approval in approvals)} - {None}
        actors = {user["id"]: user for user in await db.users.find(
            {"id": {"$in": sorted(actor_ids)}}, {"_id": 0, "password_hash": 0, "pin_hash": 0}, session=session,
        ).to_list(None)}
        actor = actors.get(actor_user_id)
        if not _current_access(trip, actor):
            raise CoverageError("insufficient_authority")
        key = {"trip_id": trip_id, "actor_user_id": actor_user_id, "client_mutation_id": str(client_mutation_id)}
        existing = await db.expense_coverage_events.find_one(key, {"_id": 0}, session=session)
        if existing:
            if existing["request_hash"] != request_hash:
                raise CoverageError("mutation_conflict")
            return existing
        ledger = await load_ledger(trip_id, db, session=session, coverage=True, trip=trip)
        # Explicitly reviewed source money must not be silently consumed by historical inference.
        snapshot = build_coverage_snapshot(ledger, infer_history=False)
        if reverses_event_id:
            if role_of(trip, actor) not in {"owner", "admin", "super_admin"} or not str(reason or "").strip():
                raise CoverageError("insufficient_authority")
            original = next((event for event in ledger.events if event["id"] == reverses_event_id), None)
            if not original or original.get("kind") == "reversal" or any(
                event.get("reverses_event_id") == reverses_event_id for event in ledger.events
            ):
                raise CoverageError("invalid_reversal")
            event = {"kind": "reversal", "reverses_event_id": reverses_event_id, "reason": reason,
                     "policy_version": POLICY_VERSION, "status": "applied"}
        else:
            intent = next((row for row in ledger.intents if row["id"] == plan.get("reservation_intent_id")), None)
            if intent and (intent.get("plan", {}).get("plan_hash") != plan["plan_hash"] or
                           intent.get("status") not in {"initiated", "reported", "awaiting_confirmation", "needs_review", "awaiting_consent"}):
                raise CoverageError("intent_changed")
            durable_approvals = {fingerprint(approval) for approval in (intent or {}).get("approvals", [])}
            # Loading an account proves its role, not that it expressed consent. Other actors'
            # approval evidence must already be durable; only this authenticated actor may add
            # their current action. Session 3 owns the authenticated approval-recording routes.
            if any(approval.get("actor_user_id") != actor_user_id and fingerprint(approval) not in durable_approvals
                   for approval in approvals):
                raise CoverageError("approval_evidence_unavailable")
            selected_sources = {use["source_id"] for use in cash_uses}
            history_override = any(
                approval.get("scope") == "history" and approval.get("action") == "admin_override"
                and approval.get("plan_hash") == plan["plan_hash"] and str(approval.get("reason") or "").strip()
                and _current_access(trip, actors.get(approval.get("actor_user_id")))
                and role_of(trip, actors.get(approval.get("actor_user_id"))) in {"owner", "admin", "super_admin"}
                for approval in approvals
            )
            for source_id, source in snapshot.sources.items():
                if snapshot.claimed.get(source_id, 0) == to_scaled(source["amount"]):
                    continue
                if source_id not in selected_sources:
                    _review(snapshot, "historical_cash_unallocated", _components(snapshot, (
                        source["from_member_id"], source["to_member_id"],
                    )))
                elif not history_override and (intent is None or
                    source["row"].get("settlement_intent_id") != intent["id"] or
                    source_id not in {leg.get("source_id") for leg in intent.get("cash_legs", [])}):
                    raise CoverageError("history_admin_review_required")
            event = validate_allocation_bundle(snapshot, plan, list(cash_uses), list(approvals), actors)
            event["kind"] = "allocation"
            existing_revision_ids = {revision["id"] for revision in ledger.revisions}
            selected_revision_ids = {line["revision_id"] for line in plan["allocation_lines"]}
            for revision in snapshot.revisions:
                if revision["id"] in selected_revision_ids and revision["id"] not in existing_revision_ids:
                    await db.expense_share_revisions.insert_one(_freeze_projection_revision(revision), session=session)
        event.update({**key, "id": stable_id(trip_id, actor_user_id, client_mutation_id),
                      "request_hash": request_hash, "created_at": datetime.now(timezone.utc).isoformat(),
                      "sequence": trip.get("version", 0) + 1})
        # Rebuild before commit, including reversals and pending reservations. This verifies the
        # complete wallet vector and prevents writing an event that future reads cannot replay.
        ledger.events.append(event)
        if plan:
            frozen_ids = {row["id"] for row in ledger.revisions}
            ledger.revisions.extend(_freeze_projection_revision(row) for row in snapshot.revisions
                                    if row["id"] in selected_revision_ids and row["id"] not in frozen_ids)
            ledger.intents = [intent for intent in ledger.intents if intent["id"] != plan.get("reservation_intent_id")]
        build_coverage_snapshot(ledger, infer_history=False)
        if advance_trip:
            changed = await db.trips.update_one({"id": trip_id, "version": trip.get("version", 0)},
                                                {"$inc": {"version": 1}}, session=session)
            if changed.matched_count != 1:
                raise CoverageError("eligibility_changed")
        await db.expense_coverage_events.insert_one(deepcopy(event), session=session)
        if plan and plan.get("reservation_intent_id"):
            await db.settlement_intents.update_one({"id": plan["reservation_intent_id"], "trip_id": trip_id},
                                                   {"$set": {"status": "applied", "coverage_event_id": event["id"]}}, session=session)
        return event

    if session is not None:
        return await commit(session)
    return await run_snapshot_transaction(commit)
