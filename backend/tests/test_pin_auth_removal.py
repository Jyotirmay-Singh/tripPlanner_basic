"""Regression coverage for the irreversible password-only authentication cleanup."""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def test_retired_pin_data_cleanup_is_scoped_and_idempotent(monkeypatch):
    users = SimpleNamespace(update_many=AsyncMock(return_value=None))
    fake_db = SimpleNamespace(users=users, drop_collection=AsyncMock(return_value=None))
    monkeypatch.setattr(server, "db", fake_db)

    asyncio.run(server._remove_retired_pin_data())
    asyncio.run(server._remove_retired_pin_data())

    assert users.update_many.await_count == 2
    users.update_many.assert_awaited_with(
        {"pin_hash": {"$exists": True}},
        {"$unset": {"pin_hash": ""}},
    )
    assert fake_db.drop_collection.await_count == 2
    fake_db.drop_collection.assert_awaited_with("password_reset_tokens")
