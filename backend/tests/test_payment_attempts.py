import asyncio
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from bson.decimal128 import Decimal128
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError

from config import SUPER_ADMIN_EMAIL
from models.payment import PaymentPatch
from models.payment_attempt import (
    PaymentAttemptCreate,
    PaymentAttemptRecipientPatch,
    PaymentAttemptSenderPatch,
)
from routes import payment_attempts as attempt_routes
from routes import payments as payment_routes
from services import payment_attempts as attempt_service
from services.ledger_transactions import TransactionUnavailableError
from utils import balances as balance_utils
from utils.common import now_utc


TRIP = {
    "id": "trip-1",
    "name": "Goa Weekend",
    "currency": "INR",
    "version": 4,
    "owner_id": "owner-user",
    "admin_ids": ["owner-user", "admin-user"],
    "user_ids": [
        "owner-user",
        "admin-user",
        "payer-user",
        "payer-user-2",
        "recipient-user",
        "recipient-user-2",
        "other-user",
    ],
    "members": [
        {
            "id": "payer",
            "name": "Payer Family",
            "kind": "family",
            "family_members": ["Primary payer", "Second payer"],
            "family_member_ids": ["payer-person-1", "payer-person-2"],
            "family_member_user_ids": ["payer-user", "payer-user-2"],
        },
        {
            "id": "recipient",
            "name": "Recipient Family",
            "kind": "family",
            "family_members": ["Primary recipient", "Second recipient"],
            "family_member_ids": ["recipient-person-1", "recipient-person-2"],
            "family_member_user_ids": ["recipient-user", "recipient-user-2"],
        },
    ],
}


def run(awaitable):
    return asyncio.run(awaitable)


def _matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, clause) for clause in expected):
                return False
            continue
        actual = document.get(key)
        if isinstance(expected, dict):
            for operator, value in expected.items():
                if operator == "$in" and actual not in value:
                    return False
                if operator == "$ne" and actual == value:
                    return False
                if operator == "$lte" and not (actual is not None and actual <= value):
                    return False
                if operator == "$exists" and ((key in document) is not bool(value)):
                    return False
                if operator == "$type" and value == "string" and not isinstance(actual, str):
                    return False
            continue
        if actual != expected:
            return False
    return True


def _project(document, projection):
    result = deepcopy(document)
    if not projection:
        return result
    included = [key for key, enabled in projection.items() if enabled and key != "_id"]
    if included:
        result = {key: result[key] for key in included if key in result}
    for key, enabled in projection.items():
        if not enabled:
            result.pop(key, None)
    return result


class MemoryCursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, field, direction):
        self.rows.sort(key=lambda row: row.get(field) or "", reverse=direction < 0)
        return self

    async def to_list(self, length=None):
        rows = self.rows if length is None else self.rows[:length]
        return deepcopy(rows)


class MemoryCollection:
    def __init__(self, rows=(), *, unique=()):
        self.rows = [deepcopy(row) for row in rows]
        self.unique = tuple(unique)
        self.insert_calls = 0

    async def find_one(self, query, projection=None, **_options):
        row = next((row for row in self.rows if _matches(row, query)), None)
        return _project(row, projection) if row is not None else None

    def find(self, query, projection=None, **_options):
        return MemoryCursor([
            _project(row, projection) for row in self.rows if _matches(row, query)
        ])

    async def insert_one(self, document, **_options):
        for key in self.unique:
            value = document.get(key)
            if value is not None and any(row.get(key) == value for row in self.rows):
                raise DuplicateKeyError(f"duplicate {key}")
        self.rows.append(deepcopy(document))
        self.insert_calls += 1
        return SimpleNamespace(inserted_id=document.get("id"))

    @staticmethod
    def _apply(row, update):
        before = deepcopy(row)
        row.update(deepcopy(update.get("$set", {})))
        for key in update.get("$unset", {}):
            row.pop(key, None)
        for key, value in update.get("$inc", {}).items():
            row[key] = row.get(key, 0) + value
        return before != row

    async def update_one(self, query, update, **_options):
        for row in self.rows:
            if _matches(row, query):
                changed = self._apply(row, update)
                return SimpleNamespace(matched_count=1, modified_count=int(changed))
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def update_many(self, query, update, **_options):
        changed = 0
        for row in self.rows:
            if _matches(row, query):
                changed += int(self._apply(row, update))
        return SimpleNamespace(modified_count=changed)

    async def delete_one(self, query, **_options):
        for index, row in enumerate(self.rows):
            if _matches(row, query):
                self.rows.pop(index)
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)

    async def delete_many(self, query, **_options):
        retained = [row for row in self.rows if not _matches(row, query)]
        deleted = len(self.rows) - len(retained)
        self.rows = retained
        return SimpleNamespace(deleted_count=deleted)

    async def count_documents(self, query, **_options):
        return sum(_matches(row, query) for row in self.rows)


