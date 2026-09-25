import asyncio
from copy import deepcopy
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException
from pymongo.errors import DuplicateKeyError

from models.payment import PaymentCreate
from routes import meta, payments
from services import payment_idempotency
from services.ledger_transactions import TransactionUnavailableError


class MemoryStore:
    def __init__(self):
        self.trip = {
            "id": "t1", "currency": "INR", "version": 0,
            "owner_id": "u3", "admin_ids": [], "user_ids": ["u1", "u2", "u3"],
            "members": [
                {"id": "m1", "kind": "individual", "name": "Receiver", "user_id": "u1"},
                {"id": "m2", "kind": "individual", "name": "Payer", "user_id": "u2"},
            ],
        }
        self.receipts = []
        self.payments = []
        self.audits = []
        self.normalizations = []
        self.notifications = []
        self.active = True
        self.lock = asyncio.Lock()
        self.db = SimpleNamespace(
            trips=SimpleNamespace(find_one=self.find_trip, update_one=self.update_trip),
            payment_mutation_receipts=SimpleNamespace(
                find_one=self.find_receipt, insert_one=self.insert_receipt,
            ),
            payments=SimpleNamespace(insert_one=self.insert_payment),
        )

    async def find_trip(self, _query, _projection, *, session):
        return deepcopy(self.trip)

    async def update_trip(self, query, _update, *, session):
        if self.trip is None or self.trip["version"] != query["version"]:
            return SimpleNamespace(modified_count=0)
        self.trip["version"] += 1
        return SimpleNamespace(modified_count=1)

    async def find_receipt(self, key, *, session=None):
        return next(
            (deepcopy(row) for row in self.receipts if all(row.get(k) == v for k, v in key.items())),
            None,
        )

    async def insert_receipt(self, row, *, session):
        key = payment_idempotency.receipt_key(row["actor_user_id"], row["client_mutation_id"])
        if await self.find_receipt(key):
            raise DuplicateKeyError("duplicate payment mutation")
        self.receipts.append(deepcopy(row))

    async def insert_payment(self, row, *, session):
        self.payments.append(deepcopy(row))

    async def balances(self, _trip_id, *, diagnostic, session):
        payable = 100 - sum(row["amount"] for row in self.payments)
        return {"transfers": [{
            "from_member_id": "m2", "to_member_id": "m1", "amount": payable,
        }] if self.active and payable > 0 else []}

    async def transact(self, callback):
        async with self.lock:
            snapshot = deepcopy((
                self.trip, self.receipts, self.payments, self.audits,
                self.normalizations, self.notifications,
            ))
            try:
                return await callback(object())
            except Exception:
                (self.trip, self.receipts, self.payments, self.audits,
                 self.normalizations, self.notifications) = snapshot
                raise


def setup(monkeypatch):
    store = MemoryStore()
    monkeypatch.setattr(payments, "db", store.db)
    monkeypatch.setattr(payments, "payment_protocol_ready", lambda: True)
    monkeypatch.setattr(payments, "run_required_transaction", store.transact)
    monkeypatch.setattr(payments, "_compute_balances", store.balances)

    async def audit(*_args, **kwargs):
        assert kwargs["session"] is not None
        store.audits.append(kwargs["resource_id"])

    async def normalization(changes, **kwargs):
        assert kwargs["session"] is not None
        if any(changes):
            store.normalizations.append(kwargs["resource_id"])

    async def notification(**kwargs):
        assert kwargs["session"] is not None
        store.notifications.append(kwargs["source_id"])

    monkeypatch.setattr(payments, "record_admin_action", audit)
    monkeypatch.setattr(payments, "record_money_normalizations", normalization)
    monkeypatch.setattr(payments, "enqueue_notification_event", notification)
    return store


def body(*, mutation_id=None, **overrides):
    fields = {
        "from_member_id": "m2", "to_member_id": "m1", "amount": 60,
        "note": "received", "client_mutation_id": mutation_id or str(uuid4()),
        "expected_payable": 100, "expected_currency": "INR",
    }
    fields.update(overrides)
    return PaymentCreate(**fields)


async def create(request, *, user_id="u1", trip_id="t1", tasks=None):
    return await payments.record_payment(
        trip_id, request, tasks or BackgroundTasks(), user={"id": user_id},
    )


