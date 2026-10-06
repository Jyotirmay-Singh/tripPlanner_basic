"""Expense/person coverage, independent of wallet-net recommendations.

Pure projection only. Cash remains in payments/settlements; the journal records coverage.
Unknown historical attribution is represented by an opaque wallet obligation, never a made-up person.
"""

from copy import deepcopy
from dataclasses import dataclass, field

from services.coverage_support import (
    CONVERSION_EVIDENCE_FIELDS, CoverageError, HISTORY_VERSION, POLICY_VERSION, SOURCE_KINDS, add_vector,
    cash_fingerprint, financial_fingerprint, fingerprint, money, record_errors, stable_id, timestamp, timestamp_key, source_fingerprint_matches,
)
from services.expense_shares import person_shares_for_entity
from services.member_breakdown import family_member_ids
from services.settlement_engine import SCALE, SettlementLedgerError, build_precise_net, expense_entity_shares_scaled, to_scaled


@record_errors("invalid_share_revision")
def make_share_revision(expense, members, trip_id, *, recorded_at=None, historical=False, legacy=False):
    """Freeze a validated new expense; historical read-time reconstruction stays conservative.

    A persisted new revision MUST use the transaction's actual recorded_at, not a backdated bill date.
    """
    amount, funding_wallet, entities = expense_entity_shares_scaled(expense, members)
    if amount and (not entities or sum(entities.values()) != amount):
        raise CoverageError("historical_participants_unknown")
    by_id = {str(member["id"]): member for member in members}
    revision_hash = financial_fingerprint(expense, legacy=legacy)
    revision_id = stable_id(trip_id, expense["id"], revision_hash)
    funding_member = by_id.get(funding_wallet, {})
    funding_person = expense.get("paid_by_person_id")
    funding_roster = family_member_ids(funding_member) if funding_member.get("kind") == "family" \
        else [funding_wallet] if funding_member else []
    if funding_person and funding_person not in funding_roster:
        raise CoverageError("invalid_funding_person")
    if funding_member.get("kind") == "individual":
        funding_person = funding_person or funding_wallet
    rows = []
    for wallet_id, signed_units in sorted(entities.items()):
        member = by_id.get(wallet_id)
        unknown = member is None
        if member and member.get("kind") == "family":
            ids = family_member_ids(member)
            real_ids = member.get("family_member_ids") or []
            selected = (expense.get("family_participants") or {}).get(wallet_id) or []
            unknown = len(real_ids) < len(member.get("family_members") or []) or not ids
            if historical:
                # Explicit participant IDs/EXACT allocations evidence participation; a current
                # roster alone cannot establish who consumed an unrestricted old family bill.
                unknown |= expense.get("split_mode") != "EXACT" and not selected
                unknown |= bool(set(selected) - set(real_ids))
                unknown |= any(owner == wallet_id and person not in real_ids
                               for person, owner in (expense.get("family_member_entity_snapshots") or {}).items()
                               if person in (expense.get("custom_amounts") or {}))
            unknown |= signed_units % SCALE != 0
        if unknown:
            people, chosen = {None: money(signed_units)}, [None]
        else:
            people, chosen = person_shares_for_entity(expense, member, money(signed_units)) \
                if signed_units % SCALE == 0 else ({wallet_id: money(signed_units)}, [wallet_id])
        if sum(to_scaled(value) for value in people.values()) != signed_units:
            raise CoverageError("person_share_mismatch")
        names = dict(zip(family_member_ids(member or {}), (member or {}).get("family_members") or []))
        for position, (person_id, value) in enumerate(people.items()):
            original = to_scaled(value)
            participating = None if person_id is None else person_id in chosen
            debtor = funding_wallet if amount < 0 else wallet_id
            creditor = wallet_id if amount < 0 else funding_wallet
            rows.append({
                "id": stable_id(revision_id, wallet_id, person_id or "unattributed"),
                "revision_id": revision_id, "expense_id": expense["id"],
                "person_id": person_id, "wallet_id": wallet_id,
                "person_name": names.get(person_id, (member or {}).get("name")) if person_id else None,
                "original_share": money(original), "participating": participating,
                "debtor_wallet_id": debtor, "creditor_wallet_id": creditor,
                "funding_wallet_id": funding_wallet, "funding_person_id": funding_person,
                "funding_participant_ids": [funding_person] if funding_person else [],
                "order": [timestamp_key(expense.get("created_at")), expense["id"], revision_hash,
                          position, person_id or ""],
                "ownership_known": person_id is not None,
            })
    # Funding-family consent comes from the frozen expense participants, not a wallet-wide approver.
    funding_participants = [row["person_id"] for row in rows
                            if row["wallet_id"] == funding_wallet and row["participating"]]
    for row in rows:
        row["funding_participant_ids"] = [funding_person] if funding_person else funding_participants
    return {
        "id": revision_id, "trip_id": trip_id, "expense_id": expense["id"],
        "revision": revision_hash, "financial_fingerprint": revision_hash,
        "policy_version": POLICY_VERSION, "effective_from": recorded_at,
        "evidence": "read_time" if historical else "recorded_at_creation",
        "entity_shares": {key: money(value) for key, value in entities.items()},
        "funding_wallet_id": funding_wallet, "funding_person_id": funding_person,
        "conversion_evidence": {key: deepcopy(expense[key]) for key in CONVERSION_EVIDENCE_FIELDS if key in expense},
        "members_snapshot": [{key: deepcopy(member.get(key)) for key in (
            "id", "kind", "name", "family_members", "family_member_ids",
        ) if key in member} for member in members],
        "shares": rows,
    }


