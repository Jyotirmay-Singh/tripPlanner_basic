import pytest

from config import SUPER_ADMIN_EMAIL
from utils.upi_attempt_permissions import (
    can_initiate_upi_attempt,
    can_inspect_upi_recipient_details,
    can_review_upi_attempt,
    can_update_upi_attempt_as_sender,
    can_view_upi_attempt,
    has_full_upi_attempt_admin_access,
    reviewable_upi_recipient_ids,
)


TRIP = {
    "owner_id": "owner-user",
    "admin_ids": ["owner-user", "admin-user"],
    "user_ids": [
        "owner-user",
        "admin-user",
        "payer-user",
        "payer-user-2",
        "recipient-user",
        "recipient-user-2",
        "unrelated-user",
    ],
    "members": [
        {
            "id": "payer",
            "kind": "family",
            "family_member_user_ids": ["payer-user", "payer-user-2"],
        },
        {
            "id": "recipient",
            "kind": "family",
            "family_member_user_ids": ["recipient-user", "recipient-user-2"],
        },
    ],
}
ATTEMPT = {
    "initiating_payer_user_id": "payer-user",
    "from_member_id": "payer",
    "to_member_id": "recipient",
}


@pytest.mark.parametrize(
    "user,expected",
    [
        ({"id": "payer-user"}, (True, True, True, False, True, False)),
        ({"id": "payer-user-2"}, (True, True, False, False, False, False)),
        ({"id": "recipient-user"}, (False, False, False, True, True, False)),
        ({"id": "recipient-user-2"}, (False, False, False, True, True, False)),
        ({"id": "owner-user"}, (True, False, False, True, True, True)),
        ({"id": "admin-user"}, (True, False, False, True, True, True)),
        (
            {"id": "root-user", "email": SUPER_ADMIN_EMAIL, "role": "super_admin"},
            (True, False, False, True, True, True),
        ),
        ({"id": "unrelated-user"}, (False, False, False, False, False, False)),
        ({"id": "outsider-user"}, (False, False, False, False, False, False)),
    ],
    ids=[
        "initiating-payer",
        "other-payer-family-account",
        "selected-recipient",
        "other-recipient-family-account",
        "owner",
        "admin",
        "super-admin",
        "unrelated-member",
        "outsider",
    ],
)
def test_upi_attempt_permission_matrix(user, expected):
    actual = (
        can_inspect_upi_recipient_details(TRIP, "payer", user),
        can_initiate_upi_attempt(TRIP, "payer", user),
        can_update_upi_attempt_as_sender(ATTEMPT, user),
        can_review_upi_attempt(TRIP, "recipient", user),
        can_view_upi_attempt(TRIP, ATTEMPT, user),
        has_full_upi_attempt_admin_access(TRIP, user),
    )
    assert actual == expected
    if expected[-1]:
        expected_recipient_ids = ["payer", "recipient"]
    elif user["id"].startswith("payer-user"):
        expected_recipient_ids = ["payer"]
    elif user["id"].startswith("recipient-user"):
        expected_recipient_ids = ["recipient"]
    else:
        expected_recipient_ids = []
    assert reviewable_upi_recipient_ids(TRIP, user) == expected_recipient_ids