def quote(quote_id="quote-1", user_id="payer-user", **overrides):
    document = {
        "id": quote_id,
        "user_id": user_id,
        "mode": "automatic",
        "source_amount": Decimal128("25.00"),
        "source_currency": "INR",
        "target_amount": Decimal128("25.00"),
        "target_currency": "INR",
        "rate": Decimal128("1"),
        "effective_rate_date": None,
        "provider": "identity",
        "stale": False,
        "expires_at": now_utc() + timedelta(minutes=10),
        "payment_handoff": {
            "trip_id": "trip-1",
            "from_member_id": "payer",
            "to_member_id": "recipient",
            "current_payable": "50.00",
        },
    }
    document.update(overrides)
    return document


def attempt(status="initiated", **overrides):
    timestamp = now_utc()
    document = {
        "id": "attempt-1",
        "quote_id": "quote-1",
        "trip_id": "trip-1",
        "from_member_id": "payer",
        "to_member_id": "recipient",
        "initiating_payer_user_id": "payer-user",
        "selected_recipient_person_id": "recipient-person-1",
        "selected_recipient_user_id": "recipient-user",
        "trip_name_snapshot": "Goa Weekend",
        "from_name_snapshot": "Payer Family",
        "to_name_snapshot": "Recipient Family",
        "initiating_payer_name_snapshot": "Primary payer",
        "selected_recipient_name_snapshot": "Primary recipient",
        "selected_recipient_family_name_snapshot": "Recipient Family",
        "upi_id_snapshot": "recipient@upi",
        "upi_updated_at_snapshot": "2026-09-11T10:00:00+00:00",
        "source_amount": "25.00",
        "source_currency": "INR",
        "amount_paise": 2500,
        "currency": "INR",
        "quote_rate_snapshot": "1",
        "quote_provider_snapshot": "identity",
        "handoff_method": "copy",
        "transaction_reference": None,
        "linked_payment_id": None,
        "posted_amount": None,
        "posted_currency": "INR",
        "status": status,
        "reason": None,
        "active_key": "trip-1:payer:recipient",
        "initiated_at": timestamp.isoformat(),
        "updated_at": timestamp.isoformat(),
        "expires_at": timestamp + timedelta(hours=24),
    }
    if status not in {"initiated", "awaiting_confirmation", "needs_review"}:
        document.pop("active_key", None)
    document.update(overrides)
    return document


def install_attempt_route(
    monkeypatch,
    *,
    attempts=(),
    quotes=None,
    trip=None,
    transfers=None,
):
    trip_document = deepcopy(trip or TRIP)
    fake_db = SimpleNamespace(
        payment_attempts=MemoryCollection(attempts, unique=("id", "quote_id", "active_key")),
        exchange_rate_quotes=MemoryCollection(quotes or [quote()]),
        users=MemoryCollection([
            {
                "id": "recipient-user",
                "name": "Recipient account",
                "upi_id": "recipient@upi",
                "upi_updated_at": "2026-09-11T10:00:00+00:00",
            },
            {
                "id": "recipient-user-2",
                "name": "Second recipient account",
                "upi_id": "second@upi",
                "upi_updated_at": "2026-09-11T11:00:00+00:00",
            },
        ]),
        trips=MemoryCollection([trip_document]),
        payments=MemoryCollection((), unique=("id", "payment_attempt_id")),
        expenses=MemoryCollection(),
        settlements=MemoryCollection(),
    )
    monkeypatch.setattr(attempt_routes, "db", fake_db)
    monkeypatch.setattr(attempt_routes, "_trip_or_404", AsyncMock(return_value=deepcopy(trip_document)))
    monkeypatch.setattr(attempt_routes, "expire_payment_attempts", AsyncMock(return_value=0))
    monkeypatch.setattr(attempt_routes, "_compute_balances", AsyncMock(return_value={
        "transfers": transfers if transfers is not None else [
            {"from_member_id": "payer", "to_member_id": "recipient", "amount": 50},
        ],
    }))
    ids = iter(["attempt-new", "payment-new", "unused-id"])
    monkeypatch.setattr(attempt_routes, "gen_id", lambda: next(ids))
    monkeypatch.setattr(attempt_routes, "enqueue_notification_event", AsyncMock(return_value=True))

    async def transaction(callback):
        return await callback(None)

    monkeypatch.setattr(attempt_routes, "run_required_transaction", transaction)
    return fake_db


