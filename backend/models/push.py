import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator


_EXPO_TOKEN_RE = re.compile(r"^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]+\]$")


class PushDeviceUpsert(BaseModel):
    """The public registration shape used by an authenticated Android installation."""

    token: str = Field(min_length=20, max_length=256)
    platform: Literal["android"]

    @field_validator("token")
    @classmethod
    def validate_expo_token(cls, value: str) -> str:
        token = value.strip()
        if not _EXPO_TOKEN_RE.fullmatch(token):
            raise ValueError("token must be a valid Expo push token")
        return token
