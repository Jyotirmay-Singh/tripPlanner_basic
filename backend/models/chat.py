from uuid import UUID

from pydantic import BaseModel, Field, field_validator


def _clean_message_text(value: str) -> str:
    text = (value or "").strip()
    if not text:
        raise ValueError("Message cannot be empty")
    if len(text) > 2000:
        raise ValueError("Message must be 2,000 characters or fewer")
    return text


class ChatMessageCreate(BaseModel):
    """A durable text message. The client id makes explicit retries idempotent."""

    client_message_id: UUID
    text: str

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return _clean_message_text(value)


class ChatMessagePatch(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return _clean_message_text(value)


class ChatReadIn(BaseModel):
    through_sequence: int = Field(ge=1)
