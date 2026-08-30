from typing import Optional


DEFAULT_CURRENCY = "INR"

# Keep this list aligned with frontend/src/currencies.ts. ISO codes are the persisted/API values;
# names and symbols remain presentation metadata on the client.
SUPPORTED_CURRENCIES = (
    "INR", "USD", "EUR", "GBP", "AED", "JPY", "SGD", "AUD", "CAD", "CHF",
    "CNY", "HKD", "NZD", "SAR", "QAR", "KWD", "BHD", "OMR", "THB", "MYR",
    "IDR", "KRW", "TRY", "ZAR", "LKR", "NPR",
)
SUPPORTED_CURRENCY_SET = frozenset(SUPPORTED_CURRENCIES)


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
