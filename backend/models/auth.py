from pydantic import BaseModel, ConfigDict, Field, EmailStr


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
