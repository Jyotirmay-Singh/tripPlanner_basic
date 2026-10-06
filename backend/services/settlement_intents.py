"""Authenticated reviewed reports, cash posting and coverage in one Mongo transaction."""
from copy import deepcopy
from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from config import EXPENSE_SETTLEMENT_ENABLED
from database import db
from services.coverage_allocations import (
    _accounts, _current_access, cash_uses_for_plan, plan_direct_allocations,
    plan_group_allocations, plan_offset_allocations, validate_plan, validate_allocation_bundle,
)
from services.coverage_journal import append_coverage_event, run_snapshot_transaction
from services.coverage_support import CoverageError, fingerprint, money, stable_id, timestamp, whole_units
from services.expense_coverage import build_coverage_snapshot, _components, _review
from services.ledger_snapshot import load_ledger
from services.ledger_transactions import TransactionUnavailableError, is_retryable_transaction_error
from services.payment_idempotency import payment_protocol_ready
from services.payment_attempts import PAYMENT_ATTEMPT_LIFETIME
from services.push_notifications import enqueue_notification_event
from services.settlement_engine import SCALE, SettlementLedgerError, to_scaled, build_settlement_projection
from services.trip_activity import with_trip_activity
from utils.common import now_utc
from utils.money_policy import whole_money
from utils.permissions import can_record_payment, is_linked_to_member, role_of
from utils.upi_rules import normalize_upi_id

ADMIN_ROLES = {"owner", "admin", "super_admin"}
ACTIVE = {"initiated", "reported", "awaiting_confirmation", "needs_review", "awaiting_consent"}


def error(code, status=409):
    return HTTPException(status, detail={"code": code, "retryable": status in {409, 503}})


def actions_ready():
    return payment_protocol_ready()


def starts_enabled():
    if not EXPENSE_SETTLEMENT_ENABLED:
        raise error("feature_disabled")
    if not actions_ready():
        raise error("settlement_transactions_unavailable", 503)


async def context(trip_id, user, session, *, require_activation=True):
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, session=session)
    actor = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 0, "pin_hash": 0}, session=session)
    if not trip:
        raise error("trip_not_found", 404)
    if not _current_access(trip, actor):
        raise error("insufficient_authority", 403)
    if ((require_activation and trip.get("expense_settlement_activation_version") != 1) or
            trip.get("financial_write_guard_version") not in {1, 2} or
            trip.get("expense_settlement_schema_version", 1) not in {1, 2}):
        raise error("group_not_ready")
    if require_activation and trip.get("archived_at"):
        raise error("group_archived")
    return trip, actor


async def transaction(callback):
    try:
        return await run_snapshot_transaction(callback)
    except TransactionUnavailableError as exc:
        raise error("settlement_transactions_unavailable", 503) from exc
    except (CoverageError, SettlementLedgerError) as exc:
        raise error(exc.code) from exc
    except Exception as exc:
        if is_retryable_transaction_error(exc):
            raise error("settlement_concurrency_conflict") from exc
        raise


def person(trip, wallet_id, person_id):
    wallet = next((m for m in trip["members"] if m["id"] == wallet_id), None)
    if not wallet:
        raise CoverageError("recipient_changed")
    if wallet.get("kind") == "family":
        ids = wallet.get("family_member_ids") or []
        if person_id not in ids:
            raise CoverageError("person_changed")
        index = ids.index(person_id)
        names, users = wallet.get("family_members") or [], wallet.get("family_member_user_ids") or []
        return {"person_id": person_id, "wallet_id": wallet_id,
                "name": names[index] if index < len(names) else "",
                "user_id": users[index] if index < len(users) else None}
    if person_id != wallet_id:
        raise CoverageError("person_changed")
    return {"person_id": person_id, "wallet_id": wallet_id, "name": wallet.get("name"), "user_id": wallet.get("user_id")}


async def parties(trip, binding, method, session):
    async def resolve(wallet_id, person_id):
        try:
            return person(trip, wallet_id, person_id)
        except CoverageError:
            if method == "upi" or trip.get("expense_settlement_schema_version") != 2:
                raise
            ledger = await load_ledger(trip["id"], db, trip=trip, session=session)
            archived = person({"members": ledger.accounting_members}, wallet_id, person_id)
            archived["user_id"] = None
            archived["historical"] = True
            return archived
    payer = await resolve(binding["from_member_id"], binding["payer_person_id"])
    receiver = await resolve(binding["to_member_id"], binding["recipient_person_id"])
    result = {"payer": payer, "recipient": receiver}
    if method == "upi":
        profile = await db.users.find_one({"id": receiver["user_id"]},
            {"_id": 0, "upi_id": 1, "upi_updated_at": 1, "recipient_account_revision": 1}, session=session) if receiver["user_id"] else None
        if not profile:
            raise CoverageError("recipient_unavailable")
        try:
            result["upi_id_snapshot"] = normalize_upi_id(profile.get("upi_id"))
        except (TypeError, ValueError) as exc:
            raise CoverageError("recipient_upi_unavailable") from exc
        if not result["upi_id_snapshot"]:
            raise CoverageError("recipient_upi_unavailable")
        result["upi_updated_at_snapshot"] = profile.get("upi_updated_at")
        result["recipient_account_revision"] = profile.get("recipient_account_revision", 0)
    return result


