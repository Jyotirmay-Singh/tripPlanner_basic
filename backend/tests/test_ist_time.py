# Pure unit tests for utils.ist_time.format_ist (IST display of stored UTC timestamps).
# No HTTP, no server, no conftest fixtures — operates only on strings.
from utils.ist_time import format_ist


class TestFormatIST:
    def test_afternoon_same_day(self):
        # 09:05 UTC + 5:30 = 14:35 IST, same calendar day.
        assert format_ist("2026-07-13T09:05:00+00:00") == "13 Jul 2026, 2:35 PM IST"

    def test_crosses_midnight(self):
        # 19:00 UTC + 5:30 = 00:30 IST the NEXT day (the core requirement case).
        assert format_ist("2026-07-13T19:00:00+00:00") == "14 Jul 2026, 12:30 AM IST"

    def test_z_suffix_equals_offset(self):
        # A 'Z' designator and an explicit +00:00 offset must render identically.
        z = format_ist("2026-07-13T19:00:00Z")
        off = format_ist("2026-07-13T19:00:00+00:00")
        assert z == off == "14 Jul 2026, 12:30 AM IST"

    def test_naive_treated_as_utc(self):
        # A tz-less legacy string is treated as UTC (not local), so it matches the tz-aware form.
        assert format_ist("2026-07-13T19:00:00") == "14 Jul 2026, 12:30 AM IST"

    def test_with_microseconds(self):
        # Real stored value shape from now_utc().isoformat().
        assert format_ist("2026-07-13T19:00:00.123456+00:00") == "14 Jul 2026, 12:30 AM IST"

    def test_midnight_utc_is_530_am_ist(self):
        # 00:00 UTC + 5:30 = 05:30 AM IST, same day.
        assert format_ist("2026-07-13T00:00:00+00:00") == "13 Jul 2026, 5:30 AM IST"

    def test_1230_am_boundary(self):
        # 18:30 UTC + 5:30 = 00:00 IST next day -> "12:00 AM" (hour 0 -> 12).
        assert format_ist("2026-07-13T18:30:00+00:00") == "14 Jul 2026, 12:00 AM IST"

    def test_noon_boundary(self):
        # 06:30 UTC + 5:30 = 12:00 IST -> "12:00 PM" (hour 12 stays 12, PM).
        assert format_ist("2026-07-13T06:30:00+00:00") == "13 Jul 2026, 12:00 PM IST"

    def test_non_utc_offset_input(self):
        # An input already in +05:30 renders at its own wall-clock (astimezone is a no-op shift).
        assert format_ist("2026-07-14T00:30:00+05:30") == "14 Jul 2026, 12:30 AM IST"

    def test_missing_and_garbage(self):
        assert format_ist(None) == ""
        assert format_ist("") == ""
        assert format_ist("not-a-timestamp") == ""
