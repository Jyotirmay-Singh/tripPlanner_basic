import asyncio
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from services import exchange_rates as rates


def run(awaitable):
    return asyncio.run(awaitable)


class FakeResponse:
    def __init__(self, status_code=200, payload=None, json_error=None):
        self.status_code = status_code
        self._payload = payload
        self._json_error = json_error

    def json(self):
        if self._json_error:
            raise self._json_error
        return self._payload


def provider_payload(*, effective="2026-08-28", rate="3.5204"):
    return {
        "date": effective,
        "base": "INR",
        "quote": "LKR",
        "rate": rate,
        "providers": [{"key": "ECB", "date": effective, "rate": rate}],
    }


def test_provider_payload_accepts_weekend_fallback_effective_date():
    result = rates._validate_provider_payload(
        provider_payload(), "INR", "LKR", "2026-08-30"
    )
    assert result["effective_date"] == "2026-08-28"
    assert result["rate"] == Decimal("3.5204")
    assert result["provider_sources"][0]["key"] == "ECB"


def test_provider_payload_accepts_historical_weekday_effective_date():
    result = rates._validate_provider_payload(
        provider_payload(effective="2026-08-27"), "INR", "LKR", "2026-08-27"
    )
    assert result["effective_date"] == "2026-08-27"


@pytest.mark.parametrize("payload", [
    {"date": "not-a-date", "base": "INR", "quote": "LKR", "rate": 3.5},
    {"date": "2026-08-28", "base": "USD", "quote": "LKR", "rate": 3.5},
    {"date": "2026-08-28", "base": "INR", "quote": "LKR", "rate": 0},
])
def test_malformed_provider_payload_is_rejected(payload):
    with pytest.raises(rates.MalformedProviderResponse):
        rates._validate_provider_payload(payload, "INR", "LKR", "2026-08-30")


def test_historical_cache_hit_never_calls_provider(monkeypatch):
    cached = {
        "rate_id": "r1", "rate": Decimal("3.5"), "effective_date": "2026-08-28",
        "provider": rates.PROVIDER, "provider_sources": [], "cache_revision": 1,
        "cache_hit": True, "stale": False,
    }
    provider = AsyncMock()
    monkeypatch.setattr(rates, "_historical_cached", AsyncMock(return_value=cached))
    monkeypatch.setattr(rates, "_provider_request", provider)

    result = run(rates.get_reference_rate("INR", "LKR", "2026-08-28"))

    assert result == cached
    provider.assert_not_awaited()


def test_uncached_weekend_rate_persists_effective_date_alias(monkeypatch):
    fetched = {
        "rate": Decimal("3.5204"), "effective_date": "2026-08-28",
        "provider_sources": [],
    }
    record = {
        "id": "r1", "rate": Decimal("3.5204"), "effective_date": "2026-08-28",
        "provider": rates.PROVIDER, "provider_sources": [], "revision": 1,
    }
    store_alias = AsyncMock()
    monkeypatch.setattr(rates, "_historical_cached", AsyncMock(return_value=None))
    monkeypatch.setattr(rates, "_provider_request", AsyncMock(return_value=fetched))
    monkeypatch.setattr(rates, "_store_rate", AsyncMock(return_value=record))
    monkeypatch.setattr(rates, "_store_alias", store_alias)

    result = run(rates.get_reference_rate("INR", "LKR", "2026-08-30"))

    assert result["cache_hit"] is False
    assert result["effective_date"] == "2026-08-28"
    store_alias.assert_awaited_once_with(
        "INR", "LKR", "2026-08-30", record, latest=False, refresh=False,
    )


def test_provider_timeout_retries_once_then_returns_retryable_error(monkeypatch):
    client = SimpleNamespace(
        is_closed=False,
        get=AsyncMock(side_effect=httpx.ReadTimeout("slow")),
    )
    monkeypatch.setattr(rates, "_client", client)
    monkeypatch.setattr(rates, "start_exchange_rate_client", AsyncMock())
    monkeypatch.setattr(rates.asyncio, "sleep", AsyncMock())

    with pytest.raises(rates.ExchangeRateError) as caught:
        run(rates._provider_request("INR", "LKR", "2026-08-28"))

    assert caught.value.code == "exchange_rate_timeout"
    assert caught.value.retryable is True
    assert client.get.await_count == 2


