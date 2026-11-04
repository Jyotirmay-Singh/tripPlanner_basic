"""Opt-in tests against an isolated LOCAL replica set; never use application credentials."""
import asyncio
import os
from datetime import timedelta
from uuid import uuid4

import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import OperationFailure

import utils.auth_tokens as tokens
import utils.email_limits as limits
import services.ledger_transactions as transactions
from services.email_security_migration import migrate_email_security

TEST_URL = os.environ.get('EMAIL_AUTH_TEST_MONGO_URL', '')
pytestmark = pytest.mark.skipif(not TEST_URL, reason='Set EMAIL_AUTH_TEST_MONGO_URL to a local replica set')


def test_real_transactions_concurrency_rollback_migration_and_limits(monkeypatch):
    assert TEST_URL.startswith('mongodb://127.0.0.1:27019/'), 'Only the isolated local test port is allowed'
    async def scenario():
        client = AsyncIOMotorClient(TEST_URL, serverSelectionTimeoutMS=5000)
        name = 'email_auth_test_' + uuid4().hex
        assert name.startswith('email_auth_test_')
        db = client[name]
        monkeypatch.setattr(tokens, 'db', db)
        monkeypatch.setattr(limits, 'db', db)
        monkeypatch.setattr(transactions, 'client', client)
        try:
            await db.users.insert_one({'id': 'u1', 'email': 'realtest@gmail.com', 'session_version': 0,
                                       'email_verified': True})
            await db.auth_tokens.create_index('token_hash', unique=True)
            await migrate_email_security(db)
            assert not (await db.users.find_one({'id': 'u1'}))['email_verified']
            verification = await tokens.issue_token('u1', tokens.VERIFY_EMAIL)
            assert await tokens.consume_token(verification, tokens.VERIFY_EMAIL) == 'u1'
            raw = await tokens.issue_token('u1', tokens.RESET_PASSWORD)
            results = await asyncio.gather(*[
                tokens.consume_token(raw, tokens.RESET_PASSWORD, user_update={'$inc': {'session_version': 1}})
                for _ in range(12)
            ], return_exceptions=True)
            assert results.count('u1') == 1
            assert sum(isinstance(r, tokens.AuthTokenError) for r in results) == 11
            assert (await db.users.find_one({'id': 'u1'}))['session_version'] == 1
            rollback = await tokens.issue_token('u1', tokens.RESET_PASSWORD)
            with pytest.raises(OperationFailure):
                await tokens.consume_token(rollback, tokens.RESET_PASSWORD, user_update={'$set': {'_id': 'immutable'}})
            assert not (await db.auth_tokens.find_one({'token_hash': tokens.hash_token(rollback)}))['used']
            assert await tokens.consume_token(rollback, tokens.RESET_PASSWORD) == 'u1'
            await asyncio.gather(*[tokens.issue_token('u1', tokens.VERIFY_EMAIL) for _ in range(8)])
            assert await db.auth_tokens.count_documents({'type': tokens.VERIFY_EMAIL, 'used': False}) == 1
            reservations = await asyncio.gather(*[limits.claim_email_send('rate@gmail.com', tokens.VERIFY_EMAIL) for _ in range(12)])
            assert reservations.count(0) == 1
            assert all(value >= 1 for value in reservations if value)
            clock = limits._now()
            for i in range(1, 5):
                monkeypatch.setattr(limits, '_now', lambda i=i: clock + timedelta(seconds=61 * i))
                assert await limits.claim_email_send('rate@gmail.com', tokens.VERIFY_EMAIL) == 0
            monkeypatch.setattr(limits, '_now', lambda: clock + timedelta(minutes=8))
            assert await limits.claim_email_send('rate@gmail.com', tokens.VERIFY_EMAIL) > 3000
        finally:
            await client.drop_database(name)
            client.close()
    asyncio.run(scenario())