def may_report(trip, leg, actor):
    if leg["payer"]["user_id"] == actor["id"]:
        return True
    return can_record_payment(trip, leg["to_member_id"], actor)


def public_intent(intent):
    return {key: deepcopy(intent.get(key)) for key in (
        "id", "trip_id", "mode", "method", "currency", "version", "status", "allocation_status",
        "plan", "created_at", "expires_at", "review_reasons", "coverage_event_id",
        "overlapping_intent_ids",
    )} | {"approvals": [{key: deepcopy(action.get(key)) for key in (
        "scope", "action", "leg_id", "person_id", "created_at",
    ) if key in action} for action in intent.get("approvals", [])],
    "cash_legs": [{key: deepcopy(leg.get(key)) for key in (
        "id", "from_member_id", "to_member_id", "amount", "dependency", "receipt_status", "source_id",
        "payment_attempt_id", "actual_payer_person_id", "actual_receiver_person_id",
    )} for leg in intent["cash_legs"]]}


async def detail(trip_id, intent_id, user):
    async def read(session):
        trip, actor = await context(trip_id, user, session, require_activation=False)
        intent = await db.settlement_intents.find_one({"id": intent_id, "trip_id": trip_id}, {"_id": 0}, session=session)
        if not intent:
            raise error("intent_not_found", 404)
        response = public_intent(intent)
        response["reports"] = []
        readable_legs = set()
        for leg in intent["cash_legs"]:
            attempt = await db.payment_attempts.find_one({"id": leg["payment_attempt_id"]}, {"_id": 0, "active_key": 0}, session=session)
            if attempt and (actor["id"] == attempt.get("initiating_payer_user_id") or
                            can_record_payment(trip, leg["to_member_id"], actor)):
                response["reports"].append(attempt)
                readable_legs.add(leg["id"])
        actions = await db.settlement_intent_actions.find({"trip_id": trip_id, "intent_id": intent_id},
            {"_id": 0}, session=session).sort("created_at", 1).to_list(None)
        response["action_history"] = [action for action in actions
            if role_of(trip, actor) in ADMIN_ROLES or action.get("actor_user_id") == actor["id"] or
            (action.get("request") or {}).get("leg_id") in readable_legs or
            (action.get("resource_binding") or {}).get("leg_id") in readable_legs]
        return response
    return await transaction(read)


async def list_intents(trip_id, user):
    async def read(session):
        await context(trip_id, user, session, require_activation=False)
        rows = await db.settlement_intents.find({"trip_id": trip_id}, {"_id": 0}, session=session).sort("created_at", -1).to_list(None)
        return [public_intent(row) for row in rows]
    return await transaction(read)


async def quote(trip_id, body, user):
    starts_enabled()
    intent_id, quote_id = str(uuid4()), str(uuid4())
    async def review(session):
        trip, actor = await context(trip_id, user, session)
        snapshot = build_coverage_snapshot(await load_ledger(trip_id, db, coverage=True, trip=trip, session=session))
        if snapshot.snapshot_id != body.expected_snapshot_id:
            raise CoverageError("coverage_snapshot_changed")
        if body.mode == "offset":
            if body.method != "offset" or body.cash_legs or body.parties:
                raise CoverageError("invalid_offset_contract")
            plan = plan_offset_allocations(snapshot, [row.share_id for row in body.shares], intent_id=intent_id)
        elif body.method == "offset":
            raise CoverageError("invalid_payment_method")
        elif body.mode == "direct":
            if body.cash_legs:
                raise CoverageError("invalid_cash_selection")
            plan = plan_direct_allocations(snapshot, [row.model_dump() for row in body.shares], intent_id=intent_id)
        else:
            if body.shares:
                raise CoverageError("invalid_share_selection")
            plan = plan_group_allocations(snapshot, [row.model_dump() for row in body.cash_legs], intent_id=intent_id)
        bindings = {(row.from_member_id, row.to_member_id): row.model_dump() for row in body.parties}
        if len(bindings) != len(body.parties) or set(bindings) != {
            (leg["from_member_id"], leg["to_member_id"]) for leg in plan["cash_legs"]}:
            raise HTTPException(409, detail={"code": "cash_party_binding_required", "retryable": True,
                "cash_legs": deepcopy(plan["cash_legs"]), "snapshot_id": snapshot.snapshot_id})
        bound = []
        for leg in plan["cash_legs"]:
            selection = bindings[(leg["from_member_id"], leg["to_member_id"])]
            binding = await parties(trip, selection, body.method, session)
            if (binding["payer"].get("historical") or binding["recipient"].get("historical")) and role_of(trip, actor) not in ADMIN_ROLES:
                raise error("historical_identity_admin_review_required", 403)
            if not leg["dependency"]:
                if body.method == "upi" and binding["payer"]["user_id"] != actor["id"]:
                    raise error("wrong_payer", 403)
                if body.method != "upi" and not may_report(trip, {**leg, **binding}, actor):
                    raise error("insufficient_authority", 403)
            bound.append({**leg, **binding, "actual_payer_person_id": binding["payer"]["person_id"],
                          "actual_receiver_person_id": binding["recipient"]["person_id"]})
        validate_plan(snapshot, plan)
        return {"id": quote_id, "trip_id": trip_id, "intent_id": intent_id, "actor_user_id": actor["id"],
                "mode": body.mode, "method": body.method, "currency": trip.get("currency", "INR"),
                "plan": plan, "cash_legs": bound, "snapshot_id": snapshot.snapshot_id}
    document = await transaction(review)
    expires = now_utc() + timedelta(minutes=5)
    if body.method == "upi":
        from services.exchange_rates import create_quote, ExchangeRateError
        for leg in document["cash_legs"]:
            try:
                fx = await create_quote(user_id=user["id"], source_currency=document["currency"],
                    target_currency="INR", source_amount=leg["amount"], requested_date=None, mode="automatic",
                    payment_handoff={"trip_id": trip_id, "settlement_intent_id": intent_id, "leg_id": leg["id"]})
            except ExchangeRateError as exc:
                raise error("conversion_unavailable", exc.status_code) from exc
            leg["conversion_snapshot"] = fx
            leg["inr_amount"] = str(whole_money(fx["target_amount"], label="INR amount"))
            if int(leg["inr_amount"]) <= 0:
                raise error("invalid_converted_amount", 422)
            expires = min(expires, timestamp(fx["expires_at"]))
    document["expires_at"] = expires.isoformat()
    document["quote_hash"] = fingerprint(document)
    async def save(session):
        trip, actor = await context(trip_id, user, session)
        current = build_coverage_snapshot(await load_ledger(trip_id, db, coverage=True, trip=trip, session=session))
        if current.snapshot_id != document["snapshot_id"]:
            raise CoverageError("coverage_snapshot_changed")
        await db.settlement_quotes.insert_one(deepcopy(document), session=session)
        # Quote output is restricted to the reviewing actor; dependent payer UPI details are private.
        response = deepcopy(document)
        for original_leg, leg in zip(document["cash_legs"], response["cash_legs"]):
            for party in ("payer", "recipient"):
                leg[party].pop("user_id", None)
            if original_leg["payer"]["user_id"] != actor["id"] and role_of(trip, actor) not in ADMIN_ROLES:
                for key in ("upi_id_snapshot", "upi_updated_at_snapshot", "conversion_snapshot"):
                    leg.pop(key, None)
        return response
    return await transaction(save)


