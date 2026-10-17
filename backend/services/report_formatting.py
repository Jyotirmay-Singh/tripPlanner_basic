"""Shared report labels and whole-unit Indian number presentation."""

from utils.money_policy import whole_money

BRAND = "1C3F39"
RECEIVE = "166534"
PAY = "991B1B"
NEUTRAL = "475569"
SYMBOLS = {
    "INR": "₹", "USD": "$", "EUR": "€", "GBP": "£", "AED": "AED", "JPY": "¥",
    "SGD": "S$", "AUD": "A$", "CAD": "C$", "CHF": "CHF", "CNY": "CN¥", "HKD": "HK$",
    "NZD": "NZ$", "SAR": "SAR", "QAR": "QAR", "KWD": "KD", "BHD": "BD", "OMR": "OMR",
    "THB": "฿", "MYR": "RM", "IDR": "Rp", "KRW": "₩", "TRY": "₺", "ZAR": "R",
    "LKR": "Rs", "NPR": "Rs",
}


def currency_symbol(currency: str) -> str:
    return SYMBOLS.get(currency, currency)


def indian_number(value) -> str:
    amount = whole_money(value, reject_nonzero_to_zero=False)
    digits = str(abs(amount))
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while head:
            groups.insert(0, head[-2:])
            head = head[:-2]
        digits = ",".join(groups + [tail])
    return f"({digits})" if amount < 0 else digits


def money_text(value, currency: str) -> str:
    return f"{currency_symbol(currency)} {indian_number(value)}"


def indian_format(magnitude: int = 0) -> str:
    """A numeric Excel mask. Literal grouping works independently of the viewer's locale.

    Conditional number formats select the magnitude again after a native pivot filter/refresh.
    """
    digits = len(str(abs(magnitude)))
    if digits <= 5:
        mask = "#,##0"
    else:
        pairs = (digits - 4) // 2
        mask = "0" + "\\,00" * pairs + "\\,000"
    return f"{mask};({mask});0"
