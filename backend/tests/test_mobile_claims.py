import asyncio
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services import mobile_claims  # noqa: E402


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    async def to_list(self, length=None):
        return deepcopy(self.rows)


def matches(row, query):
    for key, expected in query.items():
        actual = row.get(key)
        if isinstance(expected, dict):
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            if "$in" in expected and actual not in expected["$in"]:
                return False
        elif actual != expected:
            return False
    return True


class Claims:
    def __init__(self, rows=()):
        self.rows = [deepcopy(row) for row in rows]
        self.replace_count = 0
        self.replaced_trip_ids = []
        self.delete_many_count = 0

    async def find_one(self, query, projection=None, **kwargs):
        return deepcopy(next((row for row in self.rows if matches(row, query)), None))

    def find(self, query, projection=None):
        return Cursor([row for row in self.rows if matches(row, query)])

    async def replace_one(self, query, replacement, upsert=False, **kwargs):
        self.replace_count += 1
        self.replaced_trip_ids.append(replacement["trip_id"])
        conflict = next((row for row in self.rows if (
            row["trip_id"] == replacement["trip_id"]
            and row["mobile_number"] == replacement["mobile_number"]
            and row["user_id"] != replacement["user_id"]
        )), None)
        if conflict:
            raise DuplicateKeyError("unique_mobile_per_trip")
        index = next((i for i, row in enumerate(self.rows) if matches(row, query)), None)
        if index is not None:
            self.rows[index] = deepcopy(replacement)
        elif upsert:
            self.rows.append(deepcopy(replacement))

    async def insert_one(self, document, **kwargs):
        if any(row["trip_id"] == document["trip_id"] and (
            row["user_id"] == document["user_id"]
            or row["mobile_number"] == document["mobile_number"]
        ) for row in self.rows):
            raise DuplicateKeyError("duplicate claim")
        self.rows.append(deepcopy(document))

    async def delete_one(self, query, **kwargs):
        self.rows = [row for row in self.rows if not matches(row, query)]

    async def delete_many(self, query, **kwargs):
        self.delete_many_count += 1
        self.rows = [row for row in self.rows if not matches(row, query)]


class Trips:
    def __init__(self, rows):
        self.rows = rows

    def find(self, query, projection=None):
        user_id = query.get("user_ids")
        return Cursor([
            row for row in self.rows
            if user_id is None or user_id in row.get("user_ids", [])
        ])


class Users:
    def __init__(self, row):
        self.row = deepcopy(row)

    async def update_one(self, query, update, **kwargs):
        if self.row.get("id") != query.get("id"):
            return SimpleNamespace(matched_count=0)
        self.row.update(update.get("$set", {}))
        return SimpleNamespace(matched_count=1)

    async def find_one(self, query, projection=None, **kwargs):
        return deepcopy(self.row) if self.row.get("id") == query.get("id") else None

    def find(self, query, projection=None):
        return Cursor([self.row] if matches(self.row, query) else [])


def individual(member_id, user_id, name):
    return {
        "id": member_id,
        "name": name,
        "kind": "individual",
        "family_members": [],
        "user_id": user_id,
    }


def test_claim_conflict_names_live_trip_and_member(monkeypatch):
    trip = {
        "id": "t1", "name": "Kerala Escape", "user_ids": ["u1", "u2"],
        "members": [individual("m1", "u1", "Ada"), individual("m2", "u2", "Ravi")],
    }
    claims = Claims([{
        "trip_id": "t1", "user_id": "u2", "mobile_number": "+919876543210",
        "member_id": "m2", "family_member_id": None, "member_name": "Old name",
    }])
    monkeypatch.setattr(mobile_claims, "db", SimpleNamespace(trip_mobile_claims=claims))

    with pytest.raises(HTTPException) as caught:
        asyncio.run(mobile_claims.sync_mobile_claim(trip, {
            "id": "u1", "mobile_number": "+919876543210",
        }))

    assert caught.value.status_code == 409
    assert caught.value.detail == {
        "code": "trip_mobile_conflict",
        "message": "This mobile number is already used by Ravi in Kerala Escape.",
        "trip_id": "t1",
        "trip_name": "Kerala Escape",
        "member_name": "Ravi",
        "retryable": False,
    }


