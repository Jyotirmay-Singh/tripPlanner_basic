import pytest
from pydantic import ValidationError

from models.chat import ChatMessageCreate, ChatMessagePatch
from services.chat import public_chat_message, resolve_chat_sender


def test_resolves_disambiguated_standalone_trip_identity():
    trip = {
        "members": [
            {"id": "m1", "name": "Ravi", "kind": "individual", "user_id": "u1"},
            {"id": "m2", "name": "Ravi", "kind": "individual", "user_id": "u2"},
        ]
    }

    assert resolve_chat_sender(trip, "u2") == {
        "sender_person_id": "m2",
        "sender_name": "Ravi_2",
        "sender_family_id": None,
        "sender_family_name": None,
    }


def test_resolves_exact_family_sub_member_with_family_context():
    trip = {
        "members": [
            {
                "id": "family",
                "name": "Sharma Family",
                "kind": "family",
                "family_members": ["Ravi", "Priya"],
                "family_member_ids": ["p1", "p2"],
                "family_member_user_ids": [None, "u2"],
            }
        ]
    }

    assert resolve_chat_sender(trip, "u2") == {
        "sender_person_id": "p2",
        "sender_name": "Priya",
        "sender_family_id": "family",
        "sender_family_name": "Sharma Family",
    }


def test_access_without_a_linked_person_has_no_sender_identity():
    assert resolve_chat_sender({"user_ids": ["legacy"], "members": []}, "legacy") is None


def test_deleted_public_message_never_exposes_original_text():
    public = public_chat_message(
        {"_id": "mongo", "id": "x", "text": "secret", "deleted_at": "2026-01-01T00:00:00Z"}
    )
    assert "_id" not in public
    assert public["text"] is None


def test_message_models_trim_text_and_keep_multiline_content():
    body = ChatMessageCreate(
        client_message_id="12345678-1234-5678-1234-567812345678",
        text="  Meet at 8\nby the lobby  ",
    )
    assert body.text == "Meet at 8\nby the lobby"
    assert ChatMessagePatch(text=" updated ").text == "updated"


@pytest.mark.parametrize("text", ["", "   ", "x" * 2001])
def test_message_models_reject_empty_or_oversized_text(text):
    with pytest.raises(ValidationError):
        ChatMessagePatch(text=text)
