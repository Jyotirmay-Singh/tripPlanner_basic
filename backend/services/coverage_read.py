"""Privacy-safe batched summary/detail presentation of one coverage snapshot."""

from datetime import datetime, timezone

from services.coverage_support import HISTORY_VERSION, POLICY_VERSION, PROTOCOL_VERSION, money
from services.coverage_allocations import _accounts
from utils.permissions import role_of, viewer_id
from services.settlement_engine import to_scaled

def _public_explanation(line):
    result = {key: line.get(key) for key in (
        "id", "share_id", "revision_id", "amount", "kind", "explanation", "source_id",
        "debtor_wallet_id", "creditor_wallet_id", "original_funding_person_id", "reversed", "bundle_id",
    ) if key in line}
    result["cash_legs"] = [{key: leg.get(key) for key in (
        "id", "from_member_id", "to_member_id", "amount", "source_id", "source_amount",
        "actual_payer_person_id", "actual_receiver_person_id",
    )}
                           for leg in line.get("cash_legs", [])]
    result["paths"] = [{"amount": cycle["amount"], "kind": cycle["kind"],
                        "edges": [{"kind": edge["kind"], "id": edge["id"]} for edge in cycle["edges"]]}
                       for cycle in line.get("paths", [])]
    return result


def unavailable_response(trip, status, *, reasons=()):
    return {"protocol_version": trip.get("expense_settlement_schema_version", PROTOCOL_VERSION), "policy_version": POLICY_VERSION,
            "history_policy_version": HISTORY_VERSION, "money_policy_version": "whole_unit_v1",
            "currency": trip.get("currency", "INR"), "ledger_version": trip.get("version", 0),
            "generated_at": datetime.now(timezone.utc).isoformat(), "snapshot_id": None,
            "complete": False, "freshness": {"consistent": False, "online_review_required": True},
            "availability": {"status": status, "new_starts_available": False},
            "uncertainty": {"present": True, "reasons": list(reasons)},
            "expenses": None, "details": None, "balances": None, "pending_reports": None}


