"""Idempotent per-trip migration to the application-wide whole-unit ledger policy.

The pure planner is intentionally separate from MongoDB writes so dry-runs and tests can prove
conservation without mutating data.  Apply/revert use required per-trip transactions and fail closed
when the database cannot provide them.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterable, Optional

from bson.decimal128 import Decimal128

from database import db
from services.custom_split import ordered_exact_member_ids
from services.ledger_transactions import run_required_transaction
from services.payment_attempts import ACTIVE_PAYMENT_ATTEMPT_STATUSES
from services.settlement_engine import (
    SCALE,
    SettlementLedgerError,
    apply_migration_adjustments,
    build_precise_net,
    joint_round,
)
from utils.common import gen_id, now_utc
from utils.money_policy import (
    MONEY_POLICY_VERSION,
    apportion_whole_amounts,
    decimal_money,
    whole_money,
)


class WholeUnitMigrationError(RuntimeError):
    def __init__(self, message: str, *, code: str = "migration_failed") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PlannedUpdate:
    collection: str
    document_id: str
    fields: dict[str, Any]


@dataclass(frozen=True)
class TripMigrationPlan:
    trip_id: str
    status: str
    changes: tuple[dict, ...]
    updates: tuple[PlannedUpdate, ...]
    target_net: dict[str, int]
    post_rounding_net: dict[str, int]
    adjustment_vector: dict[str, int]
    reason: Optional[str] = None

    def public(self) -> dict:
        return {
            "trip_id": self.trip_id,
            "status": self.status,
            "reason": self.reason,
            "changed_field_count": len(self.changes),
            "changes": _audit_value(list(self.changes)),
            "target_net": self.target_net,
            "post_rounding_net": self.post_rounding_net,
            "adjustment_vector": self.adjustment_vector,
        }


def _plain_decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal128):
        return value.to_decimal()
    return decimal_money(value)


def _audit_value(value: Any) -> Any:
    if isinstance(value, Decimal128):
        return str(value.to_decimal())
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, dict):
        return {str(key): _audit_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_audit_value(item) for item in value]
    if isinstance(value, tuple):
        return [_audit_value(item) for item in value]
    return value


def _money_equal(left: Any, right: Any) -> bool:
    try:
        return _plain_decimal(left) == _plain_decimal(right)
    except (TypeError, ValueError):
        return left == right


def _map_equal(left: Any, right: Any) -> bool:
    a = left or {}
    b = right or {}
    if set(a) != set(b):
        return False
    return all(_money_equal(a[key], b[key]) for key in a)


def _ordered_map_keys(values: dict, members: list[dict]) -> list[str]:
    roster = ordered_exact_member_ids(members)
    order = [member_id for member_id in roster if member_id in values]
    order.extend(sorted(str(member_id) for member_id in values if member_id not in order))
    return order


def _reconcile_exact_map(
    values: dict,
    target: int,
    members: list[dict],
    payer_id: Optional[str],
) -> dict[str, int]:
    order = _ordered_map_keys(values, members)
    if not order:
        raise WholeUnitMigrationError(
            "Exact split has no allocation rows",
            code="invalid_exact_split",
        )
    normalized_values = {
        str(member_id): _plain_decimal(values[member_id])
        for member_id in order
    }
    if any(value < 0 for value in normalized_values.values()) and target >= 0:
        raise WholeUnitMigrationError(
            "Exact allocation magnitudes cannot be negative",
            code="invalid_exact_split",
        )
    return apportion_whole_amounts(
        normalized_values,
        order,
        target,
        preferred_id=payer_id if payer_id in normalized_values else None,
    )


def _record_change(
    changes: list[dict],
    collection: str,
    document_id: str,
    field: str,
    before: Any,
    after: Any,
    *,
    before_exists: bool = True,
) -> None:
    changes.append({
        "collection": collection,
        "document_id": document_id,
        "field": field,
        "before_exists": before_exists,
        # Keep BSON-native values here: this immutable record is also the exact revert backup.
        "before": before,
        "after": after,
    })


def _normalize_document_amount(
    document: dict,
    collection: str,
    *,
    label: str,
    changes: list[dict],
) -> dict:
    clone = deepcopy(document)
    if clone.get("amount") is None:
        raise WholeUnitMigrationError(f"{label} has no amount", code="missing_amount")
    # Migration must be able to retire legacy sub-unit rows such as 0.49 by storing 0. New API
    # writes still reject non-zero inputs that round to zero at their write boundary.
    after = whole_money(clone["amount"], label=label, reject_nonzero_to_zero=False)
    if not _money_equal(clone["amount"], after):
        _record_change(changes, collection, str(clone.get("id")), "amount", clone["amount"], after)
        clone["amount"] = after
    return clone


def plan_trip_migration(
    trip: dict,
    expenses: Iterable[dict],
    settlements: Iterable[dict],
    payments: Iterable[dict],
    *,
    active_attempts: Iterable[dict] = (),
) -> TripMigrationPlan:
    """Build and validate one trip's complete migration without performing I/O."""

    trip_id = str(trip.get("id") or "")
    if not trip_id:
        raise WholeUnitMigrationError("Trip has no id", code="missing_trip_id")
    existing_policy = trip.get("money_policy_version")
    if existing_policy == MONEY_POLICY_VERSION:
        return TripMigrationPlan(trip_id, "already_applied", (), (), {}, {}, {})
    if existing_policy not in (None, ""):
        raise WholeUnitMigrationError(
            f"Trip uses unsupported money policy '{existing_policy}'",
            code="policy_conflict",
        )
    if any(
        attempt.get("status") in ACTIVE_PAYMENT_ATTEMPT_STATUSES
        for attempt in active_attempts
    ):
        return TripMigrationPlan(
            trip_id,
            "blocked",
            (),
            (),
            {},
            {},
            {},
            reason="active_upi_attempt",
        )

    original_expenses = [deepcopy(row) for row in expenses]
    original_settlements = [deepcopy(row) for row in settlements]
    original_payments = [deepcopy(row) for row in payments]
    try:
        original_net = build_precise_net(
            trip.get("members") or [],
            original_expenses,
            [row for row in original_settlements if row.get("status") != "pending"],
            original_payments,
        )
        target_counts = joint_round(original_net, SCALE)
    except SettlementLedgerError as exc:
        raise WholeUnitMigrationError(str(exc), code=exc.code) from exc
    target_net = {member_id: int(value) for member_id, value in target_counts.items()}

    changes: list[dict] = []
    updates: list[PlannedUpdate] = []
    migrated_trip = deepcopy(trip)
    trip_fields: dict[str, Any] = {"money_policy_version": MONEY_POLICY_VERSION}
    _record_change(
        changes,
        "trips",
        trip_id,
        "money_policy_version",
        existing_policy,
        MONEY_POLICY_VERSION,
        before_exists="money_policy_version" in trip,
    )
    if trip.get("budget") is not None:
        budget = whole_money(
            trip["budget"], label="Budget", reject_nonzero_to_zero=False
        )
        if not _money_equal(trip["budget"], budget):
            trip_fields["budget"] = budget
            _record_change(changes, "trips", trip_id, "budget", trip["budget"], budget)
    migrated_trip.update(trip_fields)
    updates.append(PlannedUpdate("trips", trip_id, trip_fields))

    migrated_expenses: list[dict] = []
    for expense in original_expenses:
        migrated = _normalize_document_amount(
            expense,
            "expenses",
            label=f"Expense '{expense.get('id', '?')}' amount",
            changes=changes,
        )
        fields: dict[str, Any] = {}
        if not _money_equal(expense.get("amount"), migrated.get("amount")):
            fields["amount"] = migrated["amount"]

        if expense.get("original_amount") is not None:
            original_amount = whole_money(
                _plain_decimal(expense["original_amount"]),
                label=f"Expense '{expense.get('id', '?')}' original amount",
                reject_nonzero_to_zero=False,
            )
            if not _money_equal(expense["original_amount"], original_amount):
                fields["original_amount"] = original_amount
                _record_change(
                    changes,
                    "expenses",
                    str(expense.get("id")),
                    "original_amount",
                    expense["original_amount"],
                    original_amount,
                )
            migrated["original_amount"] = original_amount

        if (expense.get("split_mode") or "PER_CAPITA") == "EXACT":
            custom = expense.get("custom_amounts") or {}
            reconciled = _reconcile_exact_map(
                custom,
                int(migrated["amount"]),
                trip.get("members") or [],
                expense.get("paid_by_member_id"),
            )
            if not _map_equal(custom, reconciled):
                fields["custom_amounts"] = reconciled
                _record_change(
                    changes,
                    "expenses",
                    str(expense.get("id")),
                    "custom_amounts",
                    custom,
                    reconciled,
                )
            migrated["custom_amounts"] = reconciled

            original_custom = expense.get("original_custom_amounts")
            if original_custom is not None:
                original_target = abs(int(migrated.get("original_amount", migrated["amount"])))
                reconciled_original = _reconcile_exact_map(
                    original_custom,
                    original_target,
                    trip.get("members") or [],
                    expense.get("paid_by_member_id"),
                )
                if not _map_equal(original_custom, reconciled_original):
                    fields["original_custom_amounts"] = reconciled_original
                    _record_change(
                        changes,
                        "expenses",
                        str(expense.get("id")),
                        "original_custom_amounts",
                        original_custom,
                        reconciled_original,
                    )
                migrated["original_custom_amounts"] = reconciled_original

        if fields:
            updates.append(PlannedUpdate("expenses", str(expense.get("id")), fields))
        migrated_expenses.append(migrated)

    migrated_settlements: list[dict] = []
    for settlement in original_settlements:
        migrated = _normalize_document_amount(
            settlement,
            "settlements",
            label=f"Settlement '{settlement.get('id', '?')}' amount",
            changes=changes,
        )
        if not _money_equal(settlement.get("amount"), migrated.get("amount")):
            updates.append(PlannedUpdate(
                "settlements", str(settlement.get("id")), {"amount": migrated["amount"]}
            ))
        migrated_settlements.append(migrated)

    migrated_payments: list[dict] = []
    for payment in original_payments:
        migrated = _normalize_document_amount(
            payment,
            "payments",
            label=f"Payment '{payment.get('id', '?')}' amount",
            changes=changes,
        )
        if not _money_equal(payment.get("amount"), migrated.get("amount")):
            updates.append(PlannedUpdate(
                "payments", str(payment.get("id")), {"amount": migrated["amount"]}
            ))
        migrated_payments.append(migrated)

    try:
        rounded_net_scaled = build_precise_net(
            migrated_trip.get("members") or [],
            migrated_expenses,
            [row for row in migrated_settlements if row.get("status") != "pending"],
            migrated_payments,
        )
    except SettlementLedgerError as exc:
        raise WholeUnitMigrationError(str(exc), code=exc.code) from exc
    if any(value % SCALE for value in rounded_net_scaled.values()):
        raise WholeUnitMigrationError(
            "Rounded active ledger produced a fractional member balance",
            code="conservation_failed",
        )
    post_rounding_net = {
        member_id: value // SCALE for member_id, value in rounded_net_scaled.items()
    }
    adjustment_vector = {
        member_id: target_net[member_id] - post_rounding_net[member_id]
        for member_id in target_net
    }
    if sum(adjustment_vector.values()):
        raise WholeUnitMigrationError(
            "Migration adjustment vector is not zero-sum",
            code="conservation_failed",
        )
    adjusted = apply_migration_adjustments(rounded_net_scaled, adjustment_vector)
    adjusted_units = {member_id: value // SCALE for member_id, value in adjusted.items()}
    if adjusted_units != target_net:
        raise WholeUnitMigrationError(
            "Migration adjustment did not preserve the jointly rounded original balances",
            code="conservation_failed",
        )
    return TripMigrationPlan(
        trip_id,
        "ready",
        tuple(changes),
        tuple(updates),
        target_net,
        post_rounding_net,
        adjustment_vector,
    )


async def _load_trip_rows(trip_id: str, *, session=None) -> tuple:
    options = {"session": session} if session is not None else {}
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, **options)
    if not trip:
        raise WholeUnitMigrationError("Trip not found", code="trip_not_found")
    expenses = await db.expenses.find({"trip_id": trip_id}, {"_id": 0}, **options).to_list(None)
    settlements = await db.settlements.find({"trip_id": trip_id}, {"_id": 0}, **options).to_list(None)
    payments = await db.payments.find({"trip_id": trip_id}, {"_id": 0}, **options).to_list(None)
    attempts = await db.payment_attempts.find(
        {"trip_id": trip_id, "status": {"$in": list(ACTIVE_PAYMENT_ATTEMPT_STATUSES)}},
        {"_id": 0, "id": 1, "status": 1},
        **options,
    ).to_list(None)
    return trip, expenses, settlements, payments, attempts


