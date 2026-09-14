from decimal import Decimal

import pytest
from fastapi import HTTPException

from utils import settlement_gate


@pytest.mark.parametrize("currency", ["LKR", "NPR", "lkr", "INR", "USD", "JPY", "KWD"])
def test_every_currency_normalizes_old_client_decimals_to_whole_new_amounts(currency):
    amount, audit = settlement_gate.validate_new_amount({"currency": currency}, "1250")
    assert amount == Decimal("1250")
    assert audit == {
        "settlement_policy_version": "whole_unit_v1",
        "settlement_increment": "1",
        "money_policy_version": "whole_unit_v1",
    }
    rounded, _audit = settlement_gate.validate_new_amount({"currency": currency}, "1249.67")
    assert rounded == Decimal("1250")


def test_nonzero_value_that_rounds_to_zero_has_structured_response():
    with pytest.raises(HTTPException) as error:
        settlement_gate.validate_new_amount({"currency": "USD"}, "0.49")
    assert error.value.status_code == 422
    assert error.value.detail["code"] == "amount_rounds_to_zero"
    assert error.value.detail["money_policy_version"] == "whole_unit_v1"


def test_whole_unit_payable_comparison_has_no_cent_overpayment_tolerance():
    assert settlement_gate.payable_tolerance({"currency": "LKR"}) == Decimal("0")
    assert settlement_gate.payable_tolerance({"currency": "INR"}) == Decimal("0")
    assert settlement_gate.payable_tolerance({"currency": "JPY"}) == Decimal("0")
    assert settlement_gate.payable_tolerance({"currency": "KWD"}) == Decimal("0")
