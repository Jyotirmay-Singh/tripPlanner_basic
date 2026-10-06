"""Deterministic historical review. No database access or mutation in report construction."""
from copy import deepcopy

from services.coverage_support import fingerprint, money, stable_id
from services.expense_coverage import build_coverage_snapshot, preview_historical_reconciliation
from services.financial_ledger import financial_record
from services.settlement_engine import to_scaled


def dry_run(ledger, prerequisites=()):
    raw = build_coverage_snapshot(ledger, infer_history=False)
    inferred = deepcopy(raw)
    links = preview_historical_reconciliation(inferred)["inferred_allocations"]
    proposed = []
    for source_id, source in sorted(raw.sources.items()):
        proposed.append({"source_id": source_id, "from_member_id": source["from_member_id"],
            "to_member_id": source["to_member_id"], "amount": source["amount"], "currency": source["currency"],
            "claimed": money(raw.claimed.get(source_id, 0)),
            "unapplied": money(to_scaled(source["amount"]) - raw.claimed.get(source_id, 0)),
            "fingerprint": source["fingerprint"], "attempt_link_is_evidence_only": bool(source["row"].get("payment_attempt_id"))})
    allocations = [{"source_id": row["source_id"], "share_id": row["share_id"],
                    "revision_id": row["revision_id"], "amount": row["amount"]} for row in links]
    duplicates = []
    linked = {}
    for source in raw.sources.values():
        row = source["row"]
        key = row.get("payment_attempt_id") or row.get("settlement_leg_id")
        if key:
            linked.setdefault(key, []).append(source["id"])
    duplicates = [sorted(ids) for ids in linked.values() if len(ids) > 1]
    # Compare a frozen proposed projection, rather than asserting a zero difference.
    from services.financial_ledger import apply_effective_ledger
    candidate = deepcopy(ledger)
    candidate.revisions = deepcopy(raw.revisions)
    for revision in candidate.revisions:
        for share in revision["shares"]:
            for key in ("coverage_units", "coverage_explanations", "reservations"):
                share.pop(key, None)
    pointer = {row["expense_id"]: row["id"] for row in raw.revisions}
    for expense in candidate.expenses:
        if not expense.get("deleted_at"):
            expense["active_revision_id"] = pointer[expense["id"]]
    candidate.trip["expense_settlement_schema_version"] = 2
    apply_effective_ledger(candidate)
    after = build_coverage_snapshot(candidate, infer_history=False)
    difference = {key: money(after.precise_net.get(key, 0) - raw.precise_net.get(key, 0))
                  for key in sorted(set(raw.precise_net) | set(after.precise_net))}
    report = {"schema_version": 2, "trip_id": ledger.trip["id"], "snapshot_id": raw.snapshot_id,
        "baseline_wallet_vector": {key: money(value) for key, value in raw.precise_net.items()},
        "reconciliation_difference": difference, "source_link_duplicates": duplicates,
        "sources": proposed, "evidenced_direct_links": allocations,
        "pending_work": deepcopy(raw.pending_reports), "review_cases": deepcopy(inferred.review_cases) + [
            {**deepcopy(case["evidence"]), "case_id": case["id"]} for case in ledger.reconciliation_cases],
        "adjustments": {key: str(value) for key, value in ledger.adjustments.items()},
        "revisions": [{"expense_id": row["expense_id"], "revision_id": row["id"],
                       "fingerprint": row["financial_fingerprint"], "people": [s["person_id"] for s in row["shares"]],
                       "evidence": row["evidence"]} for row in raw.revisions],
        "counts": {"expenses": len(ledger.expenses), "sources": len(proposed), "events": len(ledger.events),
                   "intents": len(ledger.intents), "attempts": len(ledger.attempts), "links": len(allocations)}}
    report["plan_hash"] = fingerprint(report)
    report["index_prerequisites"] = list(prerequisites)
    report["activation_blocked"] = bool(report["review_cases"] or report["pending_work"] or prerequisites or duplicates
                                        or any(to_scaled(value) for value in difference.values())
                                        or any(to_scaled(row["unapplied"]) for row in proposed))
    return report


def report_or_blocked(ledger, prerequisites=()):
    """Malformed/unknown history stays a visible review case, never a best-effort migration."""
    from services.coverage_support import CoverageError
    from services.settlement_engine import SettlementLedgerError
    try:
        return dry_run(ledger, prerequisites)
    except (CoverageError, SettlementLedgerError) as exc:
        return blocked_report(ledger, exc.code, prerequisites)


