"""Authorization policy for UPI handoff attempts.

UPI attempts carry a recipient UPI snapshot and an optional payer-entered reference, so their
visibility is intentionally narrower than the ordinary payment ledger.  Keep this policy separate
from ``can_record_payment``: changing manual-payment permissions must never silently widen access to
UPI attempt details or recipient-review actions.
"""

from typing import Optional

from utils.permissions import is_linked_to_member, role_of, viewer_id


def _member(trip: dict, member_id: Optional[str]) -> Optional[dict]:
    return next(
        (candidate for candidate in trip.get("members", []) if candidate.get("id") == member_id),
        None,
    )


def has_full_upi_attempt_admin_access(trip: dict, viewer) -> bool:
    """Owners, trip admins and the application super-admin may review every attempt."""

    return role_of(trip, viewer) in ("super_admin", "owner", "admin")


def can_initiate_upi_attempt(
    trip: dict,
    from_member_id: Optional[str],
    viewer,
) -> bool:
    """Only an account currently linked to the recommended payer may create a handoff."""

    return is_linked_to_member(_member(trip, from_member_id), viewer)


def can_inspect_upi_recipient_details(
    trip: dict,
    from_member_id: Optional[str],
    viewer,
) -> bool:
    """Fresh recipient UPI details are visible to the payer and authorized administrators."""

    return (
        has_full_upi_attempt_admin_access(trip, viewer)
        or can_initiate_upi_attempt(trip, from_member_id, viewer)
    )


def can_update_upi_attempt_as_sender(attempt: dict, viewer) -> bool:
    """Payer-family membership is not transferable: only the initiating account is the sender."""

    return viewer_id(viewer) == attempt.get("initiating_payer_user_id")


def can_review_upi_attempt(
    trip: dict,
    to_member_id: Optional[str],
    viewer,
) -> bool:
    """Receiving-family accounts and authorized administrators may perform recipient review."""

    if has_full_upi_attempt_admin_access(trip, viewer):
        return True
    return is_linked_to_member(_member(trip, to_member_id), viewer)


def can_view_upi_attempt(trip: dict, attempt: dict, viewer) -> bool:
    """Full attempt details are visible only to its exact sender or an authorized reviewer."""

    return (
        can_update_upi_attempt_as_sender(attempt, viewer)
        or can_review_upi_attempt(trip, attempt.get("to_member_id"), viewer)
    )


def reviewable_upi_recipient_ids(trip: dict, viewer) -> list[str]:
    """Return destination member ids whose incoming attempt details the viewer may list."""

    return [
        member["id"]
        for member in trip.get("members", [])
        if member.get("id") and can_review_upi_attempt(trip, member.get("id"), viewer)
    ]