def create_body(quote_id="quote-1", recipient="recipient-person-1", method="copy"):
    return PaymentAttemptCreate(
        quote_id=quote_id,
        recipient_person_id=recipient,
        handoff_method=method,
    )


def test_transaction_reference_boundary_is_trimmed_nullable_and_strict():
    assert PaymentAttemptSenderPatch(
        action="report_paid", transaction_reference="  UTR-123  "
    ).transaction_reference == "UTR-123"
    assert PaymentAttemptSenderPatch(
        action="report_paid", transaction_reference="   "
    ).transaction_reference is None
    with pytest.raises(ValidationError, match="100 characters"):
        PaymentAttemptSenderPatch(action="report_paid", transaction_reference="x" * 101)
    with pytest.raises(ValidationError, match="control characters"):
        PaymentAttemptSenderPatch(action="report_paid", transaction_reference="UTR\n123")
    with pytest.raises(ValidationError, match="cannot include"):
        PaymentAttemptSenderPatch(action="cancel", transaction_reference="UTR-123")


def test_creation_persists_exact_immutable_snapshot_before_handoff(monkeypatch):
    fake_db = install_attempt_route(monkeypatch)

    result = run(attempt_routes.create_payment_attempt(
        "trip-1",
        create_body(method="google-pay"),
        user={"id": "payer-user", "name": "Payer account"},
    ))

    stored = fake_db.payment_attempts.rows[0]
    assert result["id"] == "attempt-new"
    assert result["amount_paise"] == 2500
    assert result["inr_amount"] == "25.00"
    assert result["source_amount"] == "25.00"
    assert result["quote_rate_snapshot"] == "1"
    assert result["upi_id_snapshot"] == "recipient@upi"
    assert result["upi_updated_at_snapshot"] == "2026-09-11T10:00:00+00:00"
    assert result["handoff_method"] == "google-pay"
    assert result["selected_recipient_user_id"] == "recipient-user"
    assert result["initiating_payer_user_id"] == "payer-user"
    assert stored["active_key"] == "trip-1:payer:recipient"
    assert "active_key" not in result
    assert stored["expires_at"] - now_utc() > timedelta(hours=23, minutes=59)

    # Account-profile edits after creation cannot rewrite the accepted handoff snapshot.
    fake_db.users.rows[0]["upi_id"] = "changed@upi"
    repeated = run(attempt_routes.create_payment_attempt(
        "trip-1", create_body(), user={"id": "payer-user"},
    ))
    assert repeated["id"] == result["id"]
    assert repeated["upi_id_snapshot"] == "recipient@upi"
    assert fake_db.payment_attempts.insert_calls == 1


def test_creation_revalidates_quote_pair_payable_recipient_and_upi(monkeypatch):
    expired = quote(expires_at=now_utc() - timedelta(seconds=1))
    install_attempt_route(monkeypatch, quotes=[expired])
    with pytest.raises(HTTPException) as expired_error:
        run(attempt_routes.create_payment_attempt(
            "trip-1", create_body(), user={"id": "payer-user"},
        ))
    assert expired_error.value.detail["code"] == "quote_expired"

    install_attempt_route(monkeypatch, transfers=[{
        "from_member_id": "payer", "to_member_id": "recipient", "amount": 49,
    }])
    with pytest.raises(HTTPException) as payable_error:
        run(attempt_routes.create_payment_attempt(
            "trip-1", create_body(), user={"id": "payer-user"},
        ))
    assert payable_error.value.detail["code"] == "payable_changed"

    fake_db = install_attempt_route(monkeypatch)
    fake_db.users.rows[0].pop("upi_id")
    with pytest.raises(HTTPException) as upi_error:
        run(attempt_routes.create_payment_attempt(
            "trip-1", create_body(), user={"id": "payer-user"},
        ))
    assert upi_error.value.detail["code"] == "recipient_upi_unavailable"

    install_attempt_route(monkeypatch)
    with pytest.raises(HTTPException) as recipient_error:
        run(attempt_routes.create_payment_attempt(
            "trip-1", create_body(recipient="removed-person"), user={"id": "payer-user"},
        ))
    assert recipient_error.value.detail["code"] == "recipient_changed"


