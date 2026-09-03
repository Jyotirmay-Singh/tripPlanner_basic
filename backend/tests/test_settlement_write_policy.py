from decimal import Decimal

import pytest
from fastapi import HTTPException

from utils import settlement_gate


@pytest.fixture(autouse=True)
def enabled(monkeypatch):
    monkeypatch.setattr(settlement_gate, "WHOLE_UNIT_SETTLEMENTS_ENABLED", True)


@pytest.mark.parametrize("currency", ["LKR", "NPR", "lkr"])
def test_enabled_rupee_currencies_accept_only_whole_new_amounts(currency):
    amount, audit = settlement_gate.validate_new_amount({"currency": currency}, "1250")
    assert amount == Decimal("1250")
    assert audit == {"settlement_policy_version": "whole_unit_v1", "settlement_increment": "1"}
    with pytest.raises(HTTPException) as error:
        settlement_gate.validate_new_amount({"currency": currency}, "1249.67")
    assert error.value.status_code == 400
    assert "whole-rupee" in error.value.detail


def test_other_currencies_and_disabled_flag_retain_decimal_compatibility(monkeypatch):
    amount, audit = settlement_gate.validate_new_amount({"currency": "INR"}, "10.25")
    assert amount == Decimal("10.25") and audit == {}
    monkeypatch.setattr(settlement_gate, "WHOLE_UNIT_SETTLEMENTS_ENABLED", False)
    amount, audit = settlement_gate.validate_new_amount({"currency": "LKR"}, "10.25")
    assert amount == Decimal("10.25") and audit == {}


def test_whole_unit_payable_comparison_has_no_cent_overpayment_tolerance():
    assert settlement_gate.payable_tolerance({"currency": "LKR"}) == Decimal("0")
    assert settlement_gate.payable_tolerance({"currency": "INR"}) == Decimal("0.01")