def coverage_response(snapshot, viewer, detail_ids=(), *, capability=False, actions_ready=False):
    # API callers supply verified runtime/trip readiness; pure callers default to no starts.
    accounts = _accounts(snapshot.ledger.trip)
    actor_id = viewer_id(viewer)
    my_people = {person for person, account in accounts.items() if account and account == actor_id}
    my_wallets = {member["id"] for member in snapshot.ledger.trip["members"] if
                  member.get("user_id") == actor_id or actor_id in (member.get("family_member_user_ids") or [])}
    uncertain = {share_id for case in snapshot.review_cases if case["code"] != "allocation_pending"
                 for share_id in case["share_ids"]}
    ready = capability and actions_ready and not snapshot.ledger.trip.get("archived_at") and role_of(snapshot.ledger.trip, viewer) is not None
    summaries, details = [], {}
    by_expense = {}
    for row in snapshot.shares.values():
        by_expense.setdefault(row["expense_id"], []).append(row)
    for revision in snapshot.revisions:
        expense_id = revision["expense_id"]
        rows = sorted(by_expense.get(expense_id, []), key=lambda row: row["order"])
        participants = [row for row in rows if row["participating"]]
        unknown = any(row["participating"] is None for row in rows)
        unresolved = unknown or any(row["id"] in uncertain for row in participants)
        settled = [row for row in participants if snapshot.remaining(row["id"]) == 0 and (
            row["id"] not in uncertain or row["coverage_units"]["wallet_funding"] == abs(to_scaled(row["original_share"]))
        )]
        inferred = [row for row in settled if row["coverage_units"]["historical_inferred"]]
        mine = [row for row in participants if row["person_id"] in my_people]
        row_ids = {row["id"] for row in rows}
        pending_work = [work for work in snapshot.pending_reports if row_ids.intersection(work["share_ids"])]
        pending = bool(pending_work) or any(row["reservations"] or row["id"] in snapshot.blocked - uncertain for row in rows)
        review_reasons = sorted({case["code"] for case in snapshot.review_cases if row_ids.intersection(case["share_ids"])})
        viewer_status = "not_participating" if not mine else "review_required" if any(
            row["id"] in uncertain for row in mine) else "covered" if all(
                snapshot.remaining(row["id"]) == 0 for row in mine) else "pending" if pending else "unpaid"
        remaining = None if unresolved else money(sum(snapshot.remaining(row["id"]) for row in participants))
        summary = {"expense_id": expense_id, "revision_id": revision["id"],
                   "participant_count": None if unknown else len(participants),
                   "settled_count": None if unresolved else len(settled),
                   "known_settled_count": len(settled), "evidenced_settled_count": len(settled) - len(inferred),
                   "inferred_settled_count": len(inferred), "viewer_status": viewer_status,
                   "remaining_amount": remaining, "pending": pending,
                   "pending_work_count": len(pending_work),
                   "reserved_amount": money(sum(sum(row["reservations"].values()) for row in rows)),
                   "review_reasons": review_reasons,
                   "review_required": unresolved, "coverage_quality": "unresolved" if unresolved else
                       "historically_inferred" if any(row["coverage_units"]["historical_inferred"] for row in rows) else "evidenced"}
        summaries.append(summary)
        if expense_id in detail_ids:
            shown = []
            for row in rows:
                left = snapshot.remaining(row["id"])
                reserved = sum(row["reservations"].values())
                reliable = row["id"] not in uncertain and row["person_id"] is not None
                permitted = (row["debtor_wallet_id"] in my_wallets or role_of(snapshot.ledger.trip, viewer) in
                             {"owner", "admin", "super_admin"}) and row["participating"] is not False
                eligible = max(0, left - reserved) if reliable and row["id"] not in snapshot.blocked and permitted else None
                shown.append({key: row.get(key) for key in (
                    "id", "person_id", "person_name", "wallet_id", "participating", "original_share",
                    "debtor_wallet_id", "creditor_wallet_id", "funding_wallet_id", "funding_person_id",
                )} | {"coverage": {kind: money(amount) for kind, amount in row["coverage_units"].items()},
                      "remaining_amount": money(left) if reliable else None,
                      "known_uncovered_amount": money(left), "reserved_amount": money(reserved),
                      "eligible_remaining_amount": money(eligible) if eligible is not None else None,
                      "actionable_amount": money(eligible) if ready and eligible is not None else None,
                      "coverage_explanations": [_public_explanation(line) for line in row["coverage_explanations"]],
                      "review_required": not reliable})
            details[expense_id] = {**summary, "participants": shown}
    credits = [{"source_id": key, "amount": money(to_scaled(source["amount"]) - snapshot.claimed.get(key, 0)),
                "payer_wallet_id": source["from_member_id"], "receiver_wallet_id": source["to_member_id"],
                "actual_payer_person_id": source["row"].get("actual_payer_person_id"),
                "actual_receiver_person_id": source["row"].get("actual_receiver_person_id")}
               for key, source in sorted(snapshot.sources.items())
               if to_scaled(source["amount"]) > snapshot.claimed.get(key, 0)]
    return {"protocol_version": snapshot.ledger.trip.get("expense_settlement_schema_version", PROTOCOL_VERSION), "policy_version": POLICY_VERSION,
            "history_policy_version": HISTORY_VERSION, "money_policy_version": "whole_unit_v1",
            "currency": snapshot.ledger.trip.get("currency", "INR"), "ledger_version": snapshot.ledger.trip.get("version", 0),
            "generated_at": datetime.now(timezone.utc).isoformat(), "snapshot_id": snapshot.snapshot_id,
            "complete": True, "freshness": {"consistent": True, "online_review_required": True},
            "availability": {"status": "new_starts_disabled" if not ready else
                             "review_required" if uncertain else "available", "new_starts_available": ready},
            "uncertainty": {"present": bool(uncertain), "reasons": snapshot.review_cases},
            "expenses": summaries, "details": details,
            "balances": {key: money(value) for key, value in snapshot.precise_net.items()},
            "unapplied_credit": credits, "pending_reports": snapshot.pending_reports}
