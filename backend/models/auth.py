from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, EmailStr, field_validator

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
