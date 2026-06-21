from typing import Optional

from pydantic import BaseModel, Field, EmailStr


class RegisterIn(BaseModel):
    email: EmailStr
    pin: str = Field(min_length=4, max_length=4)
    name: str = Field(min_length=1)
    password: str = Field(min_length=1)  # required; length rule (>=9) enforced in route


class LoginIn(BaseModel):
    email: EmailStr
    password: Optional[str] = None
    pin: Optional[str] = None


class ForgotIn(BaseModel):
    email: EmailStr


class ResetPinIn(BaseModel):
    token: str
    new_pin: str = Field(min_length=4, max_length=4)


class ResetPinByPasswordIn(BaseModel):
    email: EmailStr
    password: str
    new_pin: str = Field(min_length=4, max_length=4)


class GoogleAuthIn(BaseModel):
    id_token: str