async def dry_run_trip(trip_id: str) -> TripMigrationPlan:
    trip, expenses, settlements, payments, attempts = await _load_trip_rows(trip_id)
    return plan_trip_migration(
        trip,
        expenses,
        settlements,
        payments,
        active_attempts=attempts,
    )


async def apply_trip_migration(trip_id: str) -> dict:
    async def callback(session):
        trip, expenses, settlements, payments, attempts = await _load_trip_rows(
            trip_id, session=session
        )
        plan = plan_trip_migration(
            trip,
            expenses,
            settlements,
            payments,
            active_attempts=attempts,
        )
        if plan.status in {"already_applied", "blocked"}:
            return plan.public()

        for update in plan.updates:
            collection = getattr(db, update.collection)
            query = {"id": update.document_id}
            if update.collection != "trips":
                query["trip_id"] = trip_id
            mutation: dict[str, Any] = {"$set": update.fields}
            if update.collection == "trips":
                mutation["$inc"] = {"version": 1}
            result = await collection.update_one(query, mutation, session=session)
            if getattr(result, "matched_count", 1) != 1:
                raise WholeUnitMigrationError(
                    f"{update.collection} document changed during migration",
                    code="concurrent_change",
                )

        timestamp = now_utc().isoformat()
        adjustment_document = {
            "trip_id": trip_id,
            "policy_version": MONEY_POLICY_VERSION,
            "vector": plan.adjustment_vector,
            "created_at": timestamp,
        }
        await db.money_migration_adjustments.replace_one(
            {"trip_id": trip_id}, adjustment_document, upsert=True, session=session
        )
        audit = {
            "id": gen_id(),
            "migration_key": f"{MONEY_POLICY_VERSION}:{trip_id}:apply",
            "trip_id": trip_id,
            "policy_version": MONEY_POLICY_VERSION,
            "mode": "apply",
            "changes": list(plan.changes),
            "target_net": plan.target_net,
            "post_rounding_net": plan.post_rounding_net,
            "adjustment_vector": plan.adjustment_vector,
            "created_at": timestamp,
        }
        await db.money_migration_audits.insert_one(audit, session=session)
        return {**plan.public(), "status": "applied", "audit_id": audit["id"]}

    return await run_required_transaction(callback)