@dataclass
class CoverageSnapshot:
    ledger: object
    shares: dict = field(default_factory=dict)
    revisions: list = field(default_factory=list)
    sources: dict = field(default_factory=dict)
    claimed: dict = field(default_factory=dict)
    blocked: set = field(default_factory=set)
    review_cases: list = field(default_factory=list)
    pending_reports: list = field(default_factory=list)
    precise_net: dict = field(default_factory=dict)
    snapshot_id: str = ""
    historical_revisions: list = field(default_factory=list)

    def remaining(self, share_id):
        row = self.shares[share_id]
        return abs(to_scaled(row["original_share"])) - sum(row["coverage_units"].values())

    def available(self, share_id, *, intent_id=None):
        if share_id in self.blocked:
            raise CoverageError("reconciliation_required")
        row = self.shares[share_id]
        reserved = sum(amount for owner, amount in row["reservations"].items() if owner != intent_id)
        return self.remaining(share_id) - reserved


def _effective_sources(ledger):
    output = {}
    for collection, rows in (("settlements", ledger.settlements), ("payments", ledger.payments)):
        for row in rows:
            if collection == "settlements" and row.get("status") == "pending":
                continue
            source_id = f"{collection}:{row['id']}"
            if source_id in output or to_scaled(row.get("amount")) <= 0:
                raise CoverageError("invalid_cash_source")
            output[source_id] = {
                "id": source_id, "from_member_id": row["from_member_id"],
                "to_member_id": row["to_member_id"], "amount": money(to_scaled(row["amount"])),
                "currency": row.get("currency") or ledger.trip.get("currency", "INR"),
                "fingerprint": cash_fingerprint(row, ledger.trip.get("currency", "INR")),
                "effective_at": row.get("paid_at") or row.get("created_at"),
                "row": row,
            }
    return output


def _components(snapshot, wallet_ids):
    adjacency = {}
    for row in snapshot.shares.values():
        a, b = row["debtor_wallet_id"], row["creditor_wallet_id"]
        adjacency.setdefault(a, set()).add(b)
        adjacency.setdefault(b, set()).add(a)
    seen, queue = set(wallet_ids), list(wallet_ids)
    while queue:
        for wallet in sorted(adjacency.get(queue.pop(), set()) - seen):
            seen.add(wallet)
            queue.append(wallet)
    return {share_id for share_id, row in snapshot.shares.items()
            if row["debtor_wallet_id"] in seen or row["creditor_wallet_id"] in seen}


def _review(snapshot, code, share_ids, *, source_id=None):
    affected = sorted(share_ids)
    snapshot.blocked.update(affected)
    snapshot.review_cases.append({"code": code, "source_id": source_id, "share_ids": affected})


