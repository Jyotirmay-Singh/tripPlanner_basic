"""Versioned, effective accounting. Historical rows are evidence, never authorization."""
from copy import deepcopy

from services.coverage_support import CoverageError, financial_fingerprint, stable_id
from services.settlement_engine import to_scaled

SCHEMA_VERSION = 2


def financial_record(row):
    return {key: deepcopy(value) for key, value in row.items()
            if key not in {"_id", "receipt_base64", "receipt_id", "receipt_version_id", "description", "category", "note",
                           "active_revision_id", "deleted_at", "correction_id"}
            and not key.startswith("_")}


def versioned_revision(expense, members, trip_id, revision_number, predecessor, operation_id, recorded_at, *, historical=False):
    from services.expense_coverage import make_share_revision
    record = financial_record(expense)
    revision = make_share_revision(record, members, trip_id, recorded_at=recorded_at, historical=historical)
    revision_id = stable_id(trip_id, expense["id"], "revision", operation_id)
    revision.update(id=revision_id, revision=revision_id, schema_version=2,
                    revision_number=revision_number, previous_revision_id=predecessor,
                    financial_snapshot=record)
    for share in revision["shares"]:
        share["revision_id"] = revision_id
        share["id"] = stable_id(revision_id, share["wallet_id"], share["person_id"] or "unattributed")
    return revision


def validate_revision(revision):
    if revision.get("schema_version", 1) not in {1, 2}:
        raise CoverageError("unsupported_share_revision")
    if revision.get("schema_version") == 2:
        from services.expense_coverage import make_share_revision
        record = revision["financial_snapshot"]
        expected = make_share_revision(record, revision["members_snapshot"], revision["trip_id"],
                                       recorded_at=revision["effective_from"], historical=revision.get("evidence") == "read_time")
        if (financial_fingerprint(record) != revision["financial_fingerprint"] or
                expected["entity_shares"] != revision["entity_shares"]):
            raise CoverageError("invalid_share_revision")
        expected_rows = expected["shares"]
        actual = revision["shares"]
        if len(expected_rows) != len(actual):
            raise CoverageError("invalid_share_revision")
        for old, new in zip(expected_rows, actual):
            old.update(id=stable_id(revision["id"], old["wallet_id"], old["person_id"] or "unattributed"),
                       revision_id=revision["id"])
            if old != new:
                raise CoverageError("invalid_share_revision")


def apply_effective_ledger(ledger):
    """Apply immutable compensations once; retain all source/revision inputs for journal replay."""
    if ledger.trip.get("expense_settlement_schema_version", 1) not in {1, 2}:
        raise CoverageError("unsupported_accounting_schema")
    if ledger.raw_payments is None:
        ledger.raw_payments = deepcopy(ledger.payments)
        ledger.raw_settlements = deepcopy(ledger.settlements)
    originals = {f"{kind}:{row['id']}": deepcopy(row)
                 for kind, rows in (("payments", ledger.raw_payments), ("settlements", ledger.raw_settlements))
                 for row in rows if kind != "settlements" or row.get("status") != "pending"}
    effective = dict(originals)
    for event in sorted(ledger.corrections, key=lambda row: (row["sequence"], row["id"])):
        if event.get("schema_version") != 2 or event["trip_id"] != ledger.trip["id"]:
            raise CoverageError("invalid_financial_correction")
        for change in event.get("cash_changes", []):
            source_id = change["source_id"]
            if source_id is not None:
                before = effective.get(source_id)
                if before is None or financial_record(before) != change["before"]:
                    raise CoverageError("cash_source_changed")
                del effective[source_id]
            elif change.get("before") is not None or not event.get("reverses_correction_id"):
                raise CoverageError("invalid_cash_restoration")
            if change.get("after"):
                after = deepcopy(change["after"])
                new_id = change["replacement_source_id"]
                if new_id in originals or to_scaled(after["amount"]) <= 0:
                    raise CoverageError("invalid_cash_source")
                originals[new_id] = after
                effective[new_id] = after
    ledger.historical_sources = originals
    pending = [row for row in ledger.raw_settlements if row.get("status") == "pending"]
    ledger.payments = [row for key, row in effective.items() if key.startswith("payments:")]
    ledger.settlements = pending + [row for key, row in effective.items() if key.startswith("settlements:")]
    revisions = {row["id"]: row for row in ledger.revisions}
    active = []
    for expense in ledger.expenses:
        if expense.get("deleted_at"):
            continue
        row = deepcopy(expense)
        revision_id = row.get("active_revision_id")
        if revision_id:
            revision = revisions.get(revision_id)
            accepted = {financial_fingerprint(row)}
            if revision and revision.get("schema_version", 1) == 1:
                accepted.add(financial_fingerprint(row, legacy=True))
            if not revision or revision["financial_fingerprint"] not in accepted:
                raise CoverageError("share_revision_changed")
            validate_revision(revision)
            row["_frozen_entity_shares"] = deepcopy(revision["entity_shares"])
            row["_revision_members_snapshot"] = deepcopy(revision["members_snapshot"])
            row["_frozen_share_rows"] = deepcopy(revision["shares"])
        elif ledger.trip.get("expense_settlement_schema_version") == 2:
            raise CoverageError("active_revision_missing")
        active.append(row)
    ledger.expenses = active
    current = {member["id"]: deepcopy(member) for member in ledger.trip["members"]}
    # Archived wallets can reopen after a reversal. Their accounts never enter current access lists.
    for identity in ledger.identities:
        member = identity["member_snapshot"]
        if member["id"] not in current:
            current[member["id"]] = {**deepcopy(member), "archived": True,
                                    "user_id": None, "family_member_user_ids": []}
    for revision in ledger.revisions:
        for historical in revision["members_snapshot"]:
            wallet = current.get(historical["id"])
            if wallet and wallet.get("kind") == historical.get("kind") == "family":
                for pid, name in zip(historical.get("family_member_ids", []), historical.get("family_members", [])):
                    if pid not in wallet.get("family_member_ids", []):
                        wallet.setdefault("family_member_ids", []).append(pid)
                        wallet.setdefault("family_members", []).append(name)
                        wallet.setdefault("family_member_user_ids", []).append(None)
                        wallet.setdefault("historical_person_ids", []).append(pid)
    ledger.accounting_members = list(current.values())
    return ledger
