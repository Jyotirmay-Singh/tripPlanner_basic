"""Exact money and identifiers shared by the coverage projection and journal."""

import hashlib
import json
from datetime import datetime, timezone
from functools import wraps
from uuid import NAMESPACE_URL, uuid5

from services.settlement_engine import SCALE, scaled_string, to_scaled

POLICY_VERSION = "expense_coverage_v1"
HISTORY_VERSION = "legacy_coverage_v1"
PROTOCOL_VERSION = 1
SOURCE_KINDS = ("wallet_funding", "direct", "group", "approved_offset", "historical_inferred")
CONVERSION_EVIDENCE_FIELDS = (
    "currency", "original_amount", "original_currency", "original_custom_amounts", "exchange_rate",
    "exchange_rate_requested_date", "exchange_rate_date", "exchange_rate_provider",
    "exchange_rate_provider_sources", "exchange_rate_mode", "exchange_rate_stale",
    "manual_input_type", "manual_input_value", "conversion_version", "conversion_history",
)


class CoverageError(ValueError):
    def __init__(self, code, message=None):
        self.code = code
        super().__init__(message or code.replace("_", " "))


def record_errors(code):
    """Reject malformed stored/client record shapes with a stable domain error.

    Numerical ledger errors and intentional CoverageErrors retain their own diagnostic codes.
    Database and programming/runtime failures are not turned into successful projections.
    """
    def decorate(function):
        @wraps(function)
        def checked(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except (KeyError, TypeError, AttributeError, IndexError) as exc:
                raise CoverageError(code) from exc
        return checked
    return decorate


def fingerprint(value):
    def canonical(item):
        if isinstance(item, datetime):
            # MongoDB stores millisecond UTC instants; previews must hash the persisted precision.
            item = item.replace(tzinfo=timezone.utc) if item.tzinfo is None else item.astimezone(timezone.utc)
            return item.isoformat(timespec="milliseconds")
        if isinstance(item, dict):
            return {key: canonical(value) for key, value in item.items()}
        if isinstance(item, (list, tuple)):
            return [canonical(value) for value in item]
        return item
    return hashlib.sha256(json.dumps(canonical(value), sort_keys=True, separators=(",", ":"),
                                     default=str).encode()).hexdigest()


def legacy_fingerprint(value):
    """Version-1 immutable records used JSON's datetime string representation."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def stable_id(*parts):
    return str(uuid5(NAMESPACE_URL, "tripsplitter:coverage:" + ":".join(map(str, parts))))


def money(value):
    """Format scaled integers as API decimal strings, retaining legacy precision."""
    return str(value // SCALE) if value % SCALE == 0 else scaled_string(value).rstrip("0").rstrip(".")


def whole_units(value, *, positive=True):
    amount = to_scaled(value)
    if amount % SCALE or (positive and amount <= 0):
        raise CoverageError("invalid_whole_amount")
    return amount


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def timestamp_key(value):
    parsed = timestamp(value)
    return parsed.isoformat() if parsed else ""


def financial_fingerprint(expense, *, legacy=False):
    fields = ("id", "paid_by_member_id", "paid_by_person_id", "split_mode", "split_member_ids",
              "weight_snapshots", "family_participants", "family_member_entity_snapshots",
              "custom_amounts", "created_at", *CONVERSION_EVIDENCE_FIELDS)
    return (legacy_fingerprint if legacy else fingerprint)({**{key: expense.get(key) for key in fields},
                        "amount": money(to_scaled(expense.get("amount")))})


def cash_fingerprint(row, currency, *, legacy=False):
    return (legacy_fingerprint if legacy else fingerprint)({key: row.get(key) for key in (
        "id", "from_member_id", "to_member_id", "amount", "created_at", "paid_at",
        "status", "payment_attempt_id", "settlement_intent_id",
        "expense_share_refs", "actual_payer_person_id", "actual_receiver_person_id",
    )} | {"currency": row.get("currency") or currency})


def source_fingerprint_matches(source, expected):
    return expected in {source["fingerprint"], cash_fingerprint(source["row"], source["currency"], legacy=True)}


def add_vector(vector, debtor, creditor, amount):
    """Obligation orientation: debtor negative, creditor positive."""
    vector[debtor] = vector.get(debtor, 0) - amount
    vector[creditor] = vector.get(creditor, 0) + amount
