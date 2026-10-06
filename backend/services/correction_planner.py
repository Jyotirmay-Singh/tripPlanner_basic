"""Pure dependency closure and prospective correction replay."""
from copy import deepcopy

from services.coverage_support import CoverageError, POLICY_VERSION, fingerprint, money, stable_id
from services.expense_coverage import build_coverage_snapshot
from services.financial_ledger import apply_effective_ledger
from services.settlement_engine import to_scaled


def affected_events(ledger, *, expense_ids=(), source_ids=(), event_ids=()):
    reversed_ids = {row.get("reverses_event_id") for row in ledger.events if row.get("kind") == "reversal"}
    selected = set(event_ids)
    for event in ledger.events:
        if event.get("kind", "allocation") != "allocation" or event["id"] in reversed_ids:
            continue
        if (any(line["revision_id"] in {revision["id"] for revision in ledger.revisions
                                        if revision["expense_id"] in expense_ids}
                for line in event["plan"]["allocation_lines"]) or
            any(use["source_id"] in source_ids for use in event.get("cash_uses", []))):
            selected.add(event["id"])
    events = [row for row in ledger.events if row["id"] in selected and row["id"] not in reversed_ids
              and row.get("kind", "allocation") == "allocation"]
    if selected - {row["id"] for row in events}:
        raise CoverageError("invalid_reversal")
    return sorted(events, key=lambda row: (row.get("sequence", 0), row["id"]))


def reversal_events(ledger, events, operation_id, actor_id, reason, at):
    return [{"id": stable_id(operation_id, "reverse", event["id"]), "trip_id": ledger.trip["id"],
             "kind": "reversal", "reverses_event_id": event["id"], "status": "applied",
             "policy_version": POLICY_VERSION, "sequence": ledger.trip.get("version", 0) + 1,
             "actor_user_id": actor_id, "client_mutation_id": stable_id(operation_id, event["id"]),
             "request_hash": fingerprint({"reverses_event_id": event["id"], "reason": reason}),
             "correction_id": operation_id, "reason": reason, "created_at": at} for event in events]


def invalidate_intents(ledger, expense_ids, event_ids, source_ids, operation_id, *, binding_changed=False):
    revisions = {row["id"] for row in ledger.revisions if row["expense_id"] in expense_ids}
    affected = []
    for intent in ledger.intents:
        if not binding_changed and not (any(line["revision_id"] in revisions for line in intent.get("plan", {}).get("allocation_lines", []))
                or intent.get("coverage_event_id") in event_ids
                or any(leg.get("source_id") in source_ids for leg in intent.get("cash_legs", []))):
            continue
        if intent.get("status") in {"reversed", "rejected", "canceled", "expired"}:
            continue
        legs = intent.get("cash_legs", [])
        reported = any(leg.get("source_id") or leg.get("receipt_status") not in {"initiated", "expired", "canceled"}
                       for leg in legs)
        if intent.get("coverage_event_id") in event_ids:
            intent.update(status="reversed", allocation_status="reversed")
        elif reported:
            intent.update(status="needs_review", allocation_status="needs_review", expires_at=None)
            intent["review_reasons"] = sorted(set(intent.get("review_reasons", []) + ["financial_correction"]))
        else:
            intent.update(status="canceled", allocation_status="canceled")
        intent["correction_id"] = operation_id
        intent["version"] = intent.get("version", 0) + 1
        affected.append(deepcopy(intent))
    return affected


def preview_effects(ledger, event, revisions, new_expenses, new_members=None):
    candidate = deepcopy(ledger)
    candidate.events.extend(event["reversal_events"])
    candidate.revisions.extend(deepcopy(revisions))
    changed = {row["id"]: row for row in new_expenses}
    candidate.expenses = [deepcopy(changed.pop(row["id"], row)) for row in candidate.expenses]
    candidate.expenses.extend(changed.values())
    if new_members is not None:
        candidate.trip["members"] = deepcopy(new_members)
        candidate.identities += [{"id": stable_id(event["id"], member["id"]), "member_snapshot": member}
                                 for member in ledger.trip["members"]]
    invalidate_intents(candidate, [row["id"] for row in new_expenses], event["reversed_event_ids"],
                       [row["source_id"] for row in event["cash_changes"]], event["id"])
    candidate.corrections.append(deepcopy(event))
    apply_effective_ledger(candidate)
    result = build_coverage_snapshot(candidate, infer_history=False)
    before = build_coverage_snapshot(ledger, infer_history=False)
    bundles = [row for row in ledger.events if row["id"] in event["reversed_event_ids"]]
    affected_expenses = {row["id"] for row in new_expenses} | {
        before.shares[line["share_id"]]["expense_id"] for bundle in bundles
        for line in bundle["plan"]["allocation_lines"] if line["share_id"] in before.shares}
    expense_names = {row["id"]: row.get("description") or "Expense"
                     for row in (ledger.raw_expenses or ledger.expenses)}
    return {"before_balances": {key: money(value) for key, value in before.precise_net.items()},
            "after_balances": {key: money(value) for key, value in result.precise_net.items()},
            "expense_names": {key: expense_names.get(key, "Historical expense") for key in sorted(affected_expenses)},
            "shares": [{"expense_id": row["expense_id"], "person_id": row["person_id"],
                        "person_name": row["person_name"], "wallet_id": row["wallet_id"],
                        "share_id": row["id"], "original_share": row["original_share"],
                        "remaining_amount": money(result.remaining(row["id"]))} for row in result.shares.values()
                       if row["expense_id"] in affected_expenses],
            "unapplied_credit": [{"source_id": key, "amount": money(to_scaled(row["amount"]) - result.claimed.get(key, 0))}
                                  for key, row in result.sources.items()
                                  if to_scaled(row["amount"]) > result.claimed.get(key, 0)],
            "reversed_event_ids": event["reversed_event_ids"],
            "affected_bundles": [{"event_id": row["id"], "cash_uses": deepcopy(row.get("cash_uses", [])),
                "allocation_lines": deepcopy(row["plan"]["allocation_lines"]),
                "required_person_ids": row["plan"]["required_person_ids"],
                "approval_count": len(row.get("approval_evidence", row.get("approvals", [])))} for row in bundles],
            "cash_sources": [{"source_id": key, "amount": row["amount"],
                "payer_wallet_id": row["from_member_id"], "receiver_wallet_id": row["to_member_id"]}
                for key, row in before.sources.items()
                if key in {use["source_id"] for bundle in bundles for use in bundle.get("cash_uses", [])}
                or key in {change["source_id"] for change in event["cash_changes"]}],
            "recorded_cash_changes": [{"before_amount": money(to_scaled((change.get("before") or {}).get("amount", 0))),
                "after_amount": money(to_scaled((change.get("after") or {}).get("amount", 0))),
                "payer_wallet_id": (change.get("before") or change["after"])["from_member_id"],
                "receiver_wallet_id": (change.get("before") or change["after"])["to_member_id"]}
                for change in event["cash_changes"]],
            "before_shares": [{"share_id": row["id"], "revision_id": row["revision_id"],
                "expense_id": row["expense_id"], "original_share": row["original_share"],
                "person_id": row["person_id"], "person_name": row["person_name"], "wallet_id": row["wallet_id"],
                "remaining_amount": money(before.remaining(row["id"])),
                "reserved_amount": money(sum(row["reservations"].values()))} for row in before.shares.values()
                if row["expense_id"] in affected_expenses],
            "affected_reports": deepcopy(result.pending_reports),
            "review_cases": result.review_cases}
