from typing import Optional

from pydantic import BaseModel, Field, EmailStr


class RegisterIn(BaseModel):
    email: EmailStr
    pin: str = Field(min_length=4, max_length=4)
    name: str = Field(min_length=1)
    password: Optional[str] = None  # legacy, optional


class LoginIn(BaseModel):
    email: EmailStr
    password: Optional[str] = None
    pin: Optional[str] = None


class ForgotIn(BaseModel):
    email: EmailStr


class ResetPinIn(BaseModel):
    token: str
    new_pin: str = Field(min_length=4, max_length=4)
