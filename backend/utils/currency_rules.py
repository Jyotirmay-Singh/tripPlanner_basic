from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_HALF_UP, localcontext
from typing import Any, Optional


DEFAULT_CURRENCY = "INR"

# Keep this list aligned with frontend/src/currencies.ts. ISO codes are the persisted/API values;
# names and symbols remain presentation metadata on the client.
# ISO 4217 minor-unit exponents for the curated travel catalog. Rates are deliberately excluded:
# they retain provider precision and are never quantized as monetary amounts.
CURRENCY_MINOR_UNITS = {
    "INR": 2, "USD": 2, "EUR": 2, "GBP": 2, "AED": 2, "JPY": 0,
    "SGD": 2, "AUD": 2, "CAD": 2, "CHF": 2, "CNY": 2, "HKD": 2,
    "NZD": 2, "SAR": 2, "QAR": 2, "KWD": 3, "BHD": 3, "OMR": 3,
    "THB": 2, "MYR": 2, "IDR": 2, "KRW": 0, "TRY": 2, "ZAR": 2,
    "LKR": 2, "NPR": 2,
}
SUPPORTED_CURRENCIES = tuple(CURRENCY_MINOR_UNITS)
SUPPORTED_CURRENCY_SET = frozenset(SUPPORTED_CURRENCIES)


class CurrencyPrecisionError(ValueError):
    """A user-supplied amount has fractional precision the currency cannot represent."""

    def __init__(self, currency: str, minor_units: int, label: str = "Amount") -> None:
        self.currency = currency
        self.minor_units = minor_units
        self.label = label
        unit_word = "decimal place" if minor_units == 1 else "decimal places"
        super().__init__(
            f"{label} in {currency} allows at most {minor_units} {unit_word}"
        )


def normalize_currency(value: Optional[str], *, allow_none: bool = False) -> Optional[str]:
    """Return a canonical supported ISO currency code or raise ValueError."""
    if value is None:
        if allow_none:
            return None
        return DEFAULT_CURRENCY
    if not isinstance(value, str):
        raise ValueError("Currency must be an ISO code")
    code = value.strip().upper()
    if not code and allow_none:
        return None
    if code not in SUPPORTED_CURRENCY_SET:
        raise ValueError("Unsupported currency code")
    return code


def currency_minor_units(currency: str) -> int:
    return CURRENCY_MINOR_UNITS[normalize_currency(currency)]


def currency_quantum(currency: str) -> Decimal:
    return Decimal(1).scaleb(-currency_minor_units(currency))


def currency_increment(currency: str) -> str:
    return format(currency_quantum(currency), "f")


def decimal_amount(value: Any, *, label: str = "Amount") -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number") from exc
    if not parsed.is_finite():
        raise ValueError(f"{label} must be finite")
    return parsed


def validate_currency_precision(
    value: Any,
    currency: str,
    *,
    label: str = "Amount",
) -> Decimal:
    """Return an exact Decimal or reject fractional units the ISO currency cannot represent."""

    code = normalize_currency(currency)
    parsed = decimal_amount(value, label=label)
    quantum = currency_quantum(code)
    with localcontext() as context:
        context.prec = 60
        if parsed != parsed.quantize(quantum, rounding=ROUND_HALF_UP):
            raise CurrencyPrecisionError(code, currency_minor_units(code), label)
        return parsed.quantize(quantum)


def quantize_currency(value: Any, currency: str, *, label: str = "Amount") -> Decimal:
    """Round a computed value (never raw user input) to the currency's legal increment."""

    parsed = decimal_amount(value, label=label)
    with localcontext() as context:
        context.prec = 60
        return parsed.quantize(currency_quantum(currency), rounding=ROUND_HALF_UP)


def currency_units(value: Any, currency: str, *, label: str = "Amount") -> int:
    """Round a computed amount half-up and return its integer ISO minor-unit count."""

    code = normalize_currency(currency)
    quantized = quantize_currency(value, code, label=label)
    return int(quantized * (Decimal(10) ** currency_minor_units(code)))


def apportion_currency_amounts(
    values: dict,
    order: list,
    target: Any,
    currency: str,
) -> dict:
    """Snap raw shares to legal currency units while preserving their rounded total.

    Uses largest remainders with ``order`` as the deterministic tie-break. Flooring works for
    positive, negative, and mixed-sign inputs; each returned value differs from its raw value by
    less than one minor unit. The float return type preserves the existing numeric API/report
    contract and is only produced after all arithmetic has been completed with ``Decimal``.
    """

    code = normalize_currency(currency)
    keys = list(order)
    target_units = currency_units(target, code)
    if not keys:
        if target_units:
            raise ValueError("Currency apportionment has no recipients for a non-zero total")
        return {}
    if len(set(keys)) != len(keys) or any(key not in values for key in keys):
        raise ValueError("Currency apportionment order must contain each recipient exactly once")

    scale = Decimal(10) ** currency_minor_units(code)
    bases: dict = {}
    remainders: dict = {}
    with localcontext() as context:
        context.prec = 60
        for key in keys:
            raw_units = decimal_amount(values[key]) * scale
            base = int(raw_units.to_integral_value(rounding=ROUND_FLOOR))
            bases[key] = base
            remainders[key] = raw_units - base

    needed = target_units - sum(bases.values())
    if abs(needed) > len(keys):
        raise ValueError("Currency apportionment inputs do not reconcile to the target total")

    units = dict(bases)
    positions = {key: index for index, key in enumerate(keys)}
    if needed > 0:
        ranking = sorted(keys, key=lambda key: (-remainders[key], positions[key]))
        for key in ranking[:needed]:
            units[key] += 1
    elif needed < 0:
        ranking = sorted(keys, key=lambda key: (remainders[key], positions[key]))
        for key in ranking[:-needed]:
            units[key] -= 1

    numeric_scale = 10 ** currency_minor_units(code)
    return {key: units[key] / numeric_scale for key in keys}


def precision_error_detail(exc: CurrencyPrecisionError) -> dict:
    return {
        "code": "invalid_currency_precision",
        "message": str(exc),
        "currency": exc.currency,
        "minor_units": exc.minor_units,
        "retryable": False,
    }