def _apply_lines(snapshot, lines, sign=1):
    for line in lines:
        row = snapshot.shares.get(line["share_id"])
        if row is None or row["revision_id"] != line["revision_id"]:
            raise CoverageError("share_revision_changed")
        amount = to_scaled(line["amount"])
        if amount <= 0 or amount % SCALE or line["kind"] not in SOURCE_KINDS[1:]:
            raise CoverageError("invalid_allocation")
        row["coverage_units"][line["kind"]] += sign * amount
        if row["coverage_units"][line["kind"]] < 0 or snapshot.remaining(row["id"]) < 0:
            raise CoverageError("over_coverage")
        row["coverage_explanations"].append({**deepcopy(line), "reversed": sign < 0})


def _cash_uses(snapshot, uses, sign=1):
    for use in uses:
        source = snapshot.sources.get(use["source_id"])
        if source is None or not source_fingerprint_matches(source, use["source_fingerprint"]):
            raise CoverageError("cash_source_changed")
        amount = to_scaled(use["amount"])
        claimed = snapshot.claimed.get(source["id"], 0) + sign * amount
        if amount <= 0 or amount % SCALE or claimed < 0 or claimed > to_scaled(source["amount"]):
            raise CoverageError("cash_source_exhausted")
        snapshot.claimed[source["id"]] = claimed


def _read_events(snapshot):
    from services.coverage_allocations import validate_plan, validate_cash_uses
    events, reversed_ids = {}, set()
    for event in sorted(snapshot.ledger.events, key=lambda row: (row.get("sequence", 0), row["id"])):
        if (event["id"] in events or event.get("trip_id") != snapshot.ledger.trip["id"]
                or event.get("policy_version") != POLICY_VERSION or event.get("status") != "applied"
                or event.get("kind", "allocation") not in {"allocation", "reversal"}):
            raise CoverageError("invalid_journal")
        if event.get("kind") == "reversal":
            original = events.get(event.get("reverses_event_id"))
            if not original or original.get("kind") == "reversal" or original["id"] in reversed_ids:
                raise CoverageError("invalid_reversal")
            _apply_lines(snapshot, original["plan"]["allocation_lines"], -1)
            _cash_uses(snapshot, original["cash_uses"], -1)
            reversed_ids.add(original["id"])
        else:
            if event.get("status") != "applied":
                raise CoverageError("invalid_journal")
            validate_plan(snapshot, event["plan"], historical=True)
            validate_cash_uses(snapshot, event["plan"], event.get("cash_uses", []))
            explained = []
            for line in event["plan"]["allocation_lines"]:
                paths = [cycle for cycle in event["plan"]["cycles"]
                         if any(edge["kind"] == "obligation" and edge["id"] == line["share_id"]
                                for edge in cycle["edges"]) and cycle["kind"] == line["kind"]]
                leg_ids = {edge["id"] for cycle in paths for edge in cycle["edges"] if edge["kind"] == "cash"}
                cash_legs = []
                for leg in event["plan"]["cash_legs"]:
                    if leg["id"] not in leg_ids:
                        continue
                    for use in [use for use in event["cash_uses"] if use["leg_id"] == leg["id"]]:
                        source = snapshot.sources[use["source_id"]]
                        cash_legs.append({**deepcopy(leg), "source_id": use["source_id"], "source_amount": use["amount"],
                                          "actual_payer_person_id": source["row"].get("actual_payer_person_id"),
                                          "actual_receiver_person_id": source["row"].get("actual_receiver_person_id")})
                explained.append({**line, "bundle_id": event["id"], "paths": deepcopy(paths), "cash_legs": cash_legs})
            _apply_lines(snapshot, explained)
            _cash_uses(snapshot, event.get("cash_uses", []))
        events[event["id"]] = event