def test_one_active_attempt_blocks_the_direction_across_linked_family_payers(monkeypatch):
    active = attempt(
        "awaiting_confirmation",
        transaction_reference="PRIVATE-REF",
        sender_reported_by="payer-user",
    )
    fake_db = install_attempt_route(
        monkeypatch,
        attempts=[active],
        quotes=[quote("quote-2", user_id="payer-user-2")],
    )

    result = run(attempt_routes.create_payment_attempt(
        "trip-1", create_body("quote-2"), user={"id": "payer-user-2"},
    ))

    assert result["id"] == "attempt-1"
    assert result["quote_id"] == "quote-1"
    assert result["transaction_reference"] is None
    assert fake_db.payment_attempts.rows[0]["transaction_reference"] == "PRIVATE-REF"
    assert fake_db.payment_attempts.insert_calls == 0


def test_sender_reporting_cancel_and_claim_erasure_rules(monkeypatch):
    fake_db = install_attempt_route(monkeypatch, attempts=[attempt()])
    tasks = BackgroundTasks()

    with pytest.raises(HTTPException) as unrelated:
        run(attempt_routes.update_payment_attempt_sender(
            "trip-1", "attempt-1", PaymentAttemptSenderPatch(action="cancel"), tasks,
            user={"id": "payer-user-2"},
        ))
    assert unrelated.value.status_code == 403

    reported = run(attempt_routes.update_payment_attempt_sender(
        "trip-1",
        "attempt-1",
        PaymentAttemptSenderPatch(action="report_paid", transaction_reference="  UTR 42 "),
        tasks,
        user={"id": "payer-user"},
    ))
    assert reported["status"] == "awaiting_confirmation"
    assert reported["transaction_reference"] == "UTR 42"
    assert reported["sender_reported_by"] == "payer-user"
    assert fake_db.payment_attempts.rows[0]["expires_at"] > now_utc() + timedelta(hours=23)
    notify = attempt_routes.enqueue_notification_event
    assert notify.await_args.kwargs["recipient_user_ids_override"] == ["recipient-user"]

    # A retry is idempotent and the payer cannot erase the persisted paid claim.
    repeated = run(attempt_routes.update_payment_attempt_sender(
        "trip-1", "attempt-1", PaymentAttemptSenderPatch(action="report_paid"), tasks,
        user={"id": "payer-user"},
    ))
    assert repeated["transaction_reference"] == "UTR 42"
    assert notify.await_count == 1
    with pytest.raises(HTTPException) as cannot_cancel:
        run(attempt_routes.update_payment_attempt_sender(
            "trip-1", "attempt-1", PaymentAttemptSenderPatch(action="cancel"), tasks,
            user={"id": "payer-user"},
        ))
    assert cannot_cancel.value.detail["code"] == "invalid_transition"

    fake_db.payment_attempts.rows[:] = [attempt()]
    canceled = run(attempt_routes.update_payment_attempt_sender(
        "trip-1", "attempt-1", PaymentAttemptSenderPatch(action="cancel"), tasks,
        user={"id": "payer-user"},
    ))
    assert canceled["status"] == "canceled"
    assert "active_key" not in fake_db.payment_attempts.rows[0]


@pytest.mark.parametrize("user", [
    {"id": "recipient-user-2"},
    {"id": "owner-user"},
    {"id": "admin-user"},
    {"id": "root-user", "email": SUPER_ADMIN_EMAIL, "role": "super_admin"},
])
def test_linked_family_recipients_and_reviewers_are_authorized(user, monkeypatch):
    fake_db = install_attempt_route(monkeypatch, attempts=[attempt("awaiting_confirmation")])
    result = run(attempt_routes.update_payment_attempt_recipient(
        "trip-1",
        "attempt-1",
        PaymentAttemptRecipientPatch(action="report_not_received"),
        BackgroundTasks(),
        user=user,
    ))
    assert result["status"] == "needs_review"
    assert fake_db.payment_attempts.rows[0]["recipient_not_received_by"] == user["id"]


