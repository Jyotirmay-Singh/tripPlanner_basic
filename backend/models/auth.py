from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, EmailStr, field_validator, model_validator

from utils.mobile_numbers import normalize_mobile_number
from utils.upi_rules import normalize_upi_id


class RegisterIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    name: str = Field(min_length=1)
    password: str = Field(min_length=1)  # required; length rule (>=9) enforced in route


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    password: str


class GoogleAuthIn(BaseModel):
    id_token: str


class VerifyEmailIn(BaseModel):
    token: str


class RequestPasswordResetIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str
    new_password: str = Field(min_length=1)  # length rule (>=9) enforced in route


class SetCredentialsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str = Field(min_length=1)  # length rule (>=9) enforced in route


class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=1)  # length rule (>=9) enforced in route


class UpiProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required in the PATCH body. Explicit null removes a saved UPI ID.
    upi_id: Optional[str]

    @field_validator("upi_id", mode="before")
    @classmethod
    def validate_upi_id(cls, value):
        if value is None:
            return None
        return normalize_upi_id(value)


class MobileProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Both fields are required in the PATCH body. Explicit null for both removes the number.
    mobile_number: Optional[str]
    mobile_country_code: Optional[str]

    @model_validator(mode="after")
    def validate_mobile(self):
        if (self.mobile_number is None) != (self.mobile_country_code is None):
            raise ValueError("Mobile number and country are required together")
        if self.mobile_number is None:
            return self
        number, country = normalize_mobile_number(
            self.mobile_number, self.mobile_country_code or ""
        )
        self.mobile_number = number
        self.mobile_country_code = country
        return self