def preview_historical_reconciliation(snapshot):
    """Conservative read-time proposals. No offset consent or receipt evidence is invented."""
    inferred = []
    revision_by_id = {revision["id"]: revision for revision in snapshot.revisions}
    for source_id, source in sorted(snapshot.sources.items(), key=lambda item: (
        timestamp_key(item[1]["effective_at"]), item[0],
    )):
        unclaimed = to_scaled(source["amount"]) - snapshot.claimed.get(source_id, 0)
        if not unclaimed:
            continue
        row = source["row"]
        # A reviewed but incomplete bundle is credit, never a candidate for historical inference.
        linked_intents = [intent for intent in snapshot.ledger.intents if intent["id"] == row.get("settlement_intent_id") or
            source_id in [leg.get("source_id") for leg in intent.get("cash_legs", [])]
        ]
        if row.get("settlement_intent_id") or linked_intents:
            pending = any(intent.get("status") in {"initiated", "reported", "awaiting_confirmation", "needs_review", "awaiting_consent"}
                          for intent in linked_intents)
            _review(snapshot, "allocation_pending" if pending else "confirmed_credit_unallocated", _components(snapshot, (
                source["from_member_id"], source["to_member_id"],
            )) or snapshot.shares, source_id=source_id)
            continue
        if source["currency"] != snapshot.ledger.trip.get("currency", "INR"):
            _review(snapshot, "historical_currency_review", snapshot.shares, source_id=source_id)
            continue
        refs = row.get("expense_share_refs")
        if refs:
            # References can evidence a direct allocation; a net-equal set of opposing debts
            # does not evidence anyone's approval of an offset or indirect group discharge.
            try:
                lines = [{**ref, "kind": "historical_inferred", "source_id": source_id,
                          "explanation": "Historically inferred from retained explicit direct references"}
                         for ref in refs]
                total = 0
                for line in lines:
                    share = snapshot.shares[line["share_id"]]
                    if (not share["ownership_known"] or share["id"] in snapshot.blocked
                            or share["participating"] is False
                            or (share["debtor_wallet_id"], share["creditor_wallet_id"]) !=
                               (source["from_member_id"], source["to_member_id"])):
                        raise CoverageError("invalid_historical_reference")
                    total += to_scaled(line["amount"])
                if total != unclaimed:
                    raise CoverageError("invalid_historical_reference")
                candidate = deepcopy(snapshot)
                _apply_lines(candidate, lines)
            except (CoverageError, SettlementLedgerError, KeyError, TypeError, AttributeError):
                pass
            else:
                for line in lines:
                    line["cash_legs"] = [_historical_cash_leg(source, unclaimed)]
                _apply_lines(snapshot, lines)
                snapshot.claimed[source_id] = to_scaled(source["amount"])
                inferred.extend(lines)
                continue
        candidates = []
        paid_at = timestamp(source["effective_at"])
        for share in snapshot.shares.values():
            revision = revision_by_id[share["revision_id"]]
            effective_from = timestamp(revision.get("effective_from"))
            if (share["ownership_known"] and share["id"] not in snapshot.blocked
                    and revision.get("evidence") == "recorded_at_creation"
                    and paid_at and effective_from and effective_from <= paid_at
                    and share["debtor_wallet_id"] == source["from_member_id"]
                    and share["creditor_wallet_id"] == source["to_member_id"]
                    and share["debtor_wallet_id"] != share["creditor_wallet_id"]
                    and snapshot.remaining(share["id"]) >= unclaimed
                    and not share["reservations"] and unclaimed % SCALE == 0):
                candidates.append(share)
        if len(candidates) == 1 and not refs:
            share = candidates[0]
            line = {"share_id": share["id"], "revision_id": share["revision_id"],
                    "amount": money(unclaimed), "kind": "historical_inferred",
                    "source_id": source_id, "explanation": "Historically inferred; one evidenced directed obligation"}
            line["cash_legs"] = [_historical_cash_leg(source, unclaimed)]
            _apply_lines(snapshot, [line])
            snapshot.claimed[source_id] = to_scaled(source["amount"])
            inferred.append(line)
        else:
            affected = _components(snapshot, (source["from_member_id"], source["to_member_id"]))
            _review(snapshot, "historical_cash_unallocated", affected or snapshot.shares, source_id=source_id)
    return {"policy_version": HISTORY_VERSION, "inferred_allocations": inferred,
            "review_cases": deepcopy(snapshot.review_cases)}


