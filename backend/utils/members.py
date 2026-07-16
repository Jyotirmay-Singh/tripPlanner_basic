from typing import List, Optional, Tuple

from fastapi import HTTPException

from utils.common import gen_id
from utils.email_rules import normalize_email


def normalize_name(name: Optional[str]) -> str:
    if not name:
        return ""
    return " ".join(name.split())


def assign_family_member_ids(
    names: Optional[List[str]],
    provided_ids: Optional[List[Optional[str]]] = None,
    existing_ids: Optional[List[str]] = None,
) -> List[str]:
    """Stable ids parallel to a family's ``family_members`` names.

    - When the client SENT ``family_member_ids`` (``provided_ids`` not None), it is trusted per row:
      a real id is kept, a null/missing row gets a freshly minted id. (The new editor sends the
      existing id for retained rows so past expenses keep pointing at the same person.)
    - When the client did NOT send ids (legacy contract), existing ids are reused positionally
      (append-stable) and the tail is minted, so name-only edits don't churn ids.
    Duplicates/blank ids are always replaced with a fresh id so the array stays unique + full.
    """
    names = names or []
    client_sent = provided_ids is not None
    existing_ids = existing_ids or []
    out: List[str] = []
    used = set()
    for i in range(len(names)):
        pid = None
        if client_sent:
            pid = provided_ids[i] if i < len(provided_ids) else None
        elif i < len(existing_ids):
            pid = existing_ids[i]
        if not pid or pid in used:
            pid = gen_id()
        out.append(pid)
        used.add(pid)
    return out


def align_family_member_emails(
    names: Optional[List[str]],
    provided: Optional[List[Optional[str]]] = None,
    existing: Optional[List[Optional[str]]] = None,
) -> List[Optional[str]]:
    """Per-member (contact-only) emails parallel to a family's ``family_members`` names.

    Mirrors :func:`assign_family_member_ids`: when the client SENT ``family_member_emails``
    (``provided`` not None) it is trusted per row (normalized; blank -> None); otherwise existing
    emails are reused positionally so a name/id-only edit preserves them. The result is always the
    same length as ``names`` (missing rows -> None). Values are ``normalize_email``-d; the call site
    still runs ``assert_gmail`` + uniqueness before persisting.
    """
    names = names or []
    client_sent = provided is not None
    existing = existing or []
    out: List[Optional[str]] = []
    for i in range(len(names)):
        raw = None
        if client_sent:
            raw = provided[i] if i < len(provided) else None
        elif i < len(existing):
            raw = existing[i]
        out.append(normalize_email(raw))
    return out


def align_family_member_user_ids(
    new_ids: Optional[List[Optional[str]]],
    old_ids: Optional[List[Optional[str]]] = None,
    old_user_ids: Optional[List[Optional[str]]] = None,
) -> Tuple[List[Optional[str]], set]:
    """Per-member linked app-user ids (Phase 25) parallel to a family's ``family_member_ids``.

    Server-managed — a sub-member's ``user_id`` is written ONLY by the join/claim flow, never from a
    member create/update body. On a roster edit the ids array is rebuilt by
    :func:`assign_family_member_ids` (retained rows keep their id, new rows are minted); this carries
    each *surviving* id's linked user_id forward into the new order, and reports which user_ids
    VANISHED (a claimed member the edit dropped) so the caller can revoke their trip access.

    Returns ``(aligned, vanished)``: ``aligned`` is parallel to ``new_ids`` (None where the slot is
    unclaimed or a freshly-minted row); ``vanished`` is the set of previously-linked user_ids that no
    longer appear in the new roster.
    """
    new_ids = new_ids or []
    old_ids = old_ids or []
    old_user_ids = old_user_ids or []
    by_id = {oid: uid for oid, uid in zip(old_ids, old_user_ids) if oid and uid}
    aligned = [by_id.get(nid) for nid in new_ids]
    carried = {uid for uid in aligned if uid}
    vanished = {uid for uid in by_id.values() if uid not in carried}
    return aligned, vanished