def test_concurrent_same_id_replays_once_and_changed_intent_conflicts(monkeypatch):
    store = setup(monkeypatch)
    request = body()

    async def exercise():
        first_tasks, second_tasks = BackgroundTasks(), BackgroundTasks()
        first, second = await asyncio.gather(
            create(request, tasks=first_tasks), create(request, tasks=second_tasks),
        )
        assert first == second
        assert len(first_tasks.tasks) + len(second_tasks.tasks) == 1
        with pytest.raises(HTTPException) as error:
            await create(body(mutation_id=str(request.client_mutation_id), note="different"))
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "client_mutation_conflict"

    asyncio.run(exercise())
    assert len(store.payments) == len(store.receipts) == 1
    assert len(store.audits) == len(store.notifications) == 1
    assert store.trip["version"] == 1


def test_concurrent_recorders_with_different_ids_cannot_use_stale_payable(monkeypatch):
    store = setup(monkeypatch)

    async def exercise():
        results = await asyncio.gather(create(body()), create(body()), return_exceptions=True)
        assert sum(isinstance(result, dict) for result in results) == 1
        errors = [result for result in results if isinstance(result, HTTPException)]
        assert len(errors) == 1
        assert errors[0].status_code == 409
        assert errors[0].detail["code"] == "payment_recommendation_changed"

    asyncio.run(exercise())
    assert len(store.payments) == len(store.receipts) == len(store.notifications) == 1
    assert asyncio.run(store.balances("t1", diagnostic=False, session=None))["transfers"][0]["amount"] == 40


def test_lost_response_and_deleted_payment_and_trip_replay(monkeypatch):
    store = setup(monkeypatch)
    request = body()
    first = asyncio.run(create(request))
    store.payments.clear()
    store.trip = None
    replay_tasks = BackgroundTasks()
    assert asyncio.run(create(request, tasks=replay_tasks)) == first
    assert replay_tasks.tasks == []
    assert store.payments == []
    assert len(store.receipts) == len(store.audits) == len(store.notifications) == 1


def test_equivalent_decimal_spellings_replay_and_other_trip_conflicts(monkeypatch):
    store = setup(monkeypatch)
    request = body(amount=Decimal("60.00"), expected_payable=Decimal("100.0"))
    accepted = asyncio.run(create(request))
    equivalent = body(mutation_id=str(request.client_mutation_id), amount=60, expected_payable=100)
    assert asyncio.run(create(equivalent)) == accepted
    with pytest.raises(HTTPException) as wrong_trip:
        asyncio.run(create(equivalent, trip_id="another-trip"))
    assert wrong_trip.value.detail["code"] == "client_mutation_conflict"
    assert len(store.payments) == 1


def test_stale_pair_payable_currency_and_overpay_leave_no_effects(monkeypatch):
    store = setup(monkeypatch)
    store.active = False
    with pytest.raises(HTTPException) as inactive:
        asyncio.run(create(body()))
    assert inactive.value.detail["code"] == "payment_recommendation_changed"
    store.active = True
    with pytest.raises(HTTPException) as stale:
        asyncio.run(create(body(expected_payable=90)))
    assert stale.value.detail["code"] == "payment_recommendation_changed"
    with pytest.raises(HTTPException) as currency:
        asyncio.run(create(body(expected_currency="USD")))
    assert currency.value.detail["code"] == "payment_recommendation_changed"
    with pytest.raises(HTTPException) as excessive:
        asyncio.run(create(body(amount=Decimal("100.6"))))
    assert excessive.value.status_code == 400
    assert store.receipts == store.payments == store.notifications == []
    assert store.trip["version"] == 0


def test_receiver_family_admin_and_revoked_rights(monkeypatch):
    store = setup(monkeypatch)
    store.trip["members"][0].update(
        kind="family", family_members=["A", "B"],
        family_member_user_ids=["u1", "u4"],
    )
    assert asyncio.run(create(body()))["recorded_by"] == "u1"
    store.payments.clear()
    store.receipts.clear()
    store.trip["members"][0]["family_member_user_ids"] = ["u4"]
    with pytest.raises(HTTPException) as revoked:
        asyncio.run(create(body()))
    assert revoked.value.status_code == 403
    with pytest.raises(HTTPException) as payer:
        asyncio.run(create(body(), user_id="u2"))
    assert payer.value.status_code == 403
    assert asyncio.run(create(body(), user_id="u3"))["recorded_by"] == "u3"