async def mutate(trip_id, body, user, operation, callback, *, binding=None):
    key = {"actor_user_id": user["id"], "operation": operation, "client_mutation_id": str(body.client_mutation_id)}
    request_hash = fingerprint({"body": body.model_dump(mode="json"), "binding": binding})
    async def commit(session):
        trip, actor = await context(trip_id, user, session)
        receipt = await db.payment_mutation_receipts.find_one(key, {"_id": 0}, session=session)
        if receipt:
            if receipt["trip_id"] != trip_id or receipt["fingerprint"] != request_hash:
                raise CoverageError("client_mutation_conflict")
            return receipt["response"]
        intent, event = await callback(trip, actor, session)
        response = public_intent(intent)
        if event:
            at = now_utc().isoformat()
            # A concurrent application-role revocation must conflict with this transaction too.
            await db.users.update_one({"id": actor["id"]}, {"$inc": {"settlement_action_version": 1}}, session=session)
            guard = await db.trips.update_one({"id": trip_id, "version": trip.get("version", 0)},
                with_trip_activity({"$inc": {"version": 1}}, at), session=session)
            if guard.matched_count != 1:
                raise CoverageError("eligibility_changed")
            action_id = stable_id(trip_id, actor["id"], operation, str(body.client_mutation_id))
            await db.settlement_intent_actions.insert_one({"id": action_id, "trip_id": trip_id,
                "intent_id": intent["id"], "actor_user_id": actor["id"], "actor_role": role_of(trip, actor),
                "actor_name_snapshot": actor.get("name"), "operation": operation,
                "request": body.model_dump(mode="json"), "resource_binding": binding,
                "event": event, "created_at": at}, session=session)
            event_type = {"reported": "payment_attempt.confirmation_requested", "approved": "payment_attempt.confirmed",
                          "disputed": "payment_attempt.not_received"}.get(event)
            if event_type:
                affected = {a.get("leg_id") for a in intent["approvals"]
                            if a.get("mutation_id") == str(body.client_mutation_id)}
                if event == "reported":
                    affected = {binding["leg_id"]} if binding and binding.get("leg_id") else {
                        leg["id"] for leg in intent["cash_legs"] if leg["receipt_status"] == "awaiting_review"}
                for leg in intent["cash_legs"]:
                    if leg["id"] in affected:
                        recipients = [leg["payer"]["user_id"] or intent.get("created_by")]
                        if event == "reported":
                            receiving = next((m for m in trip["members"] if m["id"] == leg["to_member_id"]), {})
                            recipients = list(receiving.get("family_member_user_ids") or []) if receiving.get("kind") == "family" else [receiving.get("user_id")]
                            recipients += trip.get("admin_ids", []) + [trip.get("owner_id")]
                        await enqueue_notification_event(event_type=event_type, source_id=leg["payment_attempt_id"],
                            event_id=f"{action_id}:{leg['id']}", trip_id=trip_id,
                            actor_user_id=actor["id"], recipient_user_ids_override=recipients,
                            payment_method=intent["method"], session=session)
        await db.payment_mutation_receipts.insert_one({**key, "trip_id": trip_id, "fingerprint": request_hash,
            "resource_id": intent["id"], "response": response, "created_at": now_utc().isoformat()}, session=session)
        return response
    try:
        return await transaction(commit)
    except DuplicateKeyError:
        # A concurrent actor may have committed this mutation while our snapshot was retrying.
        async def replay(session):
            await context(trip_id, user, session)
            receipt = await db.payment_mutation_receipts.find_one(key, {"_id": 0}, session=session)
            if not receipt or receipt["trip_id"] != trip_id or receipt["fingerprint"] != request_hash:
                raise CoverageError("client_mutation_conflict")
            return receipt["response"]
        return await transaction(replay)