def demote_family_entity_email(member: dict) -> Optional[dict]:
    """Phase 26 migration: move a family's ENTITY-level email + linked account onto a member slot.

    Historically a family could carry its own ``email`` (+ a linked ``user_id`` from an entity claim).
    Phase 26 makes an email identify a PERSON only, so a family must carry none. Given a family member
    doc that still has a non-empty entity ``email`` or ``user_id``, this aligns the parallel arrays to
    the roster, finds the FIRST member slot whose email AND linked-account are BOTH free (the entity
    email + account belong to ONE person, so they land together), moves the entity email -> that
    slot's ``family_member_emails`` and the entity account -> that slot's ``family_member_user_ids``,
    and nulls the entity ``email``/``user_id``. Returns the rewritten member doc, or ``None`` when there
    is nothing to move (already clean — so it is idempotent) or no free slot exists (the caller logs
    and leaves the row untouched). Pure and balance-neutral (never touches names/weights). Non-family
    members always return ``None``.
    """
    if member.get("kind") != "family":
        return None
    entity_email = normalize_email(member.get("email"))
    entity_uid = member.get("user_id") or None
    if not entity_email and not entity_uid:
        return None  # already clean — idempotent no-op
    names = member.get("family_members") or []
    ids = assign_family_member_ids(names, existing_ids=member.get("family_member_ids"))
    emails = align_family_member_emails(names, existing=member.get("family_member_emails"))
    uids, _ = align_family_member_user_ids(ids, ids, member.get("family_member_user_ids"))
    slot = next(
        (i for i in range(len(names))
         if not normalize_email(emails[i]) and not uids[i]),
        None,
    )
    if slot is None:
        return None  # no free member slot; caller logs and leaves the row as-is
    emails[slot] = entity_email
    uids[slot] = entity_uid
    return {
        **member,
        "family_member_ids": ids,
        "family_member_emails": emails,
        "family_member_user_ids": uids,
        "email": None,
        "user_id": None,
    }


def email_exists(members: list, email: Optional[str], exclude_id: Optional[str] = None) -> bool:
    target = normalize_email(email)
    if not target:
        return False
    for m in members:
        if exclude_id and m.get("id") == exclude_id:
            continue
        if normalize_email(m.get("email")) == target:
            return True
        # Per-member contact emails also occupy the trip's one-email space (Phase 24).
        for sub in (m.get("family_member_emails") or []):
            if normalize_email(sub) == target:
                return True
    return False


def assert_unique_email(members: list, email: Optional[str], exclude_id: Optional[str] = None) -> None:
    norm = normalize_email(email)
    if norm and email_exists(members, email, exclude_id):
        raise HTTPException(400, f"A member with email '{norm}' already exists in this trip")


def assert_unique_family_member_emails(emails: Optional[List[Optional[str]]]) -> None:
    """Reject an internal duplicate among a SINGLE family's per-member emails (blanks ignored).

    ``email_exists`` excludes the whole family entity via ``exclude_id`` on an edit round-trip, so it
    cannot catch two members of the *same* submitted roster sharing an email — this pure guard does.
    """
    seen = set()
    for e in (emails or []):
        norm = normalize_email(e)
        if not norm:
            continue
        if norm in seen:
            raise HTTPException(400, f"A member with email '{norm}' already exists in this trip")
        seen.add(norm)


# ---------- Phase 11: one gmail == at most one person per trip ----------
# A *stub* is a member that carries a linked ``email`` but is not yet tied to an app user
# (``user_id`` falsy). The helpers below resolve the stub that belongs to a joiner (by their
# OWN verified email), decide whether it has financial history, and gate whether it may be
# removed during a join-as-new. The pure variants take already-fetched lists so they unit-test
# without a server; the async wrappers do targeted Mongo queries (lazy ``database`` import, the
# same convention as ``services/reallocation.py``).

def find_own_stubs(members: list, caller_email: Optional[str]) -> list:
    """Unclaimed members whose linked email == the caller's own email (case-insensitive).

    Matching is done ONLY against the caller's own verified account email — never free text —
    so a joiner can only ever resolve to the stub that was created for them. Returns ``[]`` or
    ``[one]`` in normal data; ``>1`` indicates pre-existing duplicate-email rows (legacy data),
    which callers must surface and warn about, never auto-destroy.
    """
    target = normalize_email(caller_email)
    if not target:
        return []
    return [
        m for m in members
        if not m.get("user_id") and normalize_email(m.get("email")) == target
    ]


def find_own_sub_stub(members: list, caller_email: Optional[str]) -> Optional[dict]:
    """The first UNCLAIMED family sub-member whose contact email == the caller's OWN email (Phase 25).

    The per-member analogue of :func:`find_own_stubs`: it lets a joiner link their account to a
    *specific* family member, not just the whole family entity. Matching is only ever against the
    caller's own verified account email, and only a slot with no ``family_member_user_ids[i]`` yet is
    offered. Returns ``{family_id, family_name, member_id, member_index, member_name}`` for the sub
    slot (``member_id`` is the stable per-member id), or ``None``. Trip-wide email uniqueness
    guarantees at most one match across the entity + sub-member email space.
    """
    target = normalize_email(caller_email)
    if not target:
        return None
    for m in members:
        if m.get("kind") != "family":
            continue
        names = m.get("family_members") or []
        emails = m.get("family_member_emails") or []
        uids = m.get("family_member_user_ids") or []
        # Pad ids for legacy rows, parallel to services.member_breakdown.family_member_ids.
        ids = [str(x) for x in (m.get("family_member_ids") or [])]
        if len(ids) < len(names):
            fid = m.get("id", "")
            ids = ids + [f"{fid}:{i}" for i in range(len(ids), len(names))]
        for i, nm in enumerate(names):
            em = emails[i] if i < len(emails) else None
            claimed = uids[i] if i < len(uids) else None
            if not claimed and normalize_email(em) == target:
                return {
                    "family_id": m.get("id"),
                    "family_name": m.get("name"),
                    "member_id": ids[i] if i < len(ids) else f'{m.get("id", "")}:{i}',
                    "member_index": i,
                    "member_name": nm,
                }
    return None