def _historical_cash_leg(source, amount):
    return {"id": source["id"], "source_id": source["id"], "amount": money(amount),
            "from_member_id": source["from_member_id"], "to_member_id": source["to_member_id"],
            "actual_payer_person_id": source["row"].get("actual_payer_person_id"),
            "actual_receiver_person_id": source["row"].get("actual_receiver_person_id")}


def _pending(snapshot):
    from services.coverage_allocations import validate_plan
    active = {"initiated", "reported", "awaiting_confirmation", "needs_review", "awaiting_consent"}
    for intent in snapshot.ledger.intents:
        if intent.get("status") not in active:
            continue
        plan = intent.get("plan") or {}
        lines = (plan.get("allocation_lines") or []) if isinstance(plan, dict) else []
        selected = {line.get("share_id") for line in lines if isinstance(line, dict)} & set(snapshot.shares)
        retired_expenses = {revision["expense_id"] for revision in snapshot.historical_revisions
                            if revision["id"] in {line.get("revision_id") for line in lines}}
        selected |= {row["id"] for row in snapshot.shares.values() if row["expense_id"] in retired_expenses}
        try:
            validate_plan(snapshot, plan, historical=True)
            if plan.get("reservation_intent_id") not in {None, intent["id"]} or (
                plan["mode"] != "offset" and plan.get("reservation_intent_id") != intent["id"]
            ):
                raise CoverageError("intent_changed")
        except (CoverageError, SettlementLedgerError) as exc:
            # A broken offset proposal must never close the unpaid direct route.
            if not isinstance(plan, dict) or plan.get("mode") != "offset":
                _review(snapshot, "invalid_pending_plan", selected or snapshot.shares)
            snapshot.pending_reports.append({"id": intent["id"], "kind": "intent", "status": "needs_review",
                                             "share_ids": sorted(selected), "attributed": False,
                                             "review_reason": exc.code})
            continue
        # An offset proposal never reserves amounts.
        if plan.get("mode") != "offset":
            by_share = {}
            for line in lines:
                by_share[line["share_id"]] = by_share.get(line["share_id"], 0) + to_scaled(line["amount"])
            for share_id, amount in by_share.items():
                share = snapshot.shares.get(share_id)
                if share is None or amount < 0 or amount > snapshot.remaining(share_id):
                    raise CoverageError("invalid_reservation")
                share["reservations"][intent["id"]] = amount
        snapshot.pending_reports.append({"id": intent["id"], "kind": "intent",
                                         "status": intent["status"], "share_ids": sorted({
                                             line["share_id"] for line in lines})})
    for row in snapshot.shares.values():
        if sum(row["reservations"].values()) > snapshot.remaining(row["id"]):
            _review(snapshot, "conflicting_reservations", [row["id"]])
    linked_attempts = {leg.get("payment_attempt_id") for intent in snapshot.ledger.intents
                       for leg in intent.get("cash_legs", [])}
    for attempt in snapshot.ledger.attempts:
        from services.payment_attempts import has_sent_evidence
        unresolved = attempt.get("status") in active or (attempt.get("status") == "expired" and has_sent_evidence(attempt))
        if unresolved and attempt["id"] not in linked_attempts:
            snapshot.pending_reports.append({"id": attempt["id"], "kind": "legacy_attempt",
                                             "status": attempt["status"], "share_ids": [], "attributed": False})
            if snapshot.ledger.trip.get("expense_settlement_activation_version") == 1:
                _review(snapshot, "unattributed_payment_attempt", _components(snapshot, (
                    attempt.get("from_member_id"), attempt.get("to_member_id"))) or snapshot.shares)
    for row in snapshot.ledger.settlements:
        if row.get("status") == "pending" and not row.get("reviewed_intent_id"):
            snapshot.pending_reports.append({"id": row["id"], "kind": "legacy_settlement",
                                             "status": "pending", "share_ids": [], "attributed": False})


