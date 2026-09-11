import re


UPI_ID_MESSAGE = "Enter a valid UPI ID, for example name@bank"

# Common VPA shape: a 2-256 character customer identifier and a 2-64 character
# provider handle. This validates syntax only; it cannot establish ownership or
# confirm that a payment address exists.
UPI_ID_RE = re.compile(r"[A-Za-z0-9._-]{2,256}@[A-Za-z0-9]{2,64}")
CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def normalize_upi_id(value: str) -> str:
    """Validate a UPI ID and return it with surrounding whitespace removed."""
    if not isinstance(value, str):
        raise ValueError(UPI_ID_MESSAGE)
    # Check the raw value before stripping so tabs/newlines cannot be hidden at
    # either edge. Ordinary surrounding spaces are accepted and removed.
    if CONTROL_CHARACTER_RE.search(value):
        raise ValueError(UPI_ID_MESSAGE)
    normalized = value.strip()
    if not UPI_ID_RE.fullmatch(normalized):
        raise ValueError(UPI_ID_MESSAGE)
    return normalized