def member_has_financial_history_in(member_id: str, expenses: list, settlements: list) -> bool:
    """True iff ``member_id`` is referenced by any of the given expense/settlement docs.

    "Financial history" = the id appears as an expense payer (``paid_by_member_id``), a split
    participant (``split_member_ids``), a ``family_participants`` key, or a ``weight_snapshots``
    key; OR as either side of a settlement (ANY status — a pending settlement still records a
    real obligation). Pure over already-fetched lists. Intentionally conservative: over-reporting
    only ever forces a non-destructive CLAIM, while under-reporting could delete referenced data,
    so the error is biased the safe way. For a family the entity id IS the id used in
    expenses/settlements, so checking that id covers the whole family.
    """
    for e in expenses:
        if e.get("paid_by_member_id") == member_id:
            return True
        if member_id in (e.get("split_member_ids") or []):
            return True
        if member_id in (e.get("family_participants") or {}):
            return True
        if member_id in (e.get("weight_snapshots") or {}):
            return True
    for s in settlements:
        if s.get("from_member_id") == member_id or s.get("to_member_id") == member_id:
            return True
    return False


def is_stub_removable(member: dict, caller_email: Optional[str], has_history: bool) -> bool:
    """The single gate for deleting a stub during a join-as-new.

    A stub may be removed ONLY when it is (1) unclaimed, (2) carries the caller's OWN email
    (case-insensitive), and (3) has no financial history. Every other case must fall back to a
    CLAIM (which never deletes anything), preserving all expense/settlement references.
    """
    if member.get("user_id"):
        return False
    if has_history:
        return False
    return normalize_email(member.get("email")) == normalize_email(caller_email)


async def member_has_financial_history(trip_id: str, member_id: str) -> bool:
    """Async wrapper over the trip's stored expenses/settlements (see the pure variant).

    Uses targeted ``count_documents(..., limit=1)`` queries instead of loading collections.
    ``member_id`` is a hyphen/hex UUID, safe to interpolate into the dotted field paths for the
    ``family_participants`` / ``weight_snapshots`` existence checks.
    """
    from database import db  # lazy: keep this module server-free for unit tests
    if await db.expenses.count_documents(
        {
            "trip_id": trip_id,
            "$or": [
                {"paid_by_member_id": member_id},
                {"split_member_ids": member_id},
                {f"family_participants.{member_id}": {"$exists": True}},
                {f"weight_snapshots.{member_id}": {"$exists": True}},
            ],
        },
        limit=1,
    ):
        return True
    return bool(
        await db.settlements.count_documents(
            {
                "trip_id": trip_id,
                "$or": [
                    {"from_member_id": member_id},
                    {"to_member_id": member_id},
                ],
            },
            limit=1,
        )
    )


async def assert_unique_email_in_trip(trip: dict, email: Optional[str],
                                      exclude_id: Optional[str] = None) -> None:
    """Reject ``email`` if it already belongs to anyone in this trip.

    Superset of :func:`assert_unique_email`: besides the cheap member-doc ``email`` check, it
    also rejects an email matching a CLAIMED app user's *account* email — the case where a stub
    email collides with someone who joined without their account email being stamped onto a
    member row. ``exclude_id`` (the member being edited) also excludes that member's own linked
    account so a self-update never trips the check. ``assert_gmail`` is still expected to run
    BEFORE this at every call site.
    """
    norm = normalize_email(email)
    if not norm:
        return
    members = trip.get("members", [])
    # 1) cheap, pure member-doc check (identical behavior + message to assert_unique_email)
    if email_exists(members, norm, exclude_id):
        raise HTTPException(400, f"A member with email '{norm}' already exists in this trip")
    # 2) claimed app users' ACCOUNT emails (db.users stores email normalized at register/google)
    from database import db  # lazy: keep this module server-free for unit tests
    excluded = next((m for m in members if m.get("id") == exclude_id), None)
    excluded_uids = set()
    if excluded:
        if excluded.get("user_id"):
            excluded_uids.add(excluded["user_id"])
        # Phase 25: a family can hold several linked accounts (entity + per-member); exclude them ALL
        # so its own sub-member emails don't collide with its own linked accounts on an edit round-trip.
        excluded_uids.update(u for u in (excluded.get("family_member_user_ids") or []) if u)
    uids = [u for u in trip.get("user_ids", []) if u not in excluded_uids]
    if uids and await db.users.count_documents(
        {"id": {"$in": uids}, "email": norm}, limit=1
    ):
        raise HTTPException(400, f"A member with email '{norm}' already exists in this trip")
