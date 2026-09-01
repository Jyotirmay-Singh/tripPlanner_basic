"""Frankfurter v2 reference-rate quotes with durable MongoDB caching.

Historical rate records are stable until an explicit refresh. Requested-date aliases preserve the
provider's holiday/weekend decision; the service never guesses by selecting an arbitrary older
cached date. Short-lived server-issued quotes bind the exact preview a user approved to the later
expense write.
"""

import asyncio
from datetime import date as calendar_date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Optional

import httpx
from bson.decimal128 import Decimal128
from pymongo.errors import DuplicateKeyError

from database import db
from utils.common import gen_id, now_utc


PROVIDER = "frankfurter_v2_blended"
PROVIDER_URL = "https://api.frankfurter.dev/v2/rate/{source}/{target}"
MONEY_QUANTUM = Decimal("0.01")
LATEST_FRESH_FOR = timedelta(minutes=15)
LATEST_STALE_FOR = timedelta(hours=24)
QUOTE_LIFETIME = timedelta(minutes=30)

_client: Optional[httpx.AsyncClient] = None
_provider_slots = asyncio.Semaphore(8)


class ExchangeRateError(Exception):
    code = "exchange_rate_error"
    status_code = 503
    retryable = True

    def __init__(self, message: str, *, code: Optional[str] = None,
                 status_code: Optional[int] = None, retryable: Optional[bool] = None):
        super().__init__(message)
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        if retryable is not None:
            self.retryable = retryable


class RateUnavailable(ExchangeRateError):
    code = "rate_unavailable"
    status_code = 422
    retryable = False


class UnsupportedCurrencyPair(ExchangeRateError):
    code = "unsupported_currency_pair"
    status_code = 422
    retryable = False


class MalformedProviderResponse(ExchangeRateError):
    code = "malformed_provider_response"
    status_code = 502
    retryable = True


def error_detail(exc: ExchangeRateError) -> dict:
    return {"code": exc.code, "message": str(exc), "retryable": exc.retryable}


def money(value: Any) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("Amount must be a number")
    if not parsed.is_finite() or parsed == 0:
        raise ValueError("Amount must be a finite non-zero number")
    return parsed.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)


