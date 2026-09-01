from datetime import date as calendar_date
from decimal import Decimal
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from config import MULTI_CURRENCY_EXPENSES_ENABLED
from services.exchange_rates import ExchangeRateError, create_quote, error_detail
from utils.currency_rules import normalize_currency
from utils.date_rules import parse_iso_date
from utils.deps import get_current_user


router = APIRouter()


@router.get("/exchange-rates/quote")
async def quote_exchange_rate(
    from_currency: str = Query(alias="from"),
    to_currency: str = Query(alias="to"),
    amount: Decimal = Query(),
    date: Optional[str] = Query(default=None),
    mode: Literal["automatic", "manual"] = Query(default="automatic"),
    manual_input_type: Optional[Literal["rate", "target_amount"]] = Query(default=None),
    manual_rate: Optional[Decimal] = Query(default=None),
    manual_target_amount: Optional[Decimal] = Query(default=None),
    refresh: bool = Query(default=False),
    user=Depends(get_current_user),
):
    if not MULTI_CURRENCY_EXPENSES_ENABLED:
        raise HTTPException(409, {
            "code": "multi_currency_disabled",
            "message": "Multi-currency expense conversion is not enabled",
            "retryable": False,
        })
    try:
        source = normalize_currency(from_currency)
        target = normalize_currency(to_currency)
        requested_date = None
        if date:
            requested = parse_iso_date(date.strip())
            if requested > calendar_date.today():
                raise ValueError("Expense date cannot be in the future for a reference quote")
            requested_date = requested.isoformat()
        return await create_quote(
            user_id=user["id"],
            source_currency=source,
            target_currency=target,
            source_amount=amount,
            requested_date=requested_date,
            mode=mode,
            manual_input_type=manual_input_type,
            manual_rate=manual_rate,
            manual_target_amount=manual_target_amount,
            refresh=refresh,
        )
    except ExchangeRateError as exc:
        raise HTTPException(exc.status_code, error_detail(exc))
    except ValueError as exc:
        raise HTTPException(422, {
            "code": "invalid_conversion",
            "message": str(exc),
            "retryable": False,
        })