def test_claim_reservation_is_idempotent_and_global_duplicates_are_allowed(monkeypatch):
    number = "+919876543210"
    first_trip = {
        "id": "t1", "name": "One", "members": [individual("m1", "u1", "Ada")],
    }
    second_trip = {
        "id": "t2", "name": "Two", "members": [individual("m2", "u2", "Ravi")],
    }
    claims = Claims()
    monkeypatch.setattr(mobile_claims, "db", SimpleNamespace(trip_mobile_claims=claims))

    first = asyncio.run(mobile_claims.sync_mobile_claim(
        first_trip, {"id": "u1", "mobile_number": number},
    ))
    second = asyncio.run(mobile_claims.sync_mobile_claim(
        second_trip, {"id": "u2", "mobile_number": number},
    ))
    again = asyncio.run(mobile_claims.sync_mobile_claim(
        first_trip, {"id": "u1", "mobile_number": number},
    ))

    assert first.changed is True
    assert second.changed is True
    assert again.changed is False
    assert claims.replace_count == 2
    assert {(row["trip_id"], row["user_id"]) for row in claims.rows} == {
        ("t1", "u1"), ("t2", "u2"),
    }


def test_standalone_profile_conflict_rolls_back_all_prior_claims(monkeypatch):
    trips = [
        {"id": "t1", "name": "One", "user_ids": ["u1"],
         "members": [individual("m1", "u1", "Ada")]},
        {"id": "t2", "name": "Two", "user_ids": ["u1", "u2"],
         "members": [individual("m1b", "u1", "Ada"), individual("m2", "u2", "Bob")]},
    ]
    old_number = "+919111111111"
    new_number = "+919876543210"
    claim_rows = [
        {"trip_id": "t1", "user_id": "u1", "mobile_number": old_number,
         "member_id": "m1", "family_member_id": None, "member_name": "Ada"},
        {"trip_id": "t2", "user_id": "u1", "mobile_number": old_number,
         "member_id": "m1b", "family_member_id": None, "member_name": "Ada"},
        {"trip_id": "t2", "user_id": "u2", "mobile_number": new_number,
         "member_id": "m2", "family_member_id": None, "member_name": "Bob"},
    ]
    user = {"id": "u1", "mobile_number": old_number, "mobile_country_code": "IN"}
    claims = Claims(claim_rows)
    users = Users(user)
    fake_db = SimpleNamespace(
        trip_mobile_claims=claims,
        trips=Trips(trips),
        users=users,
    )
    monkeypatch.setattr(mobile_claims, "db", fake_db)

    async def standalone_only(transactional, fallback):
        return await fallback()

    monkeypatch.setattr(mobile_claims, "run_optional_transaction", standalone_only)

    with pytest.raises(HTTPException) as caught:
        asyncio.run(mobile_claims.update_account_mobile(user, new_number, "IN"))

    assert caught.value.detail["code"] == "trip_mobile_conflict"
    assert users.row["mobile_number"] == old_number
    own_claims = sorted(
        (row for row in claims.rows if row["user_id"] == "u1"),
        key=lambda row: row["trip_id"],
    )
    assert [row["mobile_number"] for row in own_claims] == [old_number, old_number]


def test_removal_clears_verification_metadata_and_claim(monkeypatch):
    trip = {
        "id": "t1", "name": "One", "user_ids": ["u1"],
        "members": [individual("m1", "u1", "Ada")],
    }
    number = "+919876543210"
    claims = Claims([{
        "trip_id": "t1", "user_id": "u1", "mobile_number": number,
        "member_id": "m1", "family_member_id": None, "member_name": "Ada",
    }])
    user = {
        "id": "u1", "mobile_number": number, "mobile_country_code": "IN",
        "mobile_verified_at": "2026-01-01T00:00:00+00:00",
    }
    users = Users(user)
    monkeypatch.setattr(mobile_claims, "db", SimpleNamespace(
        trip_mobile_claims=claims, trips=Trips([trip]), users=users,
    ))

    async def standalone_only(transactional, fallback):
        return await fallback()

    monkeypatch.setattr(mobile_claims, "run_optional_transaction", standalone_only)
    updated = asyncio.run(mobile_claims.update_account_mobile(user, None, None))

    assert updated["mobile_number"] is None
    assert updated["mobile_country_code"] is None
    assert updated["mobile_verified_at"] is None
    assert claims.rows == []


