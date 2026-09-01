from decimal import Decimal, InvalidOperation
from typing import Literal, Optional

from pydantic import BaseModel, field_validator, model_validator


ExchangeRateMode = Literal["automatic", "manual"]
ManualInputType = Literal["rate", "target_amount"]


def finite_decimal(value, *, label: str, allow_negative: bool = True) -> Decimal:
    """Parse JSON number/string input without introducing a binary-float arithmetic boundary."""
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError(f"{label} must be a number")
    if not parsed.is_finite():
        raise ValueError(f"{label} must be finite")
    if not allow_negative and parsed <= 0:
        raise ValueError(f"{label} must be greater than zero")
    return parsed


class ConversionRequest(BaseModel):
    mode: ExchangeRateMode = "automatic"
    quote_id: Optional[str] = None
    approved: bool = False
    allow_stale: bool = False
    manual_input_type: Optional[ManualInputType] = None
    manual_rate: Optional[Decimal] = None
    manual_target_amount: Optional[Decimal] = None

    @field_validator("manual_rate", "manual_target_amount", mode="before")
    @classmethod
    def _positive_decimal(cls, value, info):
        if value is None:
            return None
        return finite_decimal(value, label=info.field_name.replace("_", " "), allow_negative=False)

    @model_validator(mode="after")
    def _validate_mode(self):
        if self.mode == "automatic":
            if self.manual_input_type or self.manual_rate is not None or self.manual_target_amount is not None:
                raise ValueError("Automatic conversion cannot include manual inputs")
            return self
        if self.manual_input_type == "rate":
            if self.manual_rate is None or self.manual_target_amount is not None:
                raise ValueError("Manual rate conversion requires only manual_rate")
        elif self.manual_input_type == "target_amount":
            if self.manual_target_amount is None or self.manual_rate is not None:
                raise ValueError("Manual final amount conversion requires only manual_target_amount")
        else:
            raise ValueError("Manual conversion requires manual_input_type")
        return self


class ReconvertIn(BaseModel):
    quote_id: str
    expected_conversion_version: int
    approved: bool = False
    allow_stale: bool = False
    force: bool = False