def positive_decimal(value: Any, label: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError(f"{label} must be a number")
    if not parsed.is_finite() or parsed <= 0:
        raise ValueError(f"{label} must be greater than zero")
    return parsed


def _decimal128(value: Decimal) -> Decimal128:
    return Decimal128(value)


def _decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal128):
        return value.to_decimal()
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _aware(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


async def start_exchange_rate_client() -> None:
    global _client
    if _client is None or _client.is_closed:
        timeout = httpx.Timeout(connect=2.0, read=5.0, write=5.0, pool=2.0)
        _client = httpx.AsyncClient(
            timeout=timeout,
            headers={"Accept": "application/json", "User-Agent": "TripSplitter/1 exchange-rates"},
        )


async def stop_exchange_rate_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _validate_provider_payload(payload: Any, source: str, target: str,
                               requested_date: Optional[str]) -> dict:
    if not isinstance(payload, dict):
        raise MalformedProviderResponse("Exchange-rate provider returned an invalid response")
    if payload.get("base") != source or payload.get("quote") != target:
        raise MalformedProviderResponse("Exchange-rate provider returned the wrong currency pair")
    effective = payload.get("date")
    if not isinstance(effective, str) or len(effective) != 10:
        raise MalformedProviderResponse("Exchange-rate provider omitted the effective date")
    try:
        calendar_date.fromisoformat(effective)
    except ValueError:
        raise MalformedProviderResponse("Exchange-rate provider returned an invalid effective date")
    if requested_date and effective > requested_date:
        raise MalformedProviderResponse("Exchange-rate provider returned a future effective date")
    try:
        rate = positive_decimal(payload.get("rate"), "Provider rate")
    except ValueError as exc:
        raise MalformedProviderResponse(str(exc))

    sources = []
    raw_sources = payload.get("providers")
    if raw_sources is not None:
        if not isinstance(raw_sources, list):
            raise MalformedProviderResponse("Exchange-rate provider attribution is invalid")
        for item in raw_sources:
            if not isinstance(item, dict) or not isinstance(item.get("key"), str):
                raise MalformedProviderResponse("Exchange-rate provider attribution is invalid")
            try:
                source_rate = positive_decimal(item.get("rate"), "Provider source rate")
            except ValueError as exc:
                raise MalformedProviderResponse(str(exc))
            sources.append({
                "key": item["key"],
                "date": item.get("date"),
                "rate": source_rate,
            })
    return {"effective_date": effective, "rate": rate, "provider_sources": sources}


async def _provider_request(source: str, target: str,
                            requested_date: Optional[str]) -> dict:
    await start_exchange_rate_client()
    assert _client is not None
    params: dict[str, str] = {"expand": "providers"}
    if requested_date:
        params["date"] = requested_date
    url = PROVIDER_URL.format(source=source, target=target)

    last_error: Optional[ExchangeRateError] = None
    async with _provider_slots:
        for attempt in range(2):
            try:
                response = await _client.get(url, params=params)
            except httpx.TimeoutException:
                last_error = ExchangeRateError(
                    "Exchange-rate provider timed out", code="exchange_rate_timeout"
                )
            except httpx.RequestError:
                last_error = ExchangeRateError(
                    "Exchange-rate provider is unavailable", code="exchange_rate_unavailable"
                )
            else:
                if response.status_code in (400, 422):
                    raise UnsupportedCurrencyPair(
                        "The exchange-rate provider does not support this currency pair"
                    )
                if response.status_code == 404:
                    raise RateUnavailable(
                        "No historical reference rate is available for this date"
                    )
                if response.status_code == 429 or response.status_code >= 500:
                    last_error = ExchangeRateError(
                        "Exchange-rate provider is temporarily unavailable",
                        code="exchange_rate_unavailable",
                    )
                elif response.status_code >= 400:
                    raise ExchangeRateError(
                        "Exchange-rate provider rejected the request",
                        code="exchange_rate_unavailable",
                        status_code=502,
                    )
                else:
                    try:
                        payload = response.json()
                    except ValueError:
                        raise MalformedProviderResponse(
                            "Exchange-rate provider returned invalid JSON"
                        )
                    return _validate_provider_payload(payload, source, target, requested_date)
            if attempt == 0:
                await asyncio.sleep(0.2)
    raise last_error or ExchangeRateError("Exchange-rate provider is unavailable")


def _public_sources(stored: list) -> list:
    return [
        {"key": item.get("key"), "date": item.get("date"), "rate": _decimal(item["rate"])}
        for item in (stored or [])
    ]


def _rate_result(record: dict, *, cache_hit: bool, stale: bool = False) -> dict:
    return {
        "rate_id": record["id"],
        "rate": _decimal(record["rate"]),
        "effective_date": record["effective_date"],
        "provider": record.get("provider", PROVIDER),
        "provider_sources": _public_sources(record.get("provider_sources") or []),
        "cache_revision": int(record.get("revision", 1)),
        "cache_hit": cache_hit,
        "stale": stale,
    }


async def _rate_by_id(rate_id: str) -> Optional[dict]:
    return await db.exchange_rates.find_one({"id": rate_id}, {"_id": 0})


async def _historical_cached(source: str, target: str, requested_date: str) -> Optional[dict]:
    alias = await db.exchange_rate_aliases.find_one({
        "provider": PROVIDER,
        "source_currency": source,
        "target_currency": target,
        "requested_key": requested_date,
    }, {"_id": 0})
    if alias:
        record = await _rate_by_id(alias["rate_id"])
        if record:
            return _rate_result(record, cache_hit=True)

    # An exact effective-date record is safe to reuse. An arbitrary earlier record is not: it could
    # incorrectly hide a newer business-day rate that simply has not been fetched yet.
    record = await db.exchange_rates.find_one({
        "provider": PROVIDER,
        "source_currency": source,
        "target_currency": target,
        "effective_date": requested_date,
    }, {"_id": 0})
    if record:
        await _store_alias(source, target, requested_date, record, latest=False, refresh=False)
        return _rate_result(record, cache_hit=True)
    return None


async def _store_rate(source: str, target: str, fetched: dict, *, refresh: bool) -> dict:
    key = {
        "provider": PROVIDER,
        "source_currency": source,
        "target_currency": target,
        "effective_date": fetched["effective_date"],
    }
    stored_sources = [
        {"key": item["key"], "date": item.get("date"), "rate": _decimal128(item["rate"])}
        for item in fetched.get("provider_sources", [])
    ]
    timestamp = now_utc()
    existing = await db.exchange_rates.find_one(key, {"_id": 0})
    if existing and refresh:
        archived = {
            "revision": int(existing.get("revision", 1)),
            "rate": existing["rate"],
            "provider_sources": existing.get("provider_sources", []),
            "fetched_at": existing.get("fetched_at"),
        }
        await db.exchange_rates.update_one(
            {**key, "revision": int(existing.get("revision", 1))},
            {
                "$set": {
                    "rate": _decimal128(fetched["rate"]),
                    "provider_sources": stored_sources,
                    "fetched_at": timestamp,
                },
                "$inc": {"revision": 1},
                "$push": {"revision_history": archived},
            },
        )
        return await db.exchange_rates.find_one(key, {"_id": 0})

    document = {
        **key,
        "id": gen_id(),
        "rate": _decimal128(fetched["rate"]),
        "provider_sources": stored_sources,
        "revision": 1,
        "revision_history": [],
        "fetched_at": timestamp,
    }
    try:
        await db.exchange_rates.update_one(key, {"$setOnInsert": document}, upsert=True)
    except DuplicateKeyError:
        pass
    return await db.exchange_rates.find_one(key, {"_id": 0})


async def _store_alias(source: str, target: str, requested_key: str, record: dict,
                       *, latest: bool, refresh: bool) -> None:
    timestamp = now_utc()
    key = {
        "provider": PROVIDER,
        "source_currency": source,
        "target_currency": target,
        "requested_key": requested_key,
    }
    values = {
        "effective_date": record["effective_date"],
        "rate_id": record["id"],
        "cached_at": timestamp,
        "fresh_until": timestamp + LATEST_FRESH_FOR if latest else None,
        "stale_until": timestamp + LATEST_STALE_FOR if latest else None,
    }
    if latest or refresh:
        await db.exchange_rate_aliases.update_one(key, {"$set": values}, upsert=True)
    else:
        try:
            await db.exchange_rate_aliases.update_one(
                key, {"$setOnInsert": {**key, **values}}, upsert=True
            )
        except DuplicateKeyError:
            pass


async def get_reference_rate(source: str, target: str, requested_date: Optional[str],
                             *, refresh: bool = False) -> dict:
    if source == target:
        return {
            "rate_id": None,
            "rate": Decimal("1"),
            "effective_date": requested_date,
            "provider": "identity",
            "provider_sources": [],
            "cache_revision": 1,
            "cache_hit": True,
            "stale": False,
        }

    if requested_date and not refresh:
        cached = await _historical_cached(source, target, requested_date)
        if cached:
            return cached

    latest_alias = None
    if requested_date is None and not refresh:
        latest_alias = await db.exchange_rate_aliases.find_one({
            "provider": PROVIDER,
            "source_currency": source,
            "target_currency": target,
            "requested_key": "latest",
        }, {"_id": 0})
        if latest_alias:
            fresh_until = _aware(latest_alias.get("fresh_until"))
            if fresh_until and fresh_until > now_utc():
                record = await _rate_by_id(latest_alias["rate_id"])
                if record:
                    return _rate_result(record, cache_hit=True)

    try:
        fetched = await _provider_request(source, target, requested_date)
    except ExchangeRateError:
        if requested_date is None and latest_alias:
            stale_until = _aware(latest_alias.get("stale_until"))
            if stale_until and stale_until > now_utc():
                record = await _rate_by_id(latest_alias["rate_id"])
                if record:
                    return _rate_result(record, cache_hit=True, stale=True)
        raise

    record = await _store_rate(source, target, fetched, refresh=refresh)
    await _store_alias(
        source, target, requested_date or "latest", record,
        latest=requested_date is None, refresh=refresh,
    )
    return _rate_result(record, cache_hit=False)


async def create_quote(*, user_id: str, source_currency: str, target_currency: str,
                       source_amount: Any, requested_date: Optional[str], mode: str,
                       manual_input_type: Optional[str] = None, manual_rate: Any = None,
                       manual_target_amount: Any = None, refresh: bool = False) -> dict:
    if mode == "automatic":
        if manual_input_type is not None or manual_rate is not None \
                or manual_target_amount is not None:
            raise ValueError("Automatic conversion cannot include manual inputs")
    elif mode == "manual":
        if manual_input_type == "rate":
            if manual_rate is None or manual_target_amount is not None:
                raise ValueError("Manual rate conversion requires only manual_rate")
        elif manual_input_type == "target_amount":
            if manual_target_amount is None or manual_rate is not None:
                raise ValueError(
                    "Manual final amount conversion requires only manual_target_amount"
                )
        else:
            raise ValueError("Manual conversion requires a rate or final amount")
    else:
        raise ValueError("Unsupported exchange-rate mode")

    source = money(source_amount)
    if source_currency == target_currency:
        if mode != "automatic":
            raise ValueError("Same-currency expenses always use rate 1")
        rate_data = await get_reference_rate(source_currency, target_currency, requested_date)
        target = source
        mode = "automatic"
        manual_value = None
    elif mode == "manual":
        if manual_input_type == "rate":
            rate = positive_decimal(manual_rate, "Manual rate")
            target = (source * rate).quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)
            manual_value = rate
        elif manual_input_type == "target_amount":
            magnitude = positive_decimal(manual_target_amount, "Manual final amount") \
                .quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)
            target = magnitude.copy_sign(source)
            rate = magnitude / abs(source)
            manual_value = magnitude
        else:
            raise ValueError("Manual conversion requires a rate or final amount")
        rate_data = {
            "rate_id": None,
            "rate": rate,
            "effective_date": None,
            "provider": "manual",
            "provider_sources": [],
            "cache_revision": 1,
            "cache_hit": False,
            "stale": False,
        }
    else:
        rate_data = await get_reference_rate(
            source_currency, target_currency, requested_date, refresh=refresh
        )
        target = (source * rate_data["rate"]).quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)
        manual_input_type = None
        manual_value = None

    created_at = now_utc()
    expires_at = created_at + QUOTE_LIFETIME
    quote_id = gen_id()
    document = {
        "id": quote_id,
        "user_id": user_id,
        "mode": mode,
        "source_amount": _decimal128(source),
        "source_currency": source_currency,
        "target_amount": _decimal128(target),
        "target_currency": target_currency,
        "rate": _decimal128(rate_data["rate"]),
        "requested_date": requested_date,
        "effective_rate_date": rate_data["effective_date"],
        "provider": rate_data["provider"],
        "provider_sources": [
            {**item, "rate": _decimal128(item["rate"])}
            for item in rate_data["provider_sources"]
        ],
        "cache_revision": rate_data["cache_revision"],
        "cache_hit": bool(rate_data["cache_hit"]),
        "stale": bool(rate_data["stale"]),
        "manual_input_type": manual_input_type,
        "manual_input_value": _decimal128(manual_value) if manual_value is not None else None,
        "created_at": created_at,
        "expires_at": expires_at,
    }
    await db.exchange_rate_quotes.insert_one(document)
    return quote_public(document)