def test_unrelated_user_cannot_review_and_list_visibility_is_scoped(monkeypatch):
    rows = [
        attempt(id="mine", initiating_payer_user_id="payer-user"),
        attempt(id="creditor", initiating_payer_user_id="someone-else"),
    ]
    install_attempt_route(monkeypatch, attempts=rows)
    with pytest.raises(HTTPException) as forbidden:
        run(attempt_routes.update_payment_attempt_recipient(
            "trip-1", "mine", PaymentAttemptRecipientPatch(action="report_not_received"),
            BackgroundTasks(), user={"id": "other-user"},
        ))
    assert forbidden.value.status_code == 403

    payer_rows = run(attempt_routes.list_payment_attempts(
        "trip-1", user={"id": "payer-user"},
    ))
    assert [row["id"] for row in payer_rows] == ["mine"]
    creditor_rows = run(attempt_routes.list_payment_attempts(
        "trip-1", user={"id": "recipient-user-2"},
    ))
    assert {row["id"] for row in creditor_rows} == {"mine", "creditor"}
    admin_rows = run(attempt_routes.list_payment_attempts(
        "trip-1", user={"id": "owner-user"},
    ))
    assert {row["id"] for row in admin_rows} == {"mine", "creditor"}


@pytest.mark.parametrize("payable, expected_status, expected_posted", [
    (50, "settled_recipient_confirmed", 25.0),
    (10, "settled_recipient_confirmed", 10.0),
    (0, "needs_review", None),
])
def test_confirmation_uses_latest_payable_and_posts_once(
    payable, expected_status, expected_posted, monkeypatch,
):
    fake_db = install_attempt_route(
        monkeypatch,
        attempts=[attempt("awaiting_confirmation")],
        transfers=[] if payable == 0 else [{
            "from_member_id": "payer", "to_member_id": "recipient", "amount": payable,
        }],
    )
    result = run(attempt_routes.update_payment_attempt_recipient(
        "trip-1",
        "attempt-1",
        PaymentAttemptRecipientPatch(action="confirm_received"),
        BackgroundTasks(),
        user={"id": "recipient-user"},
    ))

    assert result["status"] == expected_status
    assert result["posted_amount"] == expected_posted
    if expected_posted is None:
        assert fake_db.payments.rows == []
        assert fake_db.trips.rows[0]["version"] == 4
        assert result["reason"] == "no_current_payable"
        assert "active_key" in fake_db.payment_attempts.rows[0]
    else:
        assert fake_db.trips.rows[0]["version"] == 5
        assert len(fake_db.payments.rows) == 1
        payment = fake_db.payments.rows[0]
        assert payment["amount"] == expected_posted
        assert payment["source"] == "upi_recipient_confirmed"
        assert payment["payment_attempt_id"] == "attempt-1"
        assert "upi_id_snapshot" not in payment
        assert "transaction_reference" not in payment
        assert "active_key" not in fake_db.payment_attempts.rows[0]


def test_concurrent_and_repeated_confirmation_insert_one_linked_payment(monkeypatch):
    fake_db = install_attempt_route(
        monkeypatch, attempts=[attempt("awaiting_confirmation")],
    )
    lock = asyncio.Lock()

    async def serialized_transaction(callback):
        async with lock:
            return await callback(None)

    monkeypatch.setattr(attempt_routes, "run_required_transaction", serialized_transaction)

    async def scenario():
        body = PaymentAttemptRecipientPatch(action="confirm_received")
        return await asyncio.gather(
            attempt_routes.update_payment_attempt_recipient(
                "trip-1", "attempt-1", body, BackgroundTasks(),
                user={"id": "recipient-user"},
            ),
            attempt_routes.update_payment_attempt_recipient(
                "trip-1", "attempt-1", body, BackgroundTasks(),
                user={"id": "owner-user"},
            ),
        )

    first, second = run(scenario())
    assert first["linked_payment_id"] == second["linked_payment_id"]
    assert fake_db.payments.insert_calls == 1
    assert fake_db.trips.rows[0]["version"] == 5
    assert attempt_routes.enqueue_notification_event.await_count == 1