def test_failed_side_effect_rolls_back_and_same_id_can_retry(monkeypatch):
    store = setup(monkeypatch)
    request = body(amount=Decimal("10.6"))

    async def failed_notification(**_kwargs):
        raise RuntimeError("outbox unavailable")

    monkeypatch.setattr(payments, "enqueue_notification_event", failed_notification)
    with pytest.raises(RuntimeError):
        asyncio.run(create(request))
    assert store.receipts == store.payments == store.audits == store.normalizations == []
    assert store.trip["version"] == 0

    async def notification(**kwargs):
        store.notifications.append(kwargs["source_id"])

    monkeypatch.setattr(payments, "enqueue_notification_event", notification)
    saved = asyncio.run(create(request))
    assert saved["amount"] == 11
    assert len(store.receipts) == len(store.payments) == len(store.normalizations) == 1


def test_trip_version_guard_and_non_inr_whole_unit_policy(monkeypatch):
    store = setup(monkeypatch)
    store.trip["currency"] = "KWD"
    original_update = store.db.trips.update_one

    async def stale_guard(_query, _update, *, session):
        return SimpleNamespace(modified_count=0)

    store.db.trips.update_one = stale_guard
    request = body(amount=Decimal("10.6"), expected_currency="KWD")
    with pytest.raises(HTTPException) as changed:
        asyncio.run(create(request))
    assert changed.value.status_code == 409
    assert store.receipts == store.payments == []

    store.db.trips.update_one = original_update
    saved = asyncio.run(create(request))
    assert saved["currency"] == "KWD"
    assert saved["amount"] == 11
    assert saved["settlement_increment"] == "1"


def test_unsupported_transactions_fail_closed_while_legacy_model_stays_valid(monkeypatch):
    store = setup(monkeypatch)
    monkeypatch.setattr(payments, "payment_protocol_ready", lambda: False)
    with pytest.raises(HTTPException) as unavailable:
        asyncio.run(create(body()))
    assert unavailable.value.status_code == 503
    assert unavailable.value.detail["code"] == "payment_retry_unavailable"
    assert store.receipts == store.payments == []
    assert PaymentCreate(from_member_id="m2", to_member_id="m1", amount=10).client_mutation_id is None
    monkeypatch.setattr(meta, "payment_protocol_ready", lambda: False)
    assert asyncio.run(meta.get_config())["payment_create_protocol_version"] == 0

    async def unavailable_transaction(_callback):
        raise TransactionUnavailableError("standalone")

    monkeypatch.setattr(payments, "payment_protocol_ready", lambda: True)
    monkeypatch.setattr(payments, "run_required_transaction", unavailable_transaction)
    with pytest.raises(HTTPException) as runtime:
        asyncio.run(create(body()))
    assert runtime.value.status_code == 503
    assert store.receipts == store.payments == []


def test_payment_protocol_probe_and_required_request_fields(monkeypatch):
    with pytest.raises(ValueError):
        PaymentCreate(
            from_member_id="m2", to_member_id="m1", amount=10,
            client_mutation_id=str(uuid4()),
        )
    insert = []
    delete = []

    async def log_insert(_row, *, session):
        insert.append(session)

    async def log_delete(_row, *, session):
        delete.append(session)

    monkeypatch.setattr(payment_idempotency, "db", SimpleNamespace(
        command=lambda *_args: asyncio.sleep(0),
        payment_mutation_receipts=SimpleNamespace(insert_one=log_insert, delete_one=log_delete),
    ))

    async def unsupported(_callback):
        raise TransactionUnavailableError("standalone")

    monkeypatch.setattr(payment_idempotency, "run_required_transaction", unsupported)
    assert asyncio.run(payment_idempotency.verify_payment_transactions()) is False
    assert payment_idempotency.payment_protocol_ready() is False

    async def supported(callback):
        return await callback(object())

    monkeypatch.setattr(payment_idempotency, "run_required_transaction", supported)
    assert asyncio.run(payment_idempotency.verify_payment_transactions()) is True
    monkeypatch.setattr(meta, "payment_protocol_ready", payment_idempotency.payment_protocol_ready)
    assert asyncio.run(meta.get_config())["payment_create_protocol_version"] == 1
    assert len(insert) == len(delete) == 1
    payment_idempotency.disable_payment_protocol()
