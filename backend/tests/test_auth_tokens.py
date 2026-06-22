# Unit tests for utils/auth_tokens.py — the hashed, typed, single-use, expiring email-token
# store. Driven against a tiny in-memory fake collection (no real Mongo / event-loop binding),
# so every branch runs deterministically and offline.
import asyncio
import sys
from datetime import timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import utils.auth_tokens as at  # noqa: E402
from utils.auth_tokens import (  # noqa: E402
    VERIFY_EMAIL, RESET_PASSWORD, hash_token,
)


# --------------------------------------------------------------------------- #
# Minimal async in-memory replacement for db["auth_tokens"]
# --------------------------------------------------------------------------- #
class FakeCollection:
    def __init__(self):
        self.docs = []
        self._id = 0

    @staticmethod
    def _match(doc, flt):
        return all(doc.get(k) == v for k, v in flt.items())

    async def insert_one(self, doc):
        self._id += 1
        doc["_id"] = self._id
        self.docs.append(doc)

    async def update_many(self, flt, update):
        for d in self.docs:
            if self._match(d, flt):
                d.update(update["$set"])

    async def update_one(self, flt, update):
        for d in self.docs:
            if self._match(d, flt):
                d.update(update["$set"])
                return

    async def find_one(self, flt, sort=None):
        matches = [d for d in self.docs if self._match(d, flt)]
        if sort:
            key, direction = sort[0]
            matches.sort(key=lambda d: d[key], reverse=(direction == -1))
        return matches[0] if matches else None


class FakeDB:
    def __init__(self):
        self.col = FakeCollection()

    def __getitem__(self, name):
        return self.col


@pytest.fixture
def fake_db(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(at, "db", db)
    return db


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
def test_hash_is_deterministic_and_distinct():
    assert hash_token("abc") == hash_token("abc")
    assert hash_token("abc") != hash_token("abd")
    assert len(hash_token("abc")) == 64  # sha256 hex


def test_issue_stores_only_the_hash_not_the_raw(fake_db):
    raw = run(at.issue_token("u1", VERIFY_EMAIL, timedelta(hours=1)))
    stored = fake_db.col.docs[0]
    assert stored["token_hash"] == hash_token(raw)
    assert raw not in (stored.get("token_hash"),)  # the raw value is never persisted
    assert all(raw != v for v in stored.values())
    assert stored["type"] == VERIFY_EMAIL
    assert stored["used"] is False


def test_consume_valid_returns_user_and_marks_used(fake_db):
    raw = run(at.issue_token("u1", VERIFY_EMAIL, timedelta(hours=1)))
    assert run(at.consume_token(raw, VERIFY_EMAIL)) == "u1"
    # single-use: a second consume fails
    assert run(at.consume_token(raw, VERIFY_EMAIL)) is None
    assert fake_db.col.docs[0]["used"] is True


def test_consume_wrong_type_rejected(fake_db):
    raw = run(at.issue_token("u1", VERIFY_EMAIL, timedelta(hours=1)))
    # a verify token must not be spendable as a reset token
    assert run(at.consume_token(raw, RESET_PASSWORD)) is None


def test_consume_expired_rejected(fake_db):
    raw = run(at.issue_token("u1", RESET_PASSWORD, timedelta(seconds=-1)))
    assert run(at.consume_token(raw, RESET_PASSWORD)) is None


def test_consume_empty_or_unknown_returns_none(fake_db):
    assert run(at.consume_token("", VERIFY_EMAIL)) is None
    assert run(at.consume_token("never-issued", VERIFY_EMAIL)) is None


def test_reissue_invalidates_previous_token_of_same_type(fake_db):
    old = run(at.issue_token("u1", VERIFY_EMAIL, timedelta(hours=1)))
    new = run(at.issue_token("u1", VERIFY_EMAIL, timedelta(hours=1)))
    assert run(at.consume_token(old, VERIFY_EMAIL)) is None   # old invalidated
    assert run(at.consume_token(new, VERIFY_EMAIL)) == "u1"   # new still valid


def test_reissue_does_not_touch_other_type_or_user(fake_db):
    reset_raw = run(at.issue_token("u1", RESET_PASSWORD, timedelta(hours=1)))
    other_user = run(at.issue_token("u2", VERIFY_EMAIL, timedelta(hours=1)))
    run(at.issue_token("u1", VERIFY_EMAIL, timedelta(hours=1)))  # reissue u1 verify
    assert run(at.consume_token(reset_raw, RESET_PASSWORD)) == "u1"   # other type untouched
    assert run(at.consume_token(other_user, VERIFY_EMAIL)) == "u2"    # other user untouched


def test_seconds_since_last(fake_db):
    assert run(at.seconds_since_last("u1", VERIFY_EMAIL)) is None  # none issued yet
    run(at.issue_token("u1", VERIFY_EMAIL, timedelta(hours=1)))
    elapsed = run(at.seconds_since_last("u1", VERIFY_EMAIL))
    assert elapsed is not None and 0 <= elapsed < 5
