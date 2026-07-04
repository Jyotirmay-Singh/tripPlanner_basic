"""Canonical Owner / Admin / Member role layer (Step 23).

Single source of truth for the trip access matrix. These are PURE functions: they
operate on an already-fetched trip dict and never touch the database, so they can be
reused by routes, by the deps.py FastAPI guards, and by unit tests. The DB-touching
guards (``_trip_admin_or_403`` / ``_trip_owner_or_403``) live in utils/deps.py.

The three tiers come straight off the trip document:
  - owner   -> trip["owner_id"]            (the creator / root admin)
  - admin   -> trip["admin_ids"]           (owner is always seeded in here)
  - member  -> trip["user_ids"]            (anyone with access to the trip)

Owner supersedes admin: the owner is also in ``admin_ids`` but ``role_of`` reports
``"owner"`` for them.
"""
from typing import Literal, Optional

Role = Literal["owner", "admin", "member"]


def role_of(trip: dict, user_id: Optional[str]) -> Optional[Role]:
    """Return the user's role on the trip, or None if they are not on it.

    Uses ``.get()`` throughout so legacy documents missing ``owner_id`` /
    ``admin_ids`` / ``user_ids`` degrade gracefully instead of raising. A falsy
    ``user_id`` (None / "") is never on a trip.
    """
    if not user_id:
        return None
    if user_id == trip.get("owner_id"):
        return "owner"
    if user_id in trip.get("admin_ids", []):
        return "admin"
    if user_id in trip.get("user_ids", []):
        return "member"
    return None


def can_view(trip: dict, user_id: Optional[str]) -> bool:
    return role_of(trip, user_id) is not None


def can_manage_members(trip: dict, user_id: Optional[str]) -> bool:
    return role_of(trip, user_id) in ("owner", "admin")


def can_edit_trip_settings(trip: dict, user_id: Optional[str]) -> bool:
    return role_of(trip, user_id) in ("owner", "admin")


def can_modify_any_expense(trip: dict, user_id: Optional[str]) -> bool:
    # creator-or-admin for a *specific* expense stays in deps.can_modify_expense;
    # this is the blanket "may touch any expense" capability of owner/admin.
    return role_of(trip, user_id) in ("owner", "admin")


def can_manage_admins(trip: dict, user_id: Optional[str]) -> bool:
    return role_of(trip, user_id) == "owner"


def can_transfer_ownership(trip: dict, user_id: Optional[str]) -> bool:
    return role_of(trip, user_id) == "owner"


def can_delete_trip(trip: dict, user_id: Optional[str]) -> bool:
    return role_of(trip, user_id) == "owner"


def can_record_payment(trip: dict, to_member_id: Optional[str], user_id: Optional[str]) -> bool:
    # Phase 20: a payment along a suggested debtor->creditor pair may be recorded/edited/deleted only
    # by a trip admin (owner is always seeded into admin_ids) or by the RECEIVER — the app user linked
    # to the creditor member (to_member_id). The payer can never self-record their own debt as paid.
    # Mirrors can_mark_settlement_paid (Phase 10) but is parametrized on the creditor member id so the
    # POST path (member id from the body) and the PATCH/DELETE path (id from the stored doc) share it.
    if role_of(trip, user_id) in ("owner", "admin"):
        return True
    receiver = next((m for m in trip.get("members", []) if m["id"] == to_member_id), None)
    return bool(receiver and receiver.get("user_id") == user_id)
