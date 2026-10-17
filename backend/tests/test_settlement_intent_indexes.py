"""Keep legacy releases bootable without silently changing financial uniqueness rules."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from services.settlement_intents import ensure_indexes


LEGACY_INDEX = {"key": [("quote_id", 1)], "unique": True, "v": 2}


def database_with(index):
    def collection():
        return SimpleNamespace(create_index=AsyncMock(), drop_index=AsyncMock())

    database = SimpleNamespace(**{name: collection() for name in [
        "settlement_quotes", "settlement_intent_actions", "payments", "expense_coverage_events", "payment_attempts",
    ]})
    database.payment_attempts.index_information = AsyncMock(return_value={"quote_id_1": deepcopy(index)} if index else {})
    return database


def test_enabled_rollout_and_direct_installers_keep_the_explicit_upgrade_guard():
    database = database_with(LEGACY_INDEX)
    with pytest.raises(RuntimeError, match="explicitly authorized compatibility upgrade"):
        asyncio.run(ensure_indexes(database))
    database.payment_attempts.drop_index.assert_not_awaited()
    database.payment_attempts.create_index.assert_not_awaited()


def test_disabled_rollout_retains_the_exact_legacy_index_and_audit_history():
    database = database_with(LEGACY_INDEX)
    asyncio.run(ensure_indexes(database, allow_legacy_quote_index=True))
    database.payment_attempts.drop_index.assert_not_awaited()
    database.payment_attempts.create_index.assert_not_awaited()
    database.payments.create_index.assert_awaited_once()


@pytest.mark.parametrize("change", [
    {"unique": False}, {"key": [("other_id", 1)]}, {"sparse": True},
    {"expireAfterSeconds": 0}, {"collation": {"locale": "en", "strength": 2}},
])
def test_disabled_rollout_still_rejects_unrecognised_index_definitions(change):
    database = database_with({**LEGACY_INDEX, **change})
    with pytest.raises(RuntimeError, match="explicitly authorized compatibility upgrade"):
        asyncio.run(ensure_indexes(database, allow_legacy_quote_index=True))
    database.payment_attempts.drop_index.assert_not_awaited()
    database.payment_attempts.create_index.assert_not_awaited()


@pytest.mark.parametrize("index", [None, {
    **LEGACY_INDEX, "partialFilterExpression": {"quote_id": {"$type": "string"}},
}])
def test_fresh_and_upgraded_databases_use_the_partial_unique_index(index):
    database = database_with(index)
    asyncio.run(ensure_indexes(database, allow_legacy_quote_index=True))
    database.payment_attempts.drop_index.assert_not_awaited()
    database.payment_attempts.create_index.assert_awaited_once_with(
        "quote_id", unique=True, partialFilterExpression={"quote_id": {"$type": "string"}},
    )


def test_replacement_still_requires_the_explicit_maintenance_argument():
    database = database_with(LEGACY_INDEX)
    asyncio.run(ensure_indexes(database, replace_incompatible_quote_index=True))
    database.payment_attempts.drop_index.assert_awaited_once_with("quote_id_1")
    database.payment_attempts.create_index.assert_awaited_once_with(
        "quote_id", unique=True, partialFilterExpression={"quote_id": {"$type": "string"}},
    )