def attempt_document(intent, leg, actor, *, report=False, reference=None, note=None):
    at = now_utc().isoformat()
    return {"id": leg["payment_attempt_id"], "trip_id": intent["trip_id"], "settlement_intent_id": intent["id"],
        "settlement_leg_id": leg["id"], "from_member_id": leg["from_member_id"], "to_member_id": leg["to_member_id"],
        "initiating_payer_user_id": leg["payer"]["user_id"], "reported_by": actor["id"] if report else None,
        "selected_recipient_person_id": leg["recipient"]["person_id"],
        "selected_recipient_user_id": leg["recipient"]["user_id"],
        "actual_payer_person_id": leg["actual_payer_person_id"], "actual_receiver_person_id": leg["actual_receiver_person_id"],
        "source_amount": leg["amount"], "source_currency": intent["currency"], "method": intent["method"],
        "plan_hash": intent["plan"]["plan_hash"], "expense_share_refs": deepcopy(intent["plan"]["allocation_lines"]),
        "payer_snapshot": deepcopy(leg["payer"]), "recipient_snapshot": deepcopy(leg["recipient"]),
        "upi_id_snapshot": leg.get("upi_id_snapshot"), "upi_updated_at_snapshot": leg.get("upi_updated_at_snapshot"),
        "conversion_snapshot": leg.get("conversion_snapshot"), "amount_paise": int(leg.get("inr_amount", "0")) * 100,
        "transaction_reference": reference, "note": note,
        **({"quote_id": leg["conversion_snapshot"]["quote_id"]} if intent["method"] == "upi" else {}),
        "status": "awaiting_confirmation" if report else "initiated", "initiated_at": at, "updated_at": at,
        "awaiting_confirmation_at": at if report else None,
        "expires_at": None if report else intent["expires_at"],
        "active_key": f"intent:{intent['id']}:{leg['id']}"}


async def create(trip_id, body, user, *, legacy_settlement_id=None):
    async def commit(trip, actor, session):
        starts_enabled()
        document = await db.settlement_quotes.find_one({"id": str(body.quote_id), "trip_id": trip_id}, {"_id": 0}, session=session)
        if not document:
            raise CoverageError("quote_expired")
        if document["actor_user_id"] != actor["id"]:
            raise error("quote_not_owned", 403)
        if document["quote_hash"] != body.quote_hash:
            raise CoverageError("quote_changed")
        alias = None
        if legacy_settlement_id is not None:
            alias = await db.settlements.find_one({"id": legacy_settlement_id, "trip_id": trip_id}, {"_id": 0}, session=session)
            selected = [leg for leg in document["cash_legs"] if not leg["dependency"]]
            if (not alias or alias.get("status") != "pending" or len(selected) != 1
                    or (alias["from_member_id"], alias["to_member_id"], to_scaled(alias["amount"])) !=
                       (selected[0]["from_member_id"], selected[0]["to_member_id"], to_scaled(selected[0]["amount"]))
                    or alias.get("reviewed_intent_id") not in {None, document["intent_id"]}):
                raise CoverageError("legacy_settlement_binding_changed")
        existing = await db.settlement_intents.find_one({"id": document["intent_id"]}, {"_id": 0}, session=session)
        submission_hash = fingerprint(body.model_dump(mode="json", exclude={"client_mutation_id"}))
        if existing:
            if existing.get("submission_fingerprint") != submission_hash or existing.get("legacy_settlement_id") != legacy_settlement_id:
                raise CoverageError("quote_already_used")
            return existing, None
        if timestamp(document["expires_at"]) <= now_utc():
            raise CoverageError("quote_expired")
        snapshot = build_coverage_snapshot(await load_ledger(trip_id, db, coverage=True, session=session, trip=trip))
        if snapshot.snapshot_id != document["snapshot_id"]:
            raise CoverageError("coverage_snapshot_changed")
        validate_plan(snapshot, document["plan"])
        at = now_utc()
        intent = {"id": document["intent_id"], "trip_id": trip_id, "quote_id": document["id"],
            "quote_hash": document["quote_hash"], "submission_fingerprint": submission_hash, "mode": document["mode"], "method": document["method"],
            "currency": document["currency"], "plan": document["plan"], "version": 0, "status": "initiated",
            "created_by": actor["id"],
            "allocation_status": "pending", "created_at": at.isoformat(),
            "expires_at": (at + PAYMENT_ATTEMPT_LIFETIME).isoformat(), "approvals": [], "review_reasons": [], "cash_legs": []}
        if alias:
            intent["legacy_settlement_id"] = legacy_settlement_id
            await db.settlements.update_one({"id": legacy_settlement_id, "trip_id": trip_id, "status": "pending"},
                {"$set": {"reviewed_intent_id": intent["id"], "reviewed_at": at.isoformat()}}, session=session)
        reported = False
        for binding in document["cash_legs"]:
            selection = {"from_member_id": binding["from_member_id"], "to_member_id": binding["to_member_id"],
                "payer_person_id": binding["actual_payer_person_id"], "recipient_person_id": binding["actual_receiver_person_id"]}
            if await parties(trip, selection, intent["method"], session) != {k: binding[k] for k in
                    ("payer", "recipient", "upi_id_snapshot", "upi_updated_at_snapshot", "recipient_account_revision") if k in binding}:
                raise CoverageError("recipient_changed")
            report = (body.submission_action == "report_paid" and intent["method"] in {"cash", "bank"}
                      and not binding["dependency"])
            if report and not may_report(trip, binding, actor):
                raise error("insufficient_authority", 403)
            leg = {**binding, "payment_attempt_id": str(uuid4()), "receipt_status": "awaiting_review" if report else "initiated"}
            intent["cash_legs"].append(leg)
            await db.payment_attempts.insert_one(attempt_document(intent, leg, actor, report=report,
                reference=body.transaction_reference, note=body.note), session=session)
            reported |= report
        if reported:
            intent.update(status="awaiting_confirmation", expires_at=None)
        await db.settlement_intents.insert_one(deepcopy(intent), session=session)
        return intent, "reported" if reported else "initiated"
    return await mutate(trip_id, body, user, "settlement.intent.create", commit,
                        binding={"legacy_settlement_id": legacy_settlement_id} if legacy_settlement_id is not None else None)