def blocked_report(ledger, code, prerequisites=()):
    report = {"schema_version": 2, "trip_id": ledger.trip["id"], "snapshot_id": None,
            "baseline_wallet_vector": {}, "reconciliation_difference": {}, "sources": [],
            "source_link_duplicates": [], "evidenced_direct_links": [], "pending_work": [],
            "review_cases": [{"code": code, "share_ids": []}], "revisions": [],
            "counts": {"expenses": len(ledger.expenses), "payments": len(ledger.payments),
                "settlements": len(ledger.settlements), "events": len(ledger.events), "intents": len(ledger.intents), "attempts": len(ledger.attempts)},
            "index_prerequisites": list(prerequisites), "activation_blocked": True,
            "input_hash": fingerprint(vars(ledger))}
    report["plan_hash"] = fingerprint(report)
    return report


async def load_review_report(trip_id, database, *, session=None, trip=None, prerequisites=()):
    """Report corrupted evidence without allowing it into the effective accounting projection."""
    from services.ledger_snapshot import load_ledger
    from services.coverage_support import CoverageError
    from services.settlement_engine import SettlementLedgerError
    ledger = await load_ledger(trip_id, database, coverage=True, session=session, trip=trip, effective=False)
    try:
        from services.financial_ledger import apply_effective_ledger
        effective = deepcopy(ledger)
        if effective.trip.get("expense_settlement_schema_version", 1) not in {1, 2}:
            raise CoverageError("unsupported_accounting_schema")
        if effective.trip.get("expense_settlement_schema_version") == 2 or effective.trip.get("financial_write_guard_version") == 2:
            apply_effective_ledger(effective)
        return report_or_blocked(effective, prerequisites)
    except (CoverageError, SettlementLedgerError) as exc:
        return blocked_report(ledger, exc.code, prerequisites)
    except (KeyError, TypeError, ValueError, OverflowError):
        return blocked_report(ledger, "malformed_accounting_history", prerequisites)