def test_transaction_unavailable_fails_closed_without_mutating_ledger(monkeypatch):
    fake_db = install_attempt_route(
        monkeypatch, attempts=[attempt("awaiting_confirmation")],
    )

    async def unavailable(_callback):
        raise TransactionUnavailableError("standalone")

    monkeypatch.setattr(attempt_routes, "run_required_transaction", unavailable)
    with pytest.raises(HTTPException) as caught:
        run(attempt_routes.update_payment_attempt_recipient(
            "trip-1",
            "attempt-1",
            PaymentAttemptRecipientPatch(action="confirm_received"),
            BackgroundTasks(),
            user={"id": "recipient-user"},
        ))

    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "payment_confirmation_unavailable"
    assert caught.value.detail["retryable"] is True
    assert fake_db.payment_attempts.rows[0]["status"] == "awaiting_confirmation"
    assert fake_db.payments.rows == []
    assert fake_db.trips.rows[0]["version"] == 4


def test_notification_failure_never_rolls_back_committed_confirmation(monkeypatch):
    fake_db = install_attempt_route(
        monkeypatch, attempts=[attempt("awaiting_confirmation")],
    )
    monkeypatch.setattr(
        attempt_routes, "enqueue_notification_event", AsyncMock(side_effect=RuntimeError("push")),
    )

    result = run(attempt_routes.update_payment_attempt_recipient(
        "trip-1",
        "attempt-1",
        PaymentAttemptRecipientPatch(action="confirm_received"),
        BackgroundTasks(),
        user={"id": "recipient-user"},
    ))

    assert result["status"] == "settled_recipient_confirmed"
    assert len(fake_db.payments.rows) == 1


def test_non_receipt_can_be_retried_or_closed_and_resets_expiry(monkeypatch):
    fake_db = install_attempt_route(
        monkeypatch, attempts=[attempt("awaiting_confirmation")],
    )
    first_expiry = fake_db.payment_attempts.rows[0]["expires_at"]
    reviewed = run(attempt_routes.update_payment_attempt_recipient(
        "trip-1",
        "attempt-1",
        PaymentAttemptRecipientPatch(action="report_not_received"),
        BackgroundTasks(),
        user={"id": "recipient-user"},
    ))
    assert reviewed["status"] == "needs_review"
    assert fake_db.payment_attempts.rows[0]["expires_at"] >= first_expiry - timedelta(seconds=2)

    closed = run(attempt_routes.update_payment_attempt_recipient(
        "trip-1",
        "attempt-1",
        PaymentAttemptRecipientPatch(action="close_review"),
        BackgroundTasks(),
        user={"id": "admin-user"},
    ))
    assert closed["status"] == "closed"
    assert closed["review_closed_by"] == "admin-user"
    assert "active_key" not in fake_db.payment_attempts.rows[0]

    fake_db.payment_attempts.rows[:] = [attempt(
        "needs_review", reason="recipient_reported_not_received",
    )]
    retried = run(attempt_routes.update_payment_attempt_recipient(
        "trip-1",
        "attempt-1",
        PaymentAttemptRecipientPatch(action="confirm_received"),
        BackgroundTasks(),
        user={"id": "recipient-user-2"},
    ))
    assert retried["status"] == "settled_recipient_confirmed"


def test_expiry_soft_closes_only_due_unresolved_attempts(monkeypatch):
    timestamp = now_utc()
    collection = MemoryCollection([
        attempt(id="due", expires_at=timestamp - timedelta(seconds=1)),
        attempt(id="fresh", expires_at=timestamp + timedelta(seconds=1)),
        attempt("settled_recipient_confirmed", id="settled", expires_at=timestamp - timedelta(days=1)),
    ])
    monkeypatch.setattr(attempt_service, "db", SimpleNamespace(payment_attempts=collection))

    changed = run(attempt_service.expire_payment_attempts("trip-1", timestamp=timestamp))

    assert changed == 1
    by_id = {row["id"]: row for row in collection.rows}
    assert by_id["due"]["status"] == "expired"
    assert by_id["due"]["reason"] == "confirmation_window_elapsed"
    assert "active_key" not in by_id["due"]
    assert by_id["fresh"]["status"] == "initiated"
    assert by_id["settled"]["status"] == "settled_recipient_confirmed"