async def load_intent(trip_id, intent_id, session):
    intent = await db.settlement_intents.find_one({"id": intent_id, "trip_id": trip_id}, {"_id": 0}, session=session)
    if not intent:
        raise error("intent_not_found", 404)
    return intent


def precondition(intent, body):
    if body.plan_hash != intent["plan"]["plan_hash"]:
        raise CoverageError("plan_changed")
    if body.expected_intent_version != intent["version"]:
        raise CoverageError("intent_changed")


async def save_intent(intent, session):
    prior = intent["version"]
    intent["version"] += 1
    changed = await db.settlement_intents.replace_one({"id": intent["id"], "version": prior}, deepcopy(intent), session=session)
    if changed.matched_count != 1:
        raise CoverageError("intent_changed")


async def cancel_intent(intent, session):
    if any(leg["receipt_status"] not in {"initiated", "expired", "canceled"} or leg.get("source_id")
           for leg in intent["cash_legs"]):
        raise CoverageError("sent_report_requires_resolution")
    at = now_utc().isoformat()
    intent.update(status="canceled", allocation_status="pending")
    for leg in intent["cash_legs"]:
        leg["receipt_status"] = "canceled"
    await db.payment_attempts.update_many({"settlement_intent_id": intent["id"]},
        {"$set": {"status": "canceled", "canceled_at": at}, "$unset": {"active_key": ""}}, session=session)


async def allocation_issue(trip, intent, session):
    try:
        for leg in intent["cash_legs"]:
            if leg.get("source_id"):
                continue
            binding = {"from_member_id": leg["from_member_id"], "to_member_id": leg["to_member_id"],
                       "payer_person_id": leg["actual_payer_person_id"], "recipient_person_id": leg["actual_receiver_person_id"]}
            fresh = await parties(trip, binding, intent["method"], session)
            if any(fresh[key] != leg.get(key) for key in fresh):
                return "recipient_changed"
        snapshot = build_coverage_snapshot(await load_ledger(trip["id"], db, trip=trip, coverage=True, session=session))
        # Credit belonging to this intent is allowed only for its immutable application.
        snapshot.blocked = {sid for case in snapshot.review_cases
            if not (case.get("source_id") in {leg.get("source_id") for leg in intent["cash_legs"]}
                    and case["code"] == "allocation_pending") for sid in case["share_ids"]}
        validate_plan(snapshot, intent["plan"])
        return None
    except (CoverageError, SettlementLedgerError) as exc:
        return exc.code


async def validate_group_start(trip, intent, session):
    """Keep group-pair validation, restoring only this bundle's already confirmed cash.

    A dependent leg must not become invalid just because another reviewed leg was received.
    Other financial changes still require the payer to review a new recommendation.
    """
    if intent["mode"] != "group":
        return
    snapshot = build_coverage_snapshot(await load_ledger(trip["id"], db, trip=trip, coverage=True, session=session))
    net = dict(snapshot.precise_net)
    for leg in intent["cash_legs"]:
        source = snapshot.sources.get(leg.get("source_id"))
        if source:
            amount = to_scaled(source["amount"])
            net[source["from_member_id"]] = net.get(source["from_member_id"], 0) - amount
            net[source["to_member_id"]] = net.get(source["to_member_id"], 0) + amount
    suggestions, _ = build_settlement_projection(net, intent["currency"], whole_unit_enabled=True)
    limits = {(row["from_member_id"], row["to_member_id"]): to_scaled(row["amount"]) for row in suggestions}
    if any(to_scaled(leg["amount"]) > limits.get((leg["from_member_id"], leg["to_member_id"]), 0)
           for leg in intent["cash_legs"]):
        raise CoverageError("recommendation_changed")