async def stage_and_apply(database, client, trip_id, accepted_hash, actor_id, reason, *, activate=False, batch_size=100):
    """Resumable evidence staging; only the final transaction exposes revisions and readiness."""
    from pymongo.read_concern import ReadConcern
    from pymongo.write_concern import WriteConcern
    from services.financial_corrections import index_prerequisites
    from services.ledger_snapshot import load_ledger
    from services.coverage_support import CoverageError
    from utils.permissions import role_of
    from utils.common import now_utc
    missing = await index_prerequisites(database)
    if missing:
        raise CoverageError("correction_indexes_required")
    if not 1 <= batch_size <= 500:
        raise CoverageError("invalid_batch_size")
    run_id = stable_id(trip_id, accepted_hash, "historical-review")

    async def prepare(session):
        ledger = await load_ledger(trip_id, database, coverage=True, session=session)
        actor = await database.users.find_one({"id": actor_id}, {"_id": 0}, session=session)
        from services.coverage_allocations import _current_access
        if not _current_access(ledger.trip, actor) or role_of(ledger.trip, actor) not in {"owner", "admin", "super_admin"} or not reason.strip():
            raise CoverageError("insufficient_authority")
        previous = await database.reconciliation_runs.find_one({"id": run_id}, {"_id": 0}, session=session)
        if previous and previous["status"] == "applied":
            return None, None
        report = dry_run(ledger)
        if report["plan_hash"] != accepted_hash:
            raise CoverageError("historical_snapshot_changed")
        snapshot = build_coverage_snapshot(ledger, infer_history=False)
        staged = []
        for revision in snapshot.revisions:
            frozen = deepcopy(revision)
            for share in frozen["shares"]:
                for key in ("coverage_units", "coverage_explanations", "reservations"):
                    share.pop(key, None)
            staged.append({"kind": "revision", "resource_id": frozen["id"], "payload": frozen})
        for member in ledger.trip["members"]:
            staged.append({"kind": "identity", "resource_id": member["id"], "payload": deepcopy(member)})
        for source in snapshot.sources.values():
            staged.append({"kind": "source", "resource_id": source["id"], "payload": financial_record(source["row"])})
        for index, case in enumerate(report["review_cases"]):
            staged.append({"kind": "case", "resource_id": str(index), "payload": deepcopy(case)})
        manifest = fingerprint(staged)
        await database.reconciliation_runs.update_one({"id": run_id}, {"$setOnInsert": {
            "id": run_id, "trip_id": trip_id, "plan_hash": accepted_hash, "actor_user_id": actor_id,
            "reason": reason, "created_at": now_utc().isoformat(), "status": "staging",
            "report": report, "manifest_hash": manifest, "record_count": len(staged)}}, upsert=True, session=session)
        return staged, manifest

    async with await client.start_session() as session:
        staged, manifest = await session.with_transaction(prepare, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))
    if staged is None:
        return {"id": run_id, "status": "already_applied"}
    # Staging rows are invisible to all ledger readers and safe to resume by deterministic ID.
    for start in range(0, len(staged), batch_size):
        async def batch(session):
            for index, row in enumerate(staged[start:start + batch_size], start):
                await database.reconciliation_staging.update_one({"id": stable_id(run_id, index)},
                    {"$setOnInsert": {"id": stable_id(run_id, index), "run_id": run_id, "trip_id": trip_id,
                     "position": index, "payload_hash": fingerprint(row), **row}}, upsert=True, session=session)
            await database.reconciliation_runs.update_one({"id": run_id, "status": "staging"},
                {"$max": {"staged_count": min(start + batch_size, len(staged))}}, session=session)
        async with await client.start_session() as session:
            await session.with_transaction(batch, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))

    async def commit(session):
        ledger = await load_ledger(trip_id, database, coverage=True, session=session)
        report = dry_run(ledger)
        previous = await database.reconciliation_runs.find_one({"id": run_id}, {"_id": 0}, session=session)
        if previous and previous["status"] == "applied":
            return {"id": run_id, "status": "already_applied"}
        records = await database.reconciliation_staging.find({"run_id": run_id}, {"_id": 0}, session=session).sort("position", 1).to_list(None)
        content = [{key: row[key] for key in ("kind", "resource_id", "payload")} for row in records]
        if len(content) != len(staged) or fingerprint(content) != manifest or previous["manifest_hash"] != manifest:
            raise CoverageError("historical_staging_incomplete")
        if report["plan_hash"] != accepted_hash:
            raise CoverageError("historical_snapshot_changed")
        actor = await database.users.find_one({"id": actor_id}, {"_id": 0}, session=session)
        from services.coverage_allocations import _current_access
        if not _current_access(ledger.trip, actor) or role_of(ledger.trip, actor) not in {"owner", "admin", "super_admin"} or not reason.strip():
            raise CoverageError("insufficient_authority")
        if activate and report["activation_blocked"]:
            raise CoverageError("historical_review_required")
        at = now_utc().isoformat()
        snapshot = build_coverage_snapshot(ledger, infer_history=False)
        # Preserve existing IDs referenced by journal/attempts. A new correction always gets a new ID.
        for revision in snapshot.revisions:
            if revision["id"] not in {row["id"] for row in ledger.revisions}:
                frozen = deepcopy(revision)
                for share in frozen["shares"]:
                    for key in ("coverage_units", "coverage_explanations", "reservations"):
                        share.pop(key, None)
                await database.expense_share_revisions.insert_one(frozen, session=session)
            await database.expenses.update_one({"id": revision["expense_id"], "trip_id": trip_id},
                {"$set": {"active_revision_id": revision["id"]}}, session=session)
        for member in ledger.trip["members"]:
            await database.ledger_identity_snapshots.update_one({"id": stable_id(run_id, member["id"])},
                {"$setOnInsert": {"id": stable_id(run_id, member["id"]), "trip_id": trip_id,
                 "member_id": member["id"], "member_snapshot": member, "run_id": run_id, "created_at": at}}, upsert=True, session=session)
        for source in snapshot.sources.values():
            initial_id = stable_id(trip_id, source["id"], "initial-source-version")
            await database.cash_source_versions.update_one({"id": initial_id},
                {"$setOnInsert": {"id": initial_id, "trip_id": trip_id,
                 "root_source_id": source["id"], "version_number": 0,
                 "snapshot": financial_record(source["row"]), "run_id": run_id}}, upsert=True, session=session)
        # Evidenced links are suggestions; no receipt approval or financial effect is invented here.
        # They require an explicit online admin reconciliation after the guarded upgrade.
        fields = {"expense_settlement_schema_version": 2, "financial_write_guard_version": 2,
                  "reconciliation_run_id": run_id}
        if activate:
            fields["expense_settlement_activation_version"] = 1
        result = await database.trips.update_one({"id": trip_id, "version": ledger.trip.get("version", 0)},
            {"$set": fields, "$inc": {"version": 1}}, session=session)
        if result.matched_count != 1:
            raise CoverageError("historical_snapshot_changed")
        await database.users.update_one({"id": actor_id}, {"$inc": {"settlement_action_version": 1}}, session=session)
        for row in records:
            if row["kind"] == "case":
                await database.reconciliation_cases.update_one({"id": stable_id(run_id, "case", row["resource_id"])},
                    {"$setOnInsert": {"id": stable_id(run_id, "case", row["resource_id"]), "trip_id": trip_id,
                     "run_id": run_id, "status": "open", "created_at": at, "evidence": row["payload"]}}, upsert=True, session=session)
        await database.reconciliation_runs.update_one({"id": run_id, "status": "staging"},
            {"$set": {"status": "applied", "activated": activate, "applied_at": at}}, session=session)
        return {"id": run_id, "status": "applied", "activated": activate}
    async with await client.start_session() as session:
        return await session.with_transaction(commit, read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))
