"""Pure chat identity and document helpers.

Chat access is account-based (``trip.user_ids``), but the name shown beside a message must be the
person that account represents inside this trip. A person can be either a top-level individual or
one linked row inside a family. Sender labels are snapshotted onto messages so later roster edits or
removal cannot make old history ambiguous.
"""

from typing import Optional

from utils.display_names import family_member_display_names, member_display_names
from utils.members import padded_family_member_ids


def resolve_chat_sender(trip: dict, user_id: str) -> Optional[dict]:
    top_level_names = member_display_names(trip.get("members", []))
    for member in trip.get("members", []):
        if member.get("kind") != "family":
            if member.get("user_id") == user_id:
                return {
                    "sender_person_id": member["id"],
                    "sender_name": top_level_names.get(member["id"], member.get("name") or "Member"),
                    "sender_family_id": None,
                    "sender_family_name": None,
                }
            continue

        names = family_member_display_names(member)
        person_ids = padded_family_member_ids(member)
        user_ids = member.get("family_member_user_ids") or []
        for index, linked_user_id in enumerate(user_ids):
            if linked_user_id != user_id or index >= len(names):
                continue
            return {
                "sender_person_id": person_ids[index],
                "sender_name": names[index],
                "sender_family_id": member["id"],
                "sender_family_name": top_level_names.get(
                    member["id"], member.get("name") or "Family"
                ),
            }
    return None


def public_chat_message(document: dict) -> dict:
    """Return the stable API/socket shape without Mongo's private id or deleted text."""
    message = {key: value for key, value in document.items() if key != "_id"}
    if message.get("deleted_at"):
        message["text"] = None
    else:
        message.setdefault("deleted_at", None)
    message.setdefault("edited_at", None)
    message.setdefault("sender_family_id", None)
    message.setdefault("sender_family_name", None)
    return message