def quote_public(document: dict) -> dict:
    return {
        "quote_id": document["id"],
        "mode": document["mode"],
        "source_amount": str(_decimal(document["source_amount"])),
        "source_currency": document["source_currency"],
        "target_amount": str(_decimal(document["target_amount"])),
        "target_currency": document["target_currency"],
        "rate": str(_decimal(document["rate"])),
        "requested_date": document.get("requested_date"),
        "effective_rate_date": document.get("effective_rate_date"),
        "provider": document["provider"],
        "provider_sources": [
            {"key": item.get("key"), "date": item.get("date"),
             "rate": str(_decimal(item["rate"]))}
            for item in document.get("provider_sources", [])
        ],
        "cache_hit": bool(document.get("cache_hit")),
        "stale": bool(document.get("stale")),
        "manual": document["mode"] == "manual",
        "manual_input_type": document.get("manual_input_type"),
        "manual_input_value": str(_decimal(document["manual_input_value"]))
        if document.get("manual_input_value") is not None else None,
        "requires_confirmation": document["source_currency"] != document["target_currency"],
        "expires_at": document["expires_at"].isoformat(),
    }


async def load_quote(quote_id: str, user_id: str) -> dict:
    quote = await db.exchange_rate_quotes.find_one(
        {"id": quote_id, "user_id": user_id}, {"_id": 0}
    )
    expires = _aware(quote.get("expires_at")) if quote else None
    if not quote or not expires or expires <= now_utc():
        raise ExchangeRateError(
            "The exchange-rate quote expired; request and approve a new quote",
            code="conversion_confirmation_required",
            status_code=428,
            retryable=False,
        )
    return quote


def decimal_value(value: Any) -> Decimal:
    return _decimal(value)