async def leg_action(trip_id, intent_id, leg_id, body, user):
    async def commit(trip, actor, session):
        intent = await load_intent(trip_id, intent_id, session)
        leg = next((row for row in intent["cash_legs"] if row["id"] == leg_id), None)
        if not leg:
            raise error("leg_not_found", 404)
        attempt = await db.payment_attempts.find_one({"id": leg["payment_attempt_id"]}, {"_id": 0}, session=session)
        is_sender = (actor["id"] == attempt.get("initiating_payer_user_id") and
                     _accounts(trip).get(leg["actual_payer_person_id"]) == actor["id"])
        if body.action in {"start", "cancel"} and not is_sender:
            raise error("wrong_payer", 403)
        if body.action == "report_paid" and not (is_sender or can_record_payment(trip, leg["to_member_id"], actor)):
            raise error("insufficient_authority", 403)
        if body.plan_hash != intent["plan"]["plan_hash"]:
            raise CoverageError("plan_changed")
        if body.action == "report_paid" and leg["receipt_status"] in {"awaiting_review", "approved", "disputed"}:
            if body.transaction_reference not in {None, attempt.get("transaction_reference")} or body.note not in {None, attempt.get("note")}:
                raise CoverageError("reported_evidence_changed")
            return intent, None
        if body.action == "cancel" and intent["status"] == "canceled":
            return intent, None
        precondition(intent, body)
        at = now_utc().isoformat()
        if body.action == "start":
            starts_enabled()
            if (intent["method"] != "upi" or leg["receipt_status"] != "initiated" or
                    intent["allocation_status"] == "needs_review" or
                    (intent.get("expires_at") and timestamp(intent["expires_at"]) <= now_utc())):
                raise CoverageError("invalid_transition")
            if not is_linked_to_member(next((m for m in trip["members"] if m["id"] == leg["from_member_id"]), None), actor):
                raise error("wrong_payer", 403)
            selection = {"from_member_id": leg["from_member_id"], "to_member_id": leg["to_member_id"],
                "payer_person_id": leg["actual_payer_person_id"], "recipient_person_id": leg["actual_receiver_person_id"]}
            fresh = await parties(trip, selection, "upi", session)
            if any(fresh[key] != leg.get(key) for key in fresh):
                raise CoverageError("recipient_changed")
            if timestamp(leg["conversion_snapshot"]["expires_at"]) <= now_utc():
                raise CoverageError("quote_expired")
            issue = await allocation_issue(trip, intent, session)
            if issue:
                raise CoverageError(issue)
            await validate_group_start(trip, intent, session)
            await db.users.update_one({"id": fresh["recipient"]["user_id"]},
                {"$inc": {"settlement_action_version": 1}}, session=session)
            attempt.update(handoff_method=body.handoff_method, handoff_started_at=at)
            event = "started"
        elif body.action == "cancel":
            await cancel_intent(intent, session)
            await save_intent(intent, session)
            return intent, "canceled"
        else:
            if leg["receipt_status"] not in {"initiated", "expired", "canceled"}:
                raise CoverageError("invalid_transition")
            issue = await allocation_issue(trip, intent, session)
            late = leg["receipt_status"] in {"expired", "canceled"} or (
                intent.get("expires_at") and timestamp(intent["expires_at"]) <= now_utc())
            if late:
                issue = "late_payment_report"
                selected = {line["share_id"] for line in intent["plan"]["allocation_lines"]}
                others = await db.settlement_intents.find({"trip_id": trip_id, "id": {"$ne": intent_id}},
                    {"_id": 0}, session=session).to_list(None)
                overlaps = sorted(row["id"] for row in others if
                    row.get("status") in ACTIVE | {"applied", "reversed"} and selected & {
                        line["share_id"] for line in (row.get("plan") or {}).get("allocation_lines", [])})
                intent["overlapping_intent_ids"] = overlaps
                attempt["overlapping_intent_ids"] = overlaps
            leg["receipt_status"] = "awaiting_review"
            intent.update(status="needs_review" if issue else "awaiting_confirmation", expires_at=None)
            if issue:
                intent["review_reasons"] = sorted(set(intent["review_reasons"] + [issue]))
                intent["allocation_status"] = "needs_review"
            attempt.update(status="awaiting_confirmation", expires_at=None, awaiting_confirmation_at=at,
                reported_by=actor["id"], transaction_reference=body.transaction_reference, note=body.note)
            event = "reported"
        attempt["updated_at"] = at
        await db.payment_attempts.replace_one({"id": attempt["id"]}, attempt, session=session)
        await save_intent(intent, session)
        return intent, event
    result = await mutate(trip_id, body, user, f"settlement.leg.{body.action}", commit, binding={"intent_id": intent_id, "leg_id": leg_id})
    if body.action == "start":
        async def read_handoff(session):
            trip, actor = await context(trip_id, user, session)
            intent = await load_intent(trip_id, intent_id, session)
            leg = next(row for row in intent["cash_legs"] if row["id"] == leg_id)
            if _accounts(trip).get(leg["actual_payer_person_id"]) != actor["id"] or leg["payer"]["user_id"] != actor["id"]:
                raise error("wrong_payer", 403)
            if (leg["receipt_status"] != "initiated" or await allocation_issue(trip, intent, session)
                    or timestamp(leg["conversion_snapshot"]["expires_at"]) <= now_utc()):
                raise CoverageError("sending_review_required")
            return {"upi_id": leg["upi_id_snapshot"], "inr_amount": leg["inr_amount"],
                    "recipient_name": leg["recipient"]["name"], "recipient_account_revision": leg.get("recipient_account_revision", 0)}
        result = {**result, "handoff": await transaction(read_handoff)}
    return result


