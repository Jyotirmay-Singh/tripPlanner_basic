# Pure unit tests for the optional-time helpers in utils.date_rules.
# No HTTP, no server, no conftest fixtures.
import pytest

from utils.date_rules import normalize_time, to_12h


class TestNormalizeTime:

    def test_none_and_blank_become_none(self):
        assert normalize_time(None) is None
        assert normalize_time("") is None
        assert normalize_time("   ") is None

    def test_valid_times_pass_through_normalized(self):
        assert normalize_time("14:30") == "14:30"
        assert normalize_time(" 09:05 ") == "09:05"

    def test_non_padded_is_normalized(self):
        # Lenient input, canonical storage: "9:5" -> "09:05".
        assert normalize_time("9:5") == "09:05"

    def test_boundaries(self):
        assert normalize_time("00:00") == "00:00"
        assert normalize_time("23:59") == "23:59"

    @pytest.mark.parametrize("bad", ["25:00", "24:00", "12:60", "1430", "ab:cd", "12:30 PM"])
    def test_invalid_raises(self, bad):
        with pytest.raises(ValueError):
            normalize_time(bad)

    def test_non_string_raises(self):
        with pytest.raises(ValueError):
            normalize_time(1430)


class TestTo12h:

    def test_midnight_and_noon(self):
        assert to_12h("00:00") == "12:00 AM"
        assert to_12h("12:00") == "12:00 PM"

    def test_afternoon_strips_leading_zero(self):
        assert to_12h("14:30") == "2:30 PM"
        assert to_12h("09:05") == "9:05 AM"

    def test_blank_or_invalid_is_empty(self):
        assert to_12h(None) == ""
        assert to_12h("") == ""
        assert to_12h("25:00") == ""
        assert to_12h(1430) == ""
