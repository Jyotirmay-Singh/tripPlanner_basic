import asyncio
from datetime import datetime, timedelta, timezone

import pytest

import utils.auth_tokens as at
from email_fakes import FakeDB


@pytest.fixture
def fake_db(monkeypatch):
    db = FakeDB()
    db.users.docs.append({'_id': 1, 'id': 'u1', 'email': 'one@gmail.com', 'session_version': 0,
                          'email_verified': True, 'email_verified_for': 'one@gmail.com',
                          'email_verified_at': datetime.now(timezone.utc), 'email_verification_method': 'email_link'})
    monkeypatch.setattr(at, 'db', db)
    monkeypatch.setattr(at, 'run_required_transaction', db.transaction)
    return db


def run(coro):
    return asyncio.run(coro)


def test_hash_and_ttl_and_purpose(fake_db):
    raw = run(at.issue_token('u1', at.VERIFY_EMAIL, timedelta(hours=24)))
    rec = fake_db.auth_tokens.docs[0]
    assert rec['token_hash'] == at.hash_token(raw)
    assert raw not in repr(fake_db.auth_tokens.docs)
    assert rec['email'] == 'one@gmail.com'
    assert rec['expires_at'] - rec['created_at'] == timedelta(minutes=15)
    with pytest.raises(at.AuthTokenError, match='invalid'):
        run(at.consume_token(raw, at.RESET_PASSWORD))
    assert not rec['used']


def test_consume_proves_exact_email_and_is_single_use(fake_db):
    raw = run(at.issue_token('u1', at.VERIFY_EMAIL))
    assert run(at.consume_token(raw, at.VERIFY_EMAIL)) == 'u1'
    user = fake_db.users.docs[0]
    assert user['email_verified'] is True
    assert user['email_verified_for'] == user['email']
    assert user['email_verified_at']
    with pytest.raises(at.AuthTokenError, match='already been used'):
        run(at.consume_token(raw, at.VERIFY_EMAIL))


@pytest.mark.parametrize('raw', ['', 'unknown', 'x' * 513])
def test_bad_tokens_fail_without_writes(fake_db, raw):
    with pytest.raises(at.AuthTokenError):
        run(at.consume_token(raw, at.VERIFY_EMAIL))
    assert not fake_db.auth_tokens.docs


def test_expired_including_exact_boundary(fake_db, monkeypatch):
    raw = run(at.issue_token('u1', at.VERIFY_EMAIL))
    boundary = fake_db.auth_tokens.docs[0]['expires_at']
    monkeypatch.setattr(at, '_now', lambda: boundary)
    with pytest.raises(at.AuthTokenError, match='expired'):
        run(at.consume_token(raw, at.VERIFY_EMAIL))
    assert not fake_db.auth_tokens.docs[0]['used']


def test_email_changed_rejects_and_rolls_back_consumption(fake_db):
    raw = run(at.issue_token('u1', at.VERIFY_EMAIL))
    fake_db.users.docs[0]['email'] = 'changed@gmail.com'
    with pytest.raises(at.AuthTokenError):
        run(at.consume_token(raw, at.VERIFY_EMAIL))
    assert not fake_db.auth_tokens.docs[0]['used']
    assert fake_db.users.docs[0]['email_verified_for'] == 'one@gmail.com'
    assert not at.email_is_verified(fake_db.users.docs[0])


def test_reissue_replaces_only_same_purpose(fake_db):
    old = run(at.issue_token('u1', at.VERIFY_EMAIL))
    reset = run(at.issue_token('u1', at.RESET_PASSWORD))
    new = run(at.issue_token('u1', at.VERIFY_EMAIL))
    with pytest.raises(at.AuthTokenError):
        run(at.consume_token(old, at.VERIFY_EMAIL))
    assert run(at.consume_token(new, at.VERIFY_EMAIL)) == 'u1'
    assert run(at.consume_token(reset, at.RESET_PASSWORD)) == 'u1'


def test_database_error_rolls_back_token_claim(fake_db, monkeypatch):
    raw = run(at.issue_token('u1', at.RESET_PASSWORD))
    original = fake_db.users.update_one
    async def fail(*args, **kwargs):
        raise RuntimeError('simulated database outage')
    monkeypatch.setattr(fake_db.users, 'update_one', fail)
    with pytest.raises(RuntimeError):
        run(at.consume_token(raw, at.RESET_PASSWORD, user_update={'$set': {'password_hash': 'new'}}))
    assert not fake_db.auth_tokens.docs[0]['used']
    monkeypatch.setattr(fake_db.users, 'update_one', original)
    assert run(at.consume_token(raw, at.RESET_PASSWORD)) == 'u1'


def test_simultaneous_consumption_has_one_winner(fake_db):
    async def scenario():
        raw = await at.issue_token('u1', at.RESET_PASSWORD)
        return await asyncio.gather(*[
            at.consume_token(raw, at.RESET_PASSWORD, user_update={'$inc': {'session_version': 1}})
            for _ in range(8)
        ], return_exceptions=True)
    results = run(scenario())
    assert results.count('u1') == 1
    assert sum(isinstance(result, at.AuthTokenError) for result in results) == 7
    assert fake_db.users.docs[0]['session_version'] == 1


def test_simultaneous_issuance_leaves_one_active_token(fake_db):
    async def scenario():
        return await asyncio.gather(*[at.issue_token('u1', at.VERIFY_EMAIL) for _ in range(5)])
    raws = run(scenario())
    assert len(set(raws)) == 5
    assert sum(not row['used'] for row in fake_db.auth_tokens.docs) == 1
    assert fake_db.users.docs[0]['auth_token_versions'][at.VERIFY_EMAIL] == 5