async def revert_trip_migration(trip_id: str) -> dict:
    async def callback(session):
        existing_revert = await db.money_migration_audits.find_one(
            {"migration_key": f"{MONEY_POLICY_VERSION}:{trip_id}:revert"},
            {"_id": 0},
            session=session,
        )
        if existing_revert:
            return {"trip_id": trip_id, "status": "already_reverted", "audit_id": existing_revert["id"]}
        trip, _expenses, _settlements, _payments, attempts = await _load_trip_rows(
            trip_id, session=session
        )
        if attempts:
            return {"trip_id": trip_id, "status": "blocked", "reason": "active_upi_attempt"}
        if trip.get("money_policy_version") != MONEY_POLICY_VERSION:
            raise WholeUnitMigrationError(
                "Trip is not on whole_unit_v1",
                code="policy_conflict",
            )
        applied = await db.money_migration_audits.find_one(
            {"migration_key": f"{MONEY_POLICY_VERSION}:{trip_id}:apply"},
            {"_id": 0},
            session=session,
        )
        if not applied:
            raise WholeUnitMigrationError("Migration backup was not found", code="backup_missing")

        grouped: dict[tuple[str, str], dict[str, Any]] = {}
        unsets: dict[tuple[str, str], dict[str, str]] = {}
        reverse_changes: list[dict] = []
        for change in applied.get("changes") or []:
            key = (change["collection"], change["document_id"])
            if change.get("before_exists", True):
                grouped.setdefault(key, {})[change["field"]] = change.get("before")
            else:
                unsets.setdefault(key, {})[change["field"]] = ""
            reverse_changes.append({
                **change,
                "before": change.get("after"),
                "after": change.get("before"),
                "before_exists": True,
                "after_exists": change.get("before_exists", True),
            })

        for collection_name, document_id in sorted(set(grouped) | set(unsets)):
            query = {"id": document_id}
            if collection_name != "trips":
                query["trip_id"] = trip_id
            mutation: dict[str, Any] = {}
            if grouped.get((collection_name, document_id)):
                mutation["$set"] = grouped[(collection_name, document_id)]
            if unsets.get((collection_name, document_id)):
                mutation["$unset"] = unsets[(collection_name, document_id)]
            if collection_name == "trips":
                mutation["$inc"] = {"version": 1}
            result = await getattr(db, collection_name).update_one(
                query, mutation, session=session
            )
            if getattr(result, "matched_count", 1) != 1:
                raise WholeUnitMigrationError(
                    f"{collection_name} backup target is missing",
                    code="backup_target_missing",
                )

        await db.money_migration_adjustments.delete_one({"trip_id": trip_id}, session=session)
        timestamp = now_utc().isoformat()
        audit = {
            "id": gen_id(),
            "migration_key": f"{MONEY_POLICY_VERSION}:{trip_id}:revert",
            "trip_id": trip_id,
            "policy_version": MONEY_POLICY_VERSION,
            "mode": "revert",
            "reverts_audit_id": applied["id"],
            "changes": reverse_changes,
            "created_at": timestamp,
        }
        await db.money_migration_audits.insert_one(audit, session=session)
        return {"trip_id": trip_id, "status": "reverted", "audit_id": audit["id"]}

    return await run_required_transaction(callback)
