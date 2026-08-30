import pytest
from fastapi import HTTPException

from models.trip import TripIn
from utils.date_rules import assert_valid_range, ensure_date_range


class TestOptionalTripDates:

    def test_create_model_does_not_require_dates(self):
        trip = TripIn(name="No dates")
        assert trip.start_date is None
        assert trip.end_date is None

    def test_both_dates_may_be_omitted(self):
        assert assert_valid_range(None, None) == (None, None)
        assert assert_valid_range("", "   ") == (None, None)

    @pytest.mark.parametrize(
        ("start", "end", "expected"),
        [
            ("2026-12-11", None, ("2026-12-11", None)),
            (None, "2026-12-21", (None, "2026-12-21")),
            (" 2026-12-11 ", "2026-12-21", ("2026-12-11", "2026-12-21")),
        ],
    )
    def test_supplied_dates_are_independently_validated_and_normalized(
        self, start, end, expected
    ):
        assert assert_valid_range(start, end) == expected

    def test_invalid_supplied_date_is_rejected(self):
        with pytest.raises(HTTPException) as exc_info:
            assert_valid_range("2026-02-31", None)
        assert exc_info.value.status_code == 400

    def test_end_before_start_is_rejected_when_both_are_supplied(self):
        with pytest.raises(HTTPException) as exc_info:
            assert_valid_range("2026-12-21", "2026-12-11")
        assert exc_info.value.status_code == 400

    def test_explicitly_omitted_end_is_preserved_on_read(self):
        trip = {"start_date": "2026-12-11", "end_date": None}
        assert ensure_date_range(trip)["end_date"] is None

    def test_legacy_missing_end_still_defaults_to_start(self):
        trip = {"start_date": "2026-12-11"}
        assert ensure_date_range(trip)["end_date"] == "2026-12-11"
