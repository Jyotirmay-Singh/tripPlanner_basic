import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from models.trip import TripIn, TripUpdate
from routes import trips
from utils.permissions import can_change_debt_simplification


class Trips:
    def __init__(self, doc):
        self.doc = deepcopy(doc)
        self.conflict = False

    async def find_one(self, query, *args, **kwargs):
        if "code" in query:
            return None
        return deepcopy(self.doc)

    async def insert_one(self, doc):
        self.doc = deepcopy(doc)

    async def update_one(self, query, mutation):
        match = not self.conflict
        for field in ("owner_id", "version"):
            if field in query:
                expected = query[field]
                match = match and (field not in self.doc if isinstance(expected, dict)
                                   else self.doc.get(field) == expected)
        if not match:
            return SimpleNamespace(matched_count=0, modified_count=0)
        before = deepcopy(self.doc)
        self.doc.update(mutation.get("$set", {}))
        for field, value in mutation.get("$inc", {}).items():
            self.doc[field] = self.doc.get(field, 0) + value
        return SimpleNamespace(matched_count=1, modified_count=int(self.doc != before))


@pytest.fixture
def store(monkeypatch):
    collection = Trips({"id": "t1", "name": "Goa", "currency": "INR", "owner_id": "owner",
                        "admin_ids": ["owner", "admin"], "user_ids": ["owner", "admin", "member"],
                        "members": [], "version": 4})
    monkeypatch.setattr(trips, "db", SimpleNamespace(trips=collection))
    async def read(*args):
        return deepcopy(collection.doc)
    monkeypatch.setattr(trips, "_trip_admin_or_403", read)
    monkeypatch.setattr(trips, "_trip_or_404", read)
    monkeypatch.setattr(trips, "record_admin_action", AsyncMock())
    monkeypatch.setattr(trips, "record_money_normalizations", AsyncMock())
    monkeypatch.setattr(trips, "sync_mobile_claim", AsyncMock())
    async def enrich(trip):
        return trip
    monkeypatch.setattr(trips, "enrich_trip_mobile_numbers", enrich)
    return collection


def test_new_trips_are_enabled_and_legacy_reads_default_to_enabled(store):
    legacy = asyncio.run(trips.get_trip("t1", {"id": "owner"}))
    assert legacy["simplify_debts"] is True
    user = {"id": "owner", "name": "Owner", "email": "owner@gmail.com"}
    new = asyncio.run(trips.create_trip(TripIn(name="Goa"), user))
    assert new["simplify_debts"] is True
    assert store.doc["simplify_debts"] is True


def test_owner_can_disable_reenable_and_round_trip_false_without_changing_expenses(store):
    saved = asyncio.run(trips.update_trip("t1", TripUpdate(simplify_debts=False), {"id": "owner"}))
    assert saved["simplify_debts"] is False
    assert saved["version"] == 5
    assert asyncio.run(trips.get_trip("t1", {"id": "owner"}))["simplify_debts"] is False
    same = asyncio.run(trips.update_trip("t1", TripUpdate(simplify_debts=False), {"id": "owner"}))
    assert same["version"] == 5
    enabled = asyncio.run(trips.update_trip("t1", TripUpdate(simplify_debts=True), {"id": "owner"}))
    assert enabled["version"] == 6


@pytest.mark.parametrize("role", ["admin", "member", "outsider"])
def test_nonowners_cannot_submit_even_an_unchanged_setting(store, role):
    with pytest.raises(HTTPException) as error:
        asyncio.run(trips.update_trip("t1", TripUpdate(simplify_debts=True), {"id": role}))
    assert error.value.status_code == 403
    assert "simplify_debts" not in store.doc


def test_admin_can_edit_other_settings_without_changing_mode(store):
    store.doc["simplify_debts"] = False
    saved = asyncio.run(trips.update_trip("t1", TripUpdate(name="New name"), {"id": "admin"}))
    assert saved["simplify_debts"] is False
    assert saved["name"] == "New name"
    assert saved["version"] == 4


def test_application_admin_retains_existing_override(store):
    from config import SUPER_ADMIN_EMAIL
    saved = asyncio.run(trips.update_trip("t1", TripUpdate(simplify_debts=False),
                                         {"id": "operator", "email": SUPER_ADMIN_EMAIL, "role": "super_admin"}))
    assert saved["simplify_debts"] is False


def test_concurrent_balance_change_rejects_mode_update(store):
    store.conflict = True
    with pytest.raises(HTTPException) as error:
        asyncio.run(trips.update_trip("t1", TripUpdate(simplify_debts=False), {"id": "owner"}))
    assert error.value.status_code == 409
    assert "simplify_debts" not in store.doc


def test_unchanged_mode_save_cannot_overwrite_a_concurrent_switch(store, monkeypatch):
    store.doc["simplify_debts"] = False
    update_one = store.update_one

    async def concurrent_switch(query, mutation):
        store.doc.update(simplify_debts=True, version=5)
        return await update_one(query, mutation)

    monkeypatch.setattr(store, "update_one", concurrent_switch)
    with pytest.raises(HTTPException) as error:
        asyncio.run(trips.update_trip("t1", TripUpdate(simplify_debts=False), {"id": "owner"}))
    assert error.value.status_code == 409
    assert store.doc["simplify_debts"] is True
    assert store.doc["version"] == 5


def test_legacy_version_is_initialized_without_overwriting_other_fields(store):
    store.doc.pop("version")
    saved = asyncio.run(trips.update_trip("t1", TripUpdate(simplify_debts=False), {"id": "owner"}))
    assert saved["version"] == 1
    assert saved["currency"] == "INR"


@pytest.mark.parametrize("invalid", [None, "false", "true", 0, 1])
def test_setting_requires_a_real_boolean(invalid):
    with pytest.raises(ValidationError):
        TripUpdate(simplify_debts=invalid)


def test_omitting_the_field_never_turns_it_back_on():
    assert "simplify_debts" not in TripUpdate(name="Trip").model_dump(exclude_unset=True)
    trip = {"owner_id": "o", "admin_ids": ["a"], "user_ids": ["a", "m"]}
    assert can_change_debt_simplification(trip, {"id": "o"})
    assert not can_change_debt_simplification(trip, {"id": "a"})
    assert not can_change_debt_simplification(trip, {"id": "m"})