async def try_apply(trip, intent, actor, mutation_id, session):
    if intent["allocation_status"] == "needs_review":
        return
    ledger = await load_ledger(trip["id"], db, coverage=True, trip=trip, session=session)
    try:
        snapshot = build_coverage_snapshot(ledger, infer_history=False)
        source_ids = {leg["id"]: leg["source_id"] for leg in intent["cash_legs"] if leg.get("source_id")}
        if len(source_ids) != len(intent["cash_legs"]):
            raise CoverageError("receipt_pending")
        uses = cash_uses_for_plan(snapshot, intent["plan"], source_ids)
        selected = {use["source_id"] for use in uses}
        for source_id, source in snapshot.sources.items():
            if source_id not in selected and snapshot.claimed.get(source_id, 0) != to_scaled(source["amount"]):
                _review(snapshot, "historical_cash_unallocated", _components(snapshot, (source["from_member_id"], source["to_member_id"])))
        actors = {row["id"]: row for row in await db.users.find(
            {"id": {"$in": list({a["actor_user_id"] for a in intent["approvals"]})}},
            {"_id": 0, "password_hash": 0, "pin_hash": 0}, session=session).to_list(None)}
        validate_allocation_bundle(snapshot, intent["plan"], uses, intent["approvals"], actors)
        for actor_id in actors:
            await db.users.update_one({"id": actor_id}, {"$inc": {"settlement_action_version": 1}}, session=session)
    except (CoverageError, SettlementLedgerError) as exc:
        if exc.code in {"receipt_pending", "allocation_consent_pending"}:
            intent.update(status="awaiting_consent" if exc.code == "allocation_consent_pending" else "awaiting_confirmation",
                          allocation_status="awaiting_consent" if exc.code == "allocation_consent_pending" else "pending")
        else:
            intent.update(status="needs_review", allocation_status="needs_review")
            intent["review_reasons"] = sorted(set(intent["review_reasons"] + [exc.code]))
        return
    # Persist current authenticated approval before the journal validates other durable actors.
    await db.settlement_intents.replace_one({"id": intent["id"]}, deepcopy(intent), session=session)
    event = await append_coverage_event(trip["id"], plan=intent["plan"], cash_uses=uses,
        approvals=intent["approvals"], actor_user_id=actor["id"], client_mutation_id=mutation_id,
        session=session, advance_trip=False, resolving_existing=True)
    intent.update(status="applied", allocation_status="applied", coverage_event_id=event["id"])


