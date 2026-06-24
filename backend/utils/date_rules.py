from datetime import date, datetime
from typing import Optional

from fastapi import HTTPException

# Canonical storage/transport format for trip dates: a timezone-free calendar date.
ISO_DATE_FORMAT = "%Y-%m-%d"
# Legacy single-date format kept only for migration / read-time fallback (e.g. "15-12-26").
LEGACY_DATE_FORMAT = "%d-%m-%y"


def parse_iso_date(value: str) -> date:
    """Parse a 'YYYY-MM-DD' calendar date. Raises ValueError on an impossible date
    (e.g. 2026-02-31), which strptime rejects for us."""
    return datetime.strptime(value, ISO_DATE_FORMAT).date()


def assert_valid_date(value: Optional[str], label: str = "Date") -> date:
    """Validate a 'YYYY-MM-DD' string, returning the parsed date or raising HTTP 400."""
    if not value or not isinstance(value, str):
        raise HTTPException(400, f"{label} is required")
    try:
        return parse_iso_date(value.strip())
    except ValueError:
        raise HTTPException(400, f"{label} must be a valid date (YYYY-MM-DD)")


def assert_valid_range(start: Optional[str], end: Optional[str]) -> None:
    """Both dates valid and end on/after start (same-day allowed), else HTTP 400."""
    start_d = assert_valid_date(start, "Start date")
    end_d = assert_valid_date(end, "End date")
    if end_d < start_d:
        raise HTTPException(400, "End date must be the same as or after the start date")


def legacy_to_iso(value: Optional[str]) -> Optional[str]:
    """Convert a legacy 'DD-MM-YY' travel_date into 'YYYY-MM-DD' (None if unparseable).
    strptime's %y maps 00-68 to 2000-2068, so '26' -> 2026."""
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value.strip(), LEGACY_DATE_FORMAT).date().isoformat()
    except ValueError:
        return None


def iso_to_display(value: Optional[str]) -> str:
    """'YYYY-MM-DD' -> 'DD/MM/YYYY' for human-facing output (passthrough if unparseable)."""
    if not value or not isinstance(value, str):
        return ""
    try:
        return parse_iso_date(value.strip()).strftime("%d/%m/%Y")
    except ValueError:
        return value


def normalize_time(value: Optional[str]) -> Optional[str]:
    """Validate an optional wall-clock 'HH:MM' (24-hour) string.

    None / blank -> None (no time). A valid 'HH:MM' (00-23 : 00-59) -> normalized 'HH:MM'.
    Anything else raises ValueError so a Pydantic field_validator surfaces it as HTTP 422.
    Time is stored/transported as a timezone-free wall-clock string (never a UTC datetime)."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Time must be a string")
    s = value.strip()
    if not s:
        return None
    try:
        parsed = datetime.strptime(s, "%H:%M")
    except ValueError:
        raise ValueError("Time must be a valid 24-hour HH:MM value")
    return parsed.strftime("%H:%M")


def to_12h(value: Optional[str]) -> str:
    """'14:30' -> '2:30 PM' for human-facing output. Blank/invalid -> '' (passthrough)."""
    if not value or not isinstance(value, str):
        return ""
    try:
        parsed = datetime.strptime(value.strip(), "%H:%M")
    except ValueError:
        return ""
    # strftime('%I') is zero-padded ('02'); strip the leading zero for '2:30 PM'.
    return parsed.strftime("%I:%M %p").lstrip("0")


def ensure_date_range(trip: Optional[dict]) -> Optional[dict]:
    """Read-time fallback (mirrors the Step 22 receipt_base64 pattern): if a trip lacks a
    start_date, derive it from the legacy travel_date, and default a missing end_date to the
    start so old documents still render. Mutates and returns the trip dict."""
    if not trip:
        return trip
    start = trip.get("start_date")
    if not start:
        start = legacy_to_iso(trip.get("travel_date"))
        if start:
            trip["start_date"] = start
    if start and not trip.get("end_date"):
        trip["end_date"] = start
    return trip


def trip_date_label(trip: Optional[dict]) -> str:
    """Human-facing date range 'DD/MM/YYYY – DD/MM/YYYY', collapsing a same-day trip to one
    date. Applies the legacy fallback so old documents still render."""
    t = ensure_date_range(dict(trip or {})) or {}
    start = iso_to_display(t.get("start_date"))
    end = iso_to_display(t.get("end_date"))
    if not end or start == end:
        return start or end
    if not start:
        return end
    return f"{start} – {end}"
