"""International mobile-number validation and canonicalization."""

from typing import Tuple

import phonenumbers
from phonenumbers import NumberParseException, PhoneNumberFormat, PhoneNumberType


INVALID_MOBILE_MESSAGE = "Enter a valid mobile number for the selected country"
FIXED_LINE_MESSAGE = "Enter a mobile number, not a fixed-line number"


def normalize_mobile_number(value: str, country_code: str) -> Tuple[str, str]:
    """Return an E.164 number and ISO-3166 alpha-2 region.

    `FIXED_LINE_OR_MOBILE` is intentionally accepted because numbering plans in several
    countries cannot distinguish the two without carrier data. Known fixed lines are rejected.
    """

    country = (country_code or "").strip().upper()
    if len(country) != 2 or country not in phonenumbers.SUPPORTED_REGIONS:
        raise ValueError("Select a valid mobile-number country")

    raw = (value or "").strip()
    if not raw:
        raise ValueError(INVALID_MOBILE_MESSAGE)
    try:
        parsed = phonenumbers.parse(raw, country)
    except NumberParseException as exc:
        raise ValueError(INVALID_MOBILE_MESSAGE) from exc

    if parsed.extension or not phonenumbers.is_possible_number(parsed) \
            or not phonenumbers.is_valid_number(parsed):
        raise ValueError(INVALID_MOBILE_MESSAGE)

    number_type = phonenumbers.number_type(parsed)
    if number_type == PhoneNumberType.FIXED_LINE:
        raise ValueError(FIXED_LINE_MESSAGE)
    if number_type not in {PhoneNumberType.MOBILE, PhoneNumberType.FIXED_LINE_OR_MOBILE}:
        raise ValueError(INVALID_MOBILE_MESSAGE)

    # An international paste can identify a more precise region than the picker (notably
    # shared calling-code plans). Store that authoritative region when libphonenumber has one.
    parsed_country = phonenumbers.region_code_for_number(parsed)
    normalized_country = parsed_country if parsed_country in phonenumbers.SUPPORTED_REGIONS else country
    return phonenumbers.format_number(parsed, PhoneNumberFormat.E164), normalized_country