def test_unresolved_attempt_documents_never_change_balances(monkeypatch):
    fake_db = SimpleNamespace(
        trips=MemoryCollection([TRIP]),
        expenses=MemoryCollection([{
            "id": "expense-1",
            "trip_id": "trip-1",
            "amount": 100,
            "paid_by_member_id": "recipient",
            "split_member_ids": ["payer", "recipient"],
            "split_mode": "PER_FAMILY",
        }]),
        settlements=MemoryCollection(),
        payments=MemoryCollection(),
        payment_attempts=MemoryCollection([
            attempt("awaiting_confirmation"),
            attempt("needs_review", id="review"),
            attempt("canceled", id="canceled"),
            attempt("expired", id="expired"),
        ]),
    )
    monkeypatch.setattr(balance_utils, "db", fake_db)

    result = run(balance_utils._compute_balances("trip-1"))

    assert result["transfers"] == [{
        "from_member_id": "payer", "to_member_id": "recipient", "amount": 50.0,
    }]


def test_confirmed_payment_edit_preserves_attempt_audit(monkeypatch):
    original_attempt = attempt(
        "settled_recipient_confirmed",
        linked_payment_id="payment-1",
        posted_amount=25.0,
        transaction_reference="UTR-1",
    )
    payment = {
        "id": "payment-1",
        "trip_id": "trip-1",
        "from_member_id": "payer",
        "to_member_id": "recipient",
        "amount": 25.0,
        "note": None,
        "source": "upi_recipient_confirmed",
        "payment_attempt_id": "attempt-1",
    }
    fake_db = SimpleNamespace(
        trips=MemoryCollection([TRIP]),
        payments=MemoryCollection([payment]),
        payment_attempts=MemoryCollection([original_attempt]),
    )
    monkeypatch.setattr(payment_routes, "db", fake_db)
    monkeypatch.setattr(
        payment_routes, "_payment_or_403", AsyncMock(return_value=(deepcopy(TRIP), deepcopy(payment))),
    )
    monkeypatch.setattr(payment_routes, "_compute_balances", AsyncMock(return_value={
        "transfers": [{"from_member_id": "payer", "to_member_id": "recipient", "amount": 25}],
    }))
    monkeypatch.setattr(payment_routes, "record_admin_action", AsyncMock())

    async def optional(callback, _fallback):
        return await callback(None)

    monkeypatch.setattr(payment_routes, "run_optional_transaction", optional)
    result = run(payment_routes.edit_payment(
        "trip-1", "payment-1", PaymentPatch(amount="20", note="adjusted"),
        user={"id": "recipient-user"},
    ))

    assert result["amount"] == 20.0
    assert fake_db.payments.rows[0]["note"] == "adjusted"
    assert fake_db.payment_attempts.rows[0] == original_attempt


def test_deleting_linked_payment_soft_voids_attempt_once(monkeypatch):
    stored_attempt = attempt(
        "settled_recipient_confirmed", linked_payment_id="payment-1", posted_amount=25.0,
    )
    payment = {
        "id": "payment-1",
        "trip_id": "trip-1",
        "from_member_id": "payer",
        "to_member_id": "recipient",
        "amount": 25.0,
        "payment_attempt_id": "attempt-1",
    }
    fake_db = SimpleNamespace(
        trips=MemoryCollection([TRIP]),
        payments=MemoryCollection([payment]),
        payment_attempts=MemoryCollection([stored_attempt]),
    )
    monkeypatch.setattr(payment_routes, "db", fake_db)
    monkeypatch.setattr(
        payment_routes, "_payment_or_403", AsyncMock(return_value=(deepcopy(TRIP), deepcopy(payment))),
    )
    monkeypatch.setattr(payment_routes, "record_admin_action", AsyncMock())

    async def transaction(callback):
        return await callback(None)

    monkeypatch.setattr(payment_routes, "run_required_transaction", transaction)
    result = run(payment_routes.delete_payment(
        "trip-1", "payment-1", user={"id": "recipient-user"},
    ))

    assert result == {"ok": True}
    assert fake_db.payments.rows == []
    assert fake_db.trips.rows[0]["version"] == 5
    assert fake_db.payment_attempts.rows[0]["status"] == "voided"
    assert fake_db.payment_attempts.rows[0]["linked_payment_id"] == "payment-1"
    assert fake_db.payment_attempts.rows[0]["posted_amount"] == 25.0
