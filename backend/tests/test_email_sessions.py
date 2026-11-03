import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import jwt
import pytest
from fastapi import HTTPException

from config import JWT_SECRET, JWT_ALGORITHM
from services.chat_realtime import ChatConnectionManager
from utils.security import decode_token, validate_session


def test_legacy_tokens_work_until_reset_but_wrong_type_never_works():
    token = jwt.encode({'sub': 'u1', 'email': 'u@gmail.com', 'type': 'access',
                        'exp': datetime.now(timezone.utc) + timedelta(minutes=5)}, JWT_SECRET, algorithm=JWT_ALGORITHM)
    payload = decode_token(token)
    validate_session(payload, {'session_version': 0})
    with pytest.raises(HTTPException): validate_session(payload, {'session_version': 1})
    wrong = jwt.encode({'sub': 'u1', 'type': 'other'}, JWT_SECRET, algorithm=JWT_ALGORITHM)
    with pytest.raises(HTTPException): decode_token(wrong)


def test_reset_closes_all_existing_account_sockets_including_privileged():
    class Socket:
        def __init__(self): self.close = AsyncMock()
    first, admin, other = Socket(), Socket(), Socket()
    manager = ChatConnectionManager()
    async def scenario():
        await manager.connect('trip1', 'u1', first)
        await manager.connect('trip2', 'u1', admin, privileged=True)
        await manager.connect('trip1', 'u2', other)
        await manager.revoke_user('u1')
    asyncio.run(scenario())
    first.close.assert_awaited_once_with(code=4401)
    admin.close.assert_awaited_once_with(code=4401)
    other.close.assert_not_awaited()


@pytest.mark.parametrize("kind", ["reports", "receipts"])
def test_download_paths_reject_revoked_sessions(monkeypatch, kind):
    from types import SimpleNamespace
    from utils.security import create_token
    from routes import reports, receipts
    module = reports if kind == "reports" else receipts
    users = SimpleNamespace(find_one=AsyncMock(return_value={"id": "u1", "email": "u@gmail.com", "session_version": 1}))
    monkeypatch.setattr(module, "db", SimpleNamespace(users=users))
    token = create_token("u1", "u@gmail.com", 0)
    coroutine = module._download_report_data("trip", token) if kind == "reports" else module._resolve_user(token, None)
    with pytest.raises(HTTPException) as rejected:
        asyncio.run(coroutine)
    assert rejected.value.status_code == 401
