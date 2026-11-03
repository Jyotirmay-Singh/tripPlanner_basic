import asyncio
from datetime import timedelta
from starlette.requests import Request
from fastapi import HTTPException
import pytest
import utils.email_limits as limits
from email_fakes import FakeDB


def test_ip_limits_count_requests_and_return_retry_after(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(limits, 'db', db)
    request = Request({'type': 'http', 'client': ('192.0.2.1', 1234), 'headers': []})
    async def scenario():
        for _ in range(10): await limits.enforce_email_ip_limit(request)
        with pytest.raises(HTTPException) as rejected:
            await limits.enforce_email_ip_limit(request)
        assert rejected.value.status_code == 429
        assert 1 <= int(rejected.value.headers['Retry-After']) <= 60
    asyncio.run(scenario())
    assert '192.0.2.1' not in repr(db.auth_rate_limits.docs)


def test_cooldown_hourly_limit_and_restart_persistence(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(limits, 'db', db)
    now = limits._now()
    async def scenario():
        assert await limits.claim_email_send('User@gmail.com', 'verify_email') == 0
        assert await limits.claim_email_send('user@gmail.com', 'verify_email') > 0
        for i in range(1, 5):
            monkeypatch.setattr(limits, '_now', lambda i=i: now + timedelta(seconds=i * 61))
            assert await limits.claim_email_send('user@gmail.com', 'verify_email') == 0
        monkeypatch.setattr(limits, '_now', lambda: now + timedelta(minutes=8))
        assert await limits.claim_email_send('user@gmail.com', 'verify_email') > 3000
        assert await limits.claim_email_send('user@gmail.com', 'reset_password') == 0
        monkeypatch.setattr(limits, '_now', lambda: now + timedelta(hours=1, seconds=1))
        assert await limits.claim_email_send('user@gmail.com', 'verify_email') == 0
    asyncio.run(scenario())
    assert 'user@gmail.com' not in repr(db.auth_rate_limits.docs)