def test_provider_invalid_json_and_unsupported_pair_are_distinct(monkeypatch):
    client = SimpleNamespace(
        is_closed=False,
        get=AsyncMock(side_effect=[
            FakeResponse(200, json_error=ValueError("bad json")),
            FakeResponse(400, payload={}),
        ]),
    )
    monkeypatch.setattr(rates, "_client", client)
    monkeypatch.setattr(rates, "start_exchange_rate_client", AsyncMock())

    with pytest.raises(rates.MalformedProviderResponse):
        run(rates._provider_request("INR", "LKR", "2026-08-28"))
    with pytest.raises(rates.UnsupportedCurrencyPair) as unavailable:
        run(rates._provider_request("INR", "LKR", "2026-08-28"))
    assert unavailable.value.code == "unsupported_currency_pair"
    assert unavailable.value.retryable is False


def test_unavailable_historical_rate_is_non_retryable(monkeypatch):
    client = SimpleNamespace(
        is_closed=False,
        get=AsyncMock(return_value=FakeResponse(404, payload={})),
    )
    monkeypatch.setattr(rates, "_client", client)
    monkeypatch.setattr(rates, "start_exchange_rate_client", AsyncMock())

    with pytest.raises(rates.RateUnavailable) as caught:
        run(rates._provider_request("INR", "LKR", "1990-01-01"))

    assert caught.value.code == "rate_unavailable"
    assert caught.value.status_code == 422
    assert caught.value.retryable is False


def test_manual_final_amount_preserves_refund_sign_and_is_auditable(monkeypatch):
    quotes = SimpleNamespace(insert_one=AsyncMock())
    monkeypatch.setattr(rates, "db", SimpleNamespace(exchange_rate_quotes=quotes))
    monkeypatch.setattr(rates, "gen_id", lambda: "q1")
    monkeypatch.setattr(
        rates, "now_utc", lambda: datetime(2026, 8, 31, tzinfo=timezone.utc)
    )

    result = run(rates.create_quote(
        user_id="u1", source_currency="INR", target_currency="LKR",
        source_amount="-100", requested_date="2026-08-28", mode="manual",
        manual_input_type="target_amount", manual_target_amount="352.04",
    ))

    assert result["target_amount"] == "-352.04"
    assert result["rate"] == "3.5204"
    assert result["provider"] == "manual"
    assert result["manual_input_value"] == "352.04"
    stored = quotes.insert_one.await_args.args[0]
    assert stored["manual_input_type"] == "target_amount"


def test_manual_rate_quote_uses_decimal_arithmetic_and_audit_fields(monkeypatch):
    quotes = SimpleNamespace(insert_one=AsyncMock())
    monkeypatch.setattr(rates, "db", SimpleNamespace(exchange_rate_quotes=quotes))
    monkeypatch.setattr(rates, "gen_id", lambda: "q-rate")

    result = run(rates.create_quote(
        user_id="u1", source_currency="NPR", target_currency="LKR",
        source_amount="1500", requested_date="2026-08-28", mode="manual",
        manual_input_type="rate", manual_rate="1.375",
    ))

    assert result["target_amount"] == "2062.50"
    assert result["rate"] == "1.375"
    assert result["manual_input_type"] == "rate"
    assert result["manual_input_value"] == "1.375"
    assert result["provider"] == "manual"


@pytest.mark.parametrize("kwargs, message", [
    ({"mode": "automatic", "manual_rate": "1.2"}, "cannot include manual inputs"),
    ({"mode": "manual", "manual_input_type": "rate", "manual_rate": "1.2",
      "manual_target_amount": "12"}, "requires only manual_rate"),
    ({"mode": "manual", "manual_input_type": "target_amount"},
     "requires only manual_target_amount"),
])
def test_conflicting_or_incomplete_manual_quote_inputs_are_rejected(kwargs, message):
    with pytest.raises(ValueError, match=message):
        run(rates.create_quote(
            user_id="u1", source_currency="INR", target_currency="LKR",
            source_amount="10", requested_date="2026-08-28", **kwargs,
        ))


def test_same_currency_quote_uses_identity_without_provider(monkeypatch):
    quotes = SimpleNamespace(insert_one=AsyncMock())
    provider = AsyncMock()
    monkeypatch.setattr(rates, "db", SimpleNamespace(exchange_rate_quotes=quotes))
    monkeypatch.setattr(rates, "_provider_request", provider)

    result = run(rates.create_quote(
        user_id="u1", source_currency="LKR", target_currency="LKR",
        source_amount="125.50", requested_date="2026-08-28", mode="automatic",
    ))

    assert result["rate"] == "1"
    assert result["target_amount"] == "125.50"
    assert result["provider"] == "identity"
    provider.assert_not_awaited()
