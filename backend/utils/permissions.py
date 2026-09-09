"""Canonical Owner / Admin / Member role layer (Step 23).

Single source of truth for the trip access matrix. These are PURE functions: they
operate on an already-fetched trip dict and never touch the database, so they can be
reused by routes, by the deps.py FastAPI guards, and by unit tests. The DB-touching
guards (``_trip_admin_or_403`` / ``_trip_owner_or_403``) live in utils/deps.py.

The three trip-scoped tiers come straight off the trip document:
  - owner   -> trip["owner_id"]            (the creator / root admin)
  - admin   -> trip["admin_ids"]           (owner is always seeded in here)
  - member  -> trip["user_ids"]            (anyone with access to the trip)

Owner supersedes admin: the owner is also in ``admin_ids`` but ``role_of`` reports
``"owner"`` for them. The application ``super_admin`` is an authenticated, server-verified
identity above those trip roles and does not need to appear in a trip's membership arrays.
"""
from typing import Literal, Optional, Union

from config import SUPER_ADMIN_EMAIL

Role = Literal["super_admin", "owner", "admin", "member"]
Viewer = Optional[Union[str, dict]]


def viewer_id(viewer: Viewer) -> Optional[str]:
    if isinstance(viewer, dict):
        value = viewer.get("id")
        return str(value) if value else None
    return str(viewer) if viewer else None


def is_super_admin(viewer: Viewer) -> bool:
    """Return True only for the server-promoted, exact application operator account."""
    if not isinstance(viewer, dict):
        return False
    email = str(viewer.get("email") or "").strip().lower()
    return email == SUPER_ADMIN_EMAIL and viewer.get("role") == "super_admin"


def role_of(trip: dict, viewer: Viewer) -> Optional[Role]:
    """Return the viewer's effective role on the trip, or None when access is absent.

    Uses ``.get()`` throughout so legacy documents missing ``owner_id`` /
    ``admin_ids`` / ``user_ids`` degrade gracefully instead of raising. A falsy
    viewer id (None / "") is never on a trip.
    """
    if is_super_admin(viewer):
        return "super_admin"
    user_id = viewer_id(viewer)
    if not user_id:
        return None
    if user_id == trip.get("owner_id"):
        return "owner"
    if user_id in trip.get("admin_ids", []):
        return "admin"
    if user_id in trip.get("user_ids", []):
        return "member"
    return None


def can_view(trip: dict, viewer: Viewer) -> bool:
    return role_of(trip, viewer) is not None


def can_manage_members(trip: dict, viewer: Viewer) -> bool:
    return role_of(trip, viewer) in ("super_admin", "owner", "admin")


def can_edit_trip_settings(trip: dict, viewer: Viewer) -> bool:
    return role_of(trip, viewer) in ("super_admin", "owner", "admin")


def can_modify_any_expense(trip: dict, viewer: Viewer) -> bool:
    # creator-or-admin for a *specific* expense stays in deps.can_modify_expense;
    # this is the blanket "may touch any expense" capability of owner/admin.
    return role_of(trip, viewer) in ("super_admin", "owner", "admin")


def can_manage_admins(trip: dict, viewer: Viewer) -> bool:
    return role_of(trip, viewer) in ("super_admin", "owner")


def can_transfer_ownership(trip: dict, viewer: Viewer) -> bool:
    return role_of(trip, viewer) in ("super_admin", "owner")


def can_delete_trip(trip: dict, viewer: Viewer) -> bool:
    return role_of(trip, viewer) in ("super_admin", "owner")


def can_record_payment(trip: dict, to_member_id: Optional[str], viewer: Viewer) -> bool:
    # Phase 20: a payment along a suggested debtor->creditor pair may be recorded/edited/deleted only
    # by a trip admin (owner is always seeded into admin_ids) or by the RECEIVER — the app user linked
    # to the creditor member (to_member_id). The payer can never self-record their own debt as paid.
    # Mirrors can_mark_settlement_paid (Phase 10) but is parametrized on the creditor member id so the
    # POST path (member id from the body) and the PATCH/DELETE path (id from the stored doc) share it.
    if role_of(trip, viewer) in ("super_admin", "owner", "admin"):
        return True
    user_id = viewer_id(viewer)
    receiver = next((m for m in trip.get("members", []) if m["id"] == to_member_id), None)
    if not receiver:
        return False
    if receiver.get("kind") == "family":
        return user_id in (receiver.get("family_member_user_ids") or [])
    return receiver.get("user_id") == user_id
