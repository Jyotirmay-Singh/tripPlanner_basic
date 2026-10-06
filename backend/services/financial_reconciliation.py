"""Explicitly reviewed reuse of retained cash. A preview never claims money or shares."""
from copy import deepcopy
from datetime import timedelta
from uuid import uuid4

from services import financial_corrections as corrections, settlement_intents as workflow
from services.coverage_allocations import plan_direct_allocations, plan_group_allocations, plan_offset_allocations, cash_uses_for_plan
from services.coverage_journal import append_coverage_event
from services.coverage_support import CoverageError, fingerprint, timestamp, money, whole_units
from services.expense_coverage import build_coverage_snapshot
from services.ledger_snapshot import load_ledger
from services.settlement_engine import to_scaled
from utils.common import now_utc
from utils.permissions import role_of


def reconciliation_plan(ledger, body):
    snapshot = build_coverage_snapshot(ledger, infer_history=False)
    if body.expected_snapshot_id != snapshot.snapshot_id:
        raise CoverageError("coverage_snapshot_changed")
    if len(set(body.source_ids)) != len(body.source_ids) or set(body.source_ids) - snapshot.sources.keys():
        raise CoverageError("invalid_source_selection")
    if not body.reason.strip():
        raise CoverageError("correction_reason_required")
    if any(set(row) != {"share_id", "amount"} for row in body.shares):
        raise CoverageError("invalid_share_selection")
    for row in body.shares:
        whole_units(row["amount"])
    if body.mode == "direct":
        if len(body.source_ids) != 1 or body.cash_legs:
            raise CoverageError("select_one_evidenced_source")
        plan = plan_direct_allocations(snapshot, body.shares)
    elif body.mode == "offset":
        if body.source_ids or body.cash_legs:
            raise CoverageError("invalid_offset_contract")
        plan = plan_offset_allocations(snapshot, [row["share_id"] for row in body.shares])
    else:
        if body.shares or not body.source_ids:
            raise CoverageError("invalid_group_reconciliation")
        review = deepcopy(snapshot)
        # Reconstruct the pre-credit recommendation; retain current shares and snapshot identity.
        for source_id in body.source_ids:
            source = snapshot.sources[source_id]
            available = to_scaled(source["amount"]) - snapshot.claimed.get(source_id, 0)
            review.precise_net[source["from_member_id"]] -= available
            review.precise_net[source["to_member_id"]] += available
        plan = plan_group_allocations(review, body.cash_legs)
    available = {sid: to_scaled(snapshot.sources[sid]["amount"]) - snapshot.claimed.get(sid, 0) for sid in body.source_ids}
    uses = []
    for leg in plan["cash_legs"]:
        needed = to_scaled(leg["amount"])
        for sid in sorted(body.source_ids):
            source = snapshot.sources[sid]
            if (leg["from_member_id"], leg["to_member_id"]) != (source["from_member_id"], source["to_member_id"]):
                continue
            take = min(needed, available[sid])
            if take:
                uses.append({"leg_id": leg["id"], "source_id": sid, "amount": money(take), "source_fingerprint": source["fingerprint"]})
                available[sid] -= take
                needed -= take
        if needed:
            raise CoverageError("cash_source_exhausted")
    allocated = sum(to_scaled(use["amount"]) for use in uses)
    return {"plan": plan, "uses": uses, "basis_hash": corrections.basis(ledger),
        "effects": {"cash_posted": "0", "source_id": body.source_ids[0] if body.source_ids else "offset",
                    "source_ids": list(body.source_ids), "allocated": money(allocated),
                    "residual_credit": money(sum(available.values())),
                    "shares": deepcopy(plan["allocation_lines"])}}


async def preview(trip_id, body, user):
    async def read(session):
        trip, actor = await corrections.context(trip_id, user, session, require_activation=False)
        if role_of(trip, actor) not in workflow.ADMIN_ROLES:
            raise workflow.error("insufficient_authority", 403)
        plan = reconciliation_plan(await load_ledger(trip_id, corrections.db, trip=trip, coverage=True, session=session), body)
        row = {"id": str(uuid4()), "trip_id": trip_id, "created_by": actor["id"], "reason": body.reason,
               "plan": plan, "expires_at": (now_utc() + timedelta(minutes=5)).isoformat()}
        row["preview_hash"] = fingerprint(row)
        await corrections.db.reconciliation_previews.insert_one(deepcopy(row), session=session)
        return {key: row[key] for key in ("id", "preview_hash", "expires_at", "reason")} | {"effects": plan["effects"]}
    return await workflow.transaction(read)


async def apply(trip_id, body, user):
    async def commit(trip, actor, session):
        if role_of(trip, actor) not in workflow.ADMIN_ROLES:
            raise workflow.error("insufficient_authority", 403)
        row = await corrections.db.reconciliation_previews.find_one({"id": str(body.preview_id), "trip_id": trip_id},
                                                                  {"_id": 0}, session=session)
        if (not row or row["created_by"] != actor["id"] or row["preview_hash"] != body.preview_hash
                or timestamp(row["expires_at"]) <= now_utc()):
            raise CoverageError("reconciliation_preview_expired_or_changed")
        ledger = await load_ledger(trip_id, corrections.db, trip=trip, coverage=True, session=session)
        if corrections.basis(ledger) != row["plan"]["basis_hash"]:
            raise CoverageError("reconciliation_dependencies_changed")
        plan = row["plan"]["plan"]
        approval = {"actor_user_id": actor["id"], "plan_hash": plan["plan_hash"], "reason": row["reason"],
                    "created_at": now_utc().isoformat(), "action": "admin_override", "scope": "history"}
        receipts = [{**approval, "scope": "receipt", "action": "confirmed", "leg_id": leg["id"]}
                    for leg in plan["cash_legs"]]
        event = await append_coverage_event(trip_id, plan=plan, cash_uses=row["plan"]["uses"],
            approvals=[approval, {**approval, "scope": "bundle"}, *receipts], actor_user_id=actor["id"], client_mutation_id=body.client_mutation_id,
            session=session, advance_trip=False, resolving_existing=True)
        from services.reconciliation_cases import resolve_evidenced_cases
        await resolve_evidenced_cases(corrections.db, trip_id, row["id"], actor["id"], row["reason"], session)
        await corrections.db.reconciliation_runs.insert_one({"id": row["id"], "trip_id": trip_id,
            "preview_hash": row["preview_hash"], "event_id": event["id"], "actor_user_id": actor["id"],
            "reason": row["reason"], "created_at": now_utc().isoformat(), "effects": row["plan"]["effects"]}, session=session)
        return {"id": row["id"], "trip_id": trip_id, "operation": "reconcile_credit", "target_id": row["plan"]["effects"]["source_id"],
                "status": "applied", "version": 0, "plan_hash": plan["plan_hash"], "reason": row["reason"],
                "created_by": actor["id"], "created_at": now_utc().isoformat(), "effects": row["plan"]["effects"],
                "approvals": [approval], "required_person_ids": [], "requires_admin": True}
    return await corrections.mutate(trip_id, body, user, "reconcile", commit, require_activation=False)