def test_successful_change_updates_every_claim_and_resets_verification(monkeypatch):
    trips = [
        {"id": "t2", "name": "Two", "user_ids": ["u1"],
         "members": [individual("m2", "u1", "Ada")]},
        {"id": "t1", "name": "One", "user_ids": ["u1"],
         "members": [individual("m1", "u1", "Ada")]},
    ]
    old_number = "+919111111111"
    new_number = "+919876543210"
    claims = Claims([
        {"trip_id": trip["id"], "user_id": "u1", "mobile_number": old_number,
         "member_id": trip["members"][0]["id"], "family_member_id": None,
         "member_name": "Ada"}
        for trip in trips
    ])
    user = {
        "id": "u1", "mobile_number": old_number, "mobile_country_code": "IN",
        "mobile_verified_at": "2026-01-01T00:00:00+00:00",
    }
    users = Users(user)
    monkeypatch.setattr(mobile_claims, "db", SimpleNamespace(
        trip_mobile_claims=claims, trips=Trips(trips), users=users,
    ))

    async def standalone_only(transactional, fallback):
        return await fallback()

    monkeypatch.setattr(mobile_claims, "run_optional_transaction", standalone_only)
    updated = asyncio.run(mobile_claims.update_account_mobile(user, new_number, "IN"))

    assert updated["mobile_number"] == new_number
    assert updated["mobile_verified_at"] is None
    assert [row["trip_id"] for row in claims.rows] == ["t2", "t1"]
    assert claims.replaced_trip_ids == ["t1", "t2"]
    assert {row["mobile_number"] for row in claims.rows} == {new_number}


def test_release_helpers_remove_only_the_requested_trip_claims(monkeypatch):
    claims = Claims([
        {"trip_id": "t1", "user_id": "u1", "mobile_number": "+919111111111"},
        {"trip_id": "t1", "user_id": "u2", "mobile_number": "+919222222222"},
        {"trip_id": "t2", "user_id": "u1", "mobile_number": "+919111111111"},
    ])
    monkeypatch.setattr(mobile_claims, "db", SimpleNamespace(trip_mobile_claims=claims))

    asyncio.run(mobile_claims.release_user_claims("t1", ["u2", None, "u2"]))
    assert {(row["trip_id"], row["user_id"]) for row in claims.rows} == {
        ("t1", "u1"), ("t2", "u1"),
    }
    asyncio.run(mobile_claims.release_trip_claims("t1"))
    assert [(row["trip_id"], row["user_id"]) for row in claims.rows] == [("t2", "u1")]


def test_trip_enrichment_is_linked_only_and_family_aligned(monkeypatch):
    trip = {
        "id": "t1",
        "members": [
            individual("m1", "u1", "Ada"),
            {"id": "manual", "name": "Manual", "kind": "individual",
             "family_members": [], "user_id": None},
            {"id": "fam", "name": "Shahs", "kind": "family",
             "family_members": ["Ravi", "Mina"],
             "family_member_ids": ["fm1", "fm2"],
             "family_member_user_ids": ["u2", None]},
        ],
    }
    claims = Claims([
        {"trip_id": "t1", "user_id": "u1", "mobile_number": "+14155552671",
         "member_id": "m1", "family_member_id": None},
        {"trip_id": "t1", "user_id": "u2", "mobile_number": "+447911123456",
         "member_id": "fam", "family_member_id": "fm1"},
    ])
    monkeypatch.setattr(mobile_claims, "db", SimpleNamespace(trip_mobile_claims=claims))

    enriched = asyncio.run(mobile_claims.enrich_trip_mobile_numbers(trip))

    assert enriched["members"][0]["mobile_number"] == "+14155552671"
    assert enriched["members"][1]["mobile_number"] is None
    assert enriched["members"][2]["family_member_mobile_numbers"] == [
        "+447911123456", None,
    ]
    assert "mobile_number" not in trip["members"][0]


def test_reconciliation_repairs_missing_claims_and_removes_orphans(monkeypatch):
    trip = {
        "id": "t1", "name": "One", "user_ids": ["u1"],
        "members": [individual("m1", "u1", "Ada")],
    }
    claims = Claims([{
        "trip_id": "deleted-trip", "user_id": "u9", "mobile_number": "+919999999999",
        "member_id": "gone", "family_member_id": None,
    }])
    users = Users({
        "id": "u1", "mobile_number": "+919876543210", "mobile_country_code": "IN",
    })
    monkeypatch.setattr(mobile_claims, "db", SimpleNamespace(
        trip_mobile_claims=claims, trips=Trips([trip]), users=users,
    ))

    result = asyncio.run(mobile_claims.reconcile_mobile_claims())

    assert result == {"repaired": 2, "conflicts": 0}
    assert len(claims.rows) == 1
    assert claims.rows[0]["trip_id"] == "t1"
    assert claims.rows[0]["user_id"] == "u1"
    assert claims.rows[0]["mobile_number"] == "+919876543210"