@record_errors("invalid_coverage_record")
def build_coverage_snapshot(ledger, *, infer_history=True):
    snapshot = CoverageSnapshot(ledger)
    for rows in (ledger.expenses, ledger.revisions, ledger.events, ledger.intents, ledger.attempts):
        seen = set()
        for record in rows:
            record_id = record["id"]
            if (not isinstance(record_id, str) or not record_id or record_id in seen
                    or record.get("trip_id", ledger.trip["id"]) != ledger.trip["id"]):
                raise CoverageError("invalid_coverage_record")
            seen.add(record_id)
    saved = {}
    for revision in ledger.revisions:
        saved.setdefault(revision["expense_id"], []).append(revision)
    for expense in sorted(ledger.expenses, key=lambda row: (timestamp_key(row.get("created_at")), row["id"])):
        current = financial_fingerprint(expense)
        legacy_current = financial_fingerprint(expense, legacy=True)
        candidates = [revision for revision in saved.get(expense["id"], [])
                      if (revision["id"] == expense["active_revision_id"] if expense.get("active_revision_id")
                          else revision["financial_fingerprint"] in {current, legacy_current})]
        if len(candidates) > 1 or (saved.get(expense["id"]) and not candidates):
            raise CoverageError("share_revision_changed")
        revision = deepcopy(candidates[0]) if candidates else make_share_revision(
            expense, ledger.trip["members"], ledger.trip["id"], historical=True,
        )
        _, _, authoritative = expense_entity_shares_scaled(expense, ledger.trip["members"])
        if revision.get("policy_version") != POLICY_VERSION or revision.get("trip_id") != ledger.trip["id"]:
            raise CoverageError("unsupported_share_revision")
        if candidates:
            if revision.get("schema_version") == 2:
                from services.financial_ledger import validate_revision
                validate_revision(revision)
            else:
                expected = make_share_revision(expense, revision.get("members_snapshot") or [], ledger.trip["id"],
                                               recorded_at=revision.get("effective_from"),
                                               historical=revision.get("evidence") == "read_time",
                                               legacy=revision["financial_fingerprint"] != current)
                if expected != revision:
                    raise CoverageError("invalid_share_revision")
        if {key: to_scaled(value) for key, value in revision["entity_shares"].items()} != authoritative:
            raise CoverageError("roster_reallocation_required")
        snapshot.revisions.append(revision)
        totals = {}
        for row in revision["shares"]:
            if row["id"] in snapshot.shares or row["revision_id"] != revision["id"]:
                raise CoverageError("invalid_share_revision")
            units = to_scaled(row["original_share"])
            totals[row["wallet_id"]] = totals.get(row["wallet_id"], 0) + units
            row["coverage_units"] = {kind: 0 for kind in SOURCE_KINDS}
            row["coverage_explanations"], row["reservations"] = [], {}
            if row["wallet_id"] == revision["funding_wallet_id"]:
                row["coverage_units"]["wallet_funding"] = abs(units)
            snapshot.shares[row["id"]] = row
            if row["person_id"] is None:
                _review(snapshot, "historical_participants_unknown", [row["id"]])
            if units % SCALE:
                _review(snapshot, "legacy_precision_review", [row["id"]])
        if {key: value for key, value in totals.items()} != authoritative:
            raise CoverageError("person_share_mismatch")
    active_share_ids = set(snapshot.shares)
    active_revision_ids = {row["id"] for row in snapshot.revisions}
    for saved_revision in ledger.revisions:
        if saved_revision["id"] in active_revision_ids:
            continue
        revision = deepcopy(saved_revision)
        from services.financial_ledger import validate_revision
        validate_revision(revision)
        snapshot.historical_revisions.append(revision)
        for row in revision["shares"]:
            row["coverage_units"] = {kind: 0 for kind in SOURCE_KINDS}
            row["coverage_explanations"], row["reservations"] = [], {}
            if row["wallet_id"] == revision["funding_wallet_id"]:
                row["coverage_units"]["wallet_funding"] = abs(to_scaled(row["original_share"]))
            if row["id"] in snapshot.shares:
                raise CoverageError("invalid_share_revision")
            snapshot.shares[row["id"]] = row
    snapshot.sources = _effective_sources(ledger)
    effective_sources = dict(snapshot.sources)
    for source_id, row in ledger.historical_sources.items():
        if source_id not in snapshot.sources:
            snapshot.sources[source_id] = {"id": source_id, "from_member_id": row["from_member_id"],
                "to_member_id": row["to_member_id"], "amount": money(to_scaled(row["amount"])),
                "currency": row.get("currency") or ledger.trip.get("currency", "INR"),
                "fingerprint": cash_fingerprint(row, ledger.trip.get("currency", "INR")),
                "effective_at": row.get("paid_at") or row.get("created_at"), "row": row}
    _read_events(snapshot)
    for share_id in set(snapshot.shares) - active_share_ids:
        if any(value for kind, value in snapshot.shares[share_id]["coverage_units"].items() if kind != "wallet_funding"):
            raise CoverageError("retired_revision_still_covered")
        del snapshot.shares[share_id]
    if any(snapshot.claimed.get(key, 0) for key in set(snapshot.sources) - set(effective_sources)):
        raise CoverageError("retired_source_still_claimed")
    snapshot.sources = effective_sources
    _pending(snapshot)
    # Suspected duplicate effective rows still both affect balances, but neither is
    # silently attributed to people during inference.
    attempt_ids = {}
    for source in snapshot.sources.values():
        attempt_id = source["row"].get("payment_attempt_id")
        if attempt_id:
            if attempt_id in attempt_ids:
                _review(snapshot, "suspected_duplicate_cash", snapshot.shares, source_id=source["id"])
            attempt_ids[attempt_id] = source["id"]
    if any(to_scaled(amount) for amount in ledger.adjustments.values()):
        _review(snapshot, "accounting_adjustment_review", snapshot.shares)
    if infer_history and ledger.trip.get("expense_settlement_schema_version", 1) == 1:
        preview_historical_reconciliation(snapshot)
    elif infer_history:
        for source_id, source in snapshot.sources.items():
            if to_scaled(source["amount"]) > snapshot.claimed.get(source_id, 0):
                _review(snapshot, "confirmed_credit_unallocated", _components(snapshot, (
                    source["from_member_id"], source["to_member_id"])), source_id=source_id)
    snapshot.precise_net = build_precise_net(ledger.accounting_members or ledger.trip["members"], ledger.expenses,
                                            ledger.settlements, ledger.payments, ledger.adjustments)
    rebuilt = {}
    for share in snapshot.shares.values():
        if share["debtor_wallet_id"] != share["creditor_wallet_id"]:
            add_vector(rebuilt, share["debtor_wallet_id"], share["creditor_wallet_id"], snapshot.remaining(share["id"]))
    for source_id, source in snapshot.sources.items():
        add_vector(rebuilt, source["to_member_id"], source["from_member_id"],
                   to_scaled(source["amount"]) - snapshot.claimed.get(source_id, 0))
    for wallet, amount in ledger.adjustments.items():
        rebuilt[wallet] = rebuilt.get(wallet, 0) + to_scaled(amount)
    if any(rebuilt.get(wallet, 0) != snapshot.precise_net.get(wallet, 0)
           for wallet in set(rebuilt) | set(snapshot.precise_net)):
        raise CoverageError("coverage_ledger_mismatch")
    snapshot.snapshot_id = fingerprint({
        "policy": POLICY_VERSION, "history": HISTORY_VERSION,
        "trip": {key: ledger.trip.get(key) for key in ("id", "version", "currency", "members", "user_ids", "admin_ids", "owner_id", "expense_settlement_activation_version", "financial_write_guard_version")},
        "expenses": sorted((financial_fingerprint(row) for row in ledger.expenses)),
        "sources": sorted((key, value["fingerprint"]) for key, value in snapshot.sources.items()),
        "pending_settlements": sorted((row["id"], fingerprint(row)) for row in ledger.settlements if row.get("status") == "pending"),
        "revisions": sorted((row["id"], fingerprint(row)) for row in ledger.revisions),
        "events": sorted((row["id"], fingerprint(row)) for row in ledger.events),
        "intents": sorted((row["id"], fingerprint(row)) for row in ledger.intents),
        "attempts": sorted((row["id"], fingerprint(row)) for row in ledger.attempts),
        "adjustments": ledger.adjustments,
        "corrections": [(row["id"], fingerprint(row)) for row in ledger.corrections],
        "identities": [(row["id"], fingerprint(row)) for row in ledger.identities],
    })
    return snapshot
