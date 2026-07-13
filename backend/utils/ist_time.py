"""DISPLAY-only: render a stored UTC timestamp in Indian Standard Time (UTC+05:30).

The app is India-only and IST is a fixed offset (India observes no DST), so this is a plain
+05:30 shift with no timezone database needed. Storage stays tz-aware UTC and every sort/replay
input keeps reading the raw ISO string; this helper is called ONLY by the report display layer
(the XLSX Payments tab and the PDF Payments section), never by the balance/replay engine.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

_IST = timezone(timedelta(hours=5, minutes=30))  # fixed offset; no DST
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def format_ist(iso: Optional[str]) -> str:
    """Stored UTC ISO -> '14 Jul 2026, 12:30 AM IST'. '' for missing/unparseable.

    A tz-naive/legacy string (no offset) is treated as UTC. The 12-hour clock is built by hand
    (no ``%-I``/``%-d`` strftime codes) so the output is identical on Windows and Linux.
    """
    if not iso:
        return ""
    s = iso.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"  # datetime.fromisoformat (<3.11) doesn't accept a 'Z' suffix
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)  # naive -> UTC
    ist = dt.astimezone(_IST)
    h12 = ist.hour % 12 or 12
    ampm = "AM" if ist.hour < 12 else "PM"
    return f"{ist.day} {_MONTHS[ist.month - 1]} {ist.year}, {h12}:{ist.minute:02d} {ampm} IST"