async def approve(trip_id, intent_id, body, user):
    async def commit(trip, actor, session):
        intent = await load_intent(trip_id, intent_id, session)
        leg = next((row for row in intent["cash_legs"] if row["id"] == body.leg_id), None)
        admin = role_of(trip, actor) in ADMIN_ROLES
        if body.plan_hash != intent["plan"]["plan_hash"]:
            raise CoverageError("plan_changed")
        if body.action == "cancel":
            if not admin and intent.get("created_by") != actor["id"]:
                raise error("insufficient_authority", 403)
            if intent["status"] == "canceled":
                return intent, None
            precondition(intent, body)
            if intent["status"] in {"applied", "reversed", "rejected"}:
                raise CoverageError("invalid_transition")
            await cancel_intent(intent, session)
            await save_intent(intent, session)
            return intent, "canceled"
        if body.action in {"confirm_received", "report_not_received", "reject", "resolve_not_sent"}:
            if not leg:
                raise CoverageError("leg_required")
            if not can_record_payment(trip, leg["to_member_id"], actor) or (not admin and leg["payer"]["user_id"] == actor["id"]):
                raise error("insufficient_authority", 403)
            if body.action == "confirm_received" and leg["receipt_status"] == "approved":
                return intent, None
        elif body.action == "consent":
            if body.person_id not in intent["plan"]["required_person_ids"] or _accounts(trip).get(body.person_id) != actor["id"]:
                raise error("insufficient_authority", 403)
        elif not admin or not str(body.reason or "").strip():
            raise error("reasoned_admin_action_required", 403)
        if intent["allocation_status"] == "applied" and body.action in {"consent", "admin_override"}:
            return intent, None
        precondition(intent, body)
        if intent["status"] in {"reversed", "rejected", "canceled", "expired"}:
            raise CoverageError("invalid_transition")
        at = now_utc().isoformat()
        evidence = {"actor_user_id": actor["id"], "plan_hash": body.plan_hash, "created_at": at,
                    "reason": body.reason, "mutation_id": str(body.client_mutation_id)}
        event = "reviewed"
        if body.action == "reverse_allocation":
            if intent["allocation_status"] != "applied":
                raise CoverageError("invalid_reversal")
            await append_coverage_event(trip_id, reverses_event_id=intent["coverage_event_id"], reason=body.reason,
                actor_user_id=actor["id"], client_mutation_id=str(body.client_mutation_id),
                session=session, advance_trip=False, resolving_existing=True)
            intent.update(status="reversed", allocation_status="reversed")
        elif body.action in {"report_not_received", "reject", "resolve_not_sent"}:
            if leg["receipt_status"] not in {"awaiting_review", "disputed", "rejected"} or not str(body.reason or "").strip():
                raise CoverageError("reasoned_resolution_required")
            leg["receipt_status"] = "disputed" if body.action == "report_not_received" else "rejected"
            intent.update(status="needs_review", allocation_status="needs_review")
            intent["review_reasons"] = sorted(set(intent["review_reasons"] + ["receipt_disputed"]))
            if body.action == "resolve_not_sent":
                # Resolution cannot erase another cash leg's claim or confirmed credit.
                if any(row.get("source_id") or (row["id"] != leg["id"] and row["receipt_status"] in {"awaiting_review", "disputed", "rejected"}) for row in intent["cash_legs"]):
                    raise CoverageError("other_sent_money_unresolved")
                intent.update(status="rejected", allocation_status="pending")
                await db.payment_attempts.update_many({"settlement_intent_id": intent_id},
                    {"$set": {"status": "closed", "resolution_reason": body.reason}, "$unset": {"active_key": ""}}, session=session)
            else:
                await db.payment_attempts.update_one({"id": leg["payment_attempt_id"]},
                    {"$set": {"status": "needs_review", "expires_at": None, "reason": body.reason}}, session=session)
            evidence.update(scope="receipt", leg_id=leg["id"], action=body.action)
            intent["approvals"].append(evidence)
            event = "disputed"
        else:
            if body.action == "confirm_received":
                if leg["receipt_status"] not in {"awaiting_review", "disputed", "rejected"}:
                    raise CoverageError("payment_not_reported")
                issue = await allocation_issue(trip, intent, session)
                if issue:
                    intent.update(status="needs_review", allocation_status="needs_review")
                    intent["review_reasons"] = sorted(set(intent["review_reasons"] + [issue]))
                payment_id = stable_id("settlement-cash", intent_id, leg["id"])
                payment = {"id": payment_id, "trip_id": trip_id, "from_member_id": leg["from_member_id"],
                    "to_member_id": leg["to_member_id"], "amount": whole_units(leg["amount"]) // SCALE,
                    "currency": intent["currency"], "created_at": at, "recorded_by": actor["id"],
                    "source": "expense_receipt_confirmed", "payment_attempt_id": leg["payment_attempt_id"],
                    "settlement_intent_id": intent_id, "settlement_leg_id": leg["id"],
                    "actual_payer_person_id": leg["actual_payer_person_id"], "actual_receiver_person_id": leg["actual_receiver_person_id"],
                    "money_policy_version": "whole_unit_v1"}
                await db.payments.insert_one(payment, session=session)
                leg.update(receipt_status="approved", source_id=f"payments:{payment_id}")
                await db.payment_attempts.update_one({"id": leg["payment_attempt_id"]}, {"$set": {
                    "status": "settled_recipient_confirmed", "linked_payment_id": payment_id,
                    "recipient_confirmed_by": actor["id"], "confirmed_at": at,
                    "posted_amount": payment["amount"], "posted_currency": intent["currency"], "expires_at": None},
                    "$unset": {"active_key": ""}}, session=session)
                evidence.update(scope="receipt", leg_id=leg["id"], action="confirmed")
                event = "approved"
            elif body.action == "consent":
                evidence.update(scope="consent", person_id=body.person_id, action="approved")
            else:
                evidence.update(scope="bundle", action="admin_override")
            intent["approvals"].append(evidence)
            await db.settlement_intents.replace_one({"id": intent_id}, deepcopy(intent), session=session)
            await try_apply(trip, intent, actor, str(body.client_mutation_id), session)
        await save_intent(intent, session)
        return intent, event
    return await mutate(trip_id, body, user, f"settlement.approval.{body.action}", commit, binding={"intent_id": intent_id})


async def ensure_indexes(database, *, replace_incompatible_quote_index=False):
    await database.settlement_quotes.create_index("id", unique=True)
    await database.settlement_quotes.create_index([("trip_id", 1), ("expires_at", 1)])
    await database.settlement_intent_actions.create_index("id", unique=True)
    await database.settlement_intent_actions.create_index([("trip_id", 1), ("intent_id", 1)])
    await database.payments.create_index([("settlement_intent_id", 1), ("settlement_leg_id", 1)], unique=True,
        partialFilterExpression={"settlement_intent_id": {"$type": "string"}, "settlement_leg_id": {"$type": "string"}})
    await database.expense_coverage_events.create_index("plan.reservation_intent_id", unique=True,
        partialFilterExpression={"kind": "allocation", "plan.reservation_intent_id": {"$type": "string"}})
    indexes = await database.payment_attempts.index_information()
    old = indexes.get("quote_id_1")
    if old and not old.get("partialFilterExpression"):
        if not replace_incompatible_quote_index:
            raise RuntimeError("UPI quote index requires an explicitly authorized compatibility upgrade")
        await database.payment_attempts.drop_index("quote_id_1")
    await database.payment_attempts.create_index("quote_id", unique=True,
        partialFilterExpression={"quote_id": {"$type": "string"}})
