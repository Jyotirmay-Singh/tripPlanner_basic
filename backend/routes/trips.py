import logging

from fastapi import APIRouter, HTTPException, Depends

from database import db
from models.trip import TripIn, TripUpdate, AdminGrant, OwnershipTransfer
from models.join import JoinRequest, JoinPreviewRequest
from utils.common import gen_id, gen_trip_code, now_utc
from utils.date_rules import assert_valid_range, ensure_date_range
from utils.deps import get_current_user, _trip_or_404, _trip_admin_or_403, _trip_owner_or_403
from utils.email_rules import assert_gmail, normalize_email
from utils.members import (
    assert_unique_email_in_trip,
    assign_family_member_ids,
    find_own_stubs,
    find_own_sub_stub,
    member_has_financial_history,
    padded_family_member_ids,
)

router = APIRouter()
logger = logging.getLogger(__name__)


# ---------- Trips ----------
def _build_owner_member(body: TripIn, user) -> dict:
    """The creator's own member doc. Phase 26: individual (default, full back-compat) OR one member
    inside a family the creator sets up here. In the family case the creator's login email + account
    attach to a SINGLE member slot (self_index); the family entity itself carries NO email/user_id
    (emails identify a person, never a family)."""
    if body.self_kind == "family":
        names = [n.strip() for n in (body.family_members or []) if n and n.strip()]
        if not (body.family_name or "").strip():
            raise HTTPException(400, "Family name is required")
        if not names:
            raise HTTPException(400, "Add at least one family member")
        idx = body.self_index if body.self_index is not None else 0
        if idx < 0 or idx >= len(names):
            raise HTTPException(400, "self_index is out of range")
        emails = [None] * len(names)
        uids = [None] * len(names)
        emails[idx] = user["email"]
        uids[idx] = user["id"]
        return {
            "id": gen_id(), "name": body.family_name.strip(), "kind": "family",
            "family_members": names,
            "family_member_ids": assign_family_member_ids(names),
            "family_member_emails": emails,
            "family_member_user_ids": uids,
            "email": None, "user_id": None,
        }
    # Individual (default): the creator is a standalone member carrying their own login email/account.
    return {
        "id": gen_id(), "name": user["name"], "kind": "individual",
        "family_members": [], "email": user["email"], "user_id": user["id"],
    }


@router.post("/trips")
async def create_trip(body: TripIn, user=Depends(get_current_user)):
    # Calendar dates are stored as 'YYYY-MM-DD'; reject impossible dates and end-before-start.
    assert_valid_range(body.start_date, body.end_date)
    tid = gen_id()
    code = gen_trip_code()
    while await db.trips.find_one({"code": code}):
        code = gen_trip_code()
    # Create the owner's member automatically. Phase 26: the creator declares whether they're a
    # standalone individual (default, legacy behavior) or ONE member inside a family they set up here.
    owner_member = _build_owner_member(body, user)
    doc = {
        "id": tid, "code": code, "name": body.name,
        "start_date": body.start_date.strip(), "end_date": body.end_date.strip(),
        "budget": body.budget, "currency": body.currency or "INR",
        "owner_id": user["id"], "user_ids": [user["id"]],
        "admin_ids": [user["id"]],
        "members": [owner_member],
        "created_at": now_utc().isoformat(),
        # Optimistic-concurrency counter for the payment-write guard (Phase 20 BUG-2 fix).
        "version": 0,
    }
    await db.trips.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/trips")
async def list_trips(user=Depends(get_current_user)):
    cur = db.trips.find({"user_ids": user["id"]}, {"_id": 0}).sort("created_at", -1)
    trips = await cur.to_list(500)
    return [ensure_date_range(t) for t in trips]


@router.get("/trips/{trip_id}")
async def get_trip(trip_id: str, user=Depends(get_current_user)):
    return ensure_date_range(await _trip_or_404(trip_id, user["id"]))


@router.patch("/trips/{trip_id}")
async def update_trip(trip_id: str, body: TripUpdate, user=Depends(get_current_user)):
    # Step 23: editing trip settings is an Owner/Admin capability; a plain member is rejected.
    trip = await _trip_admin_or_403(trip_id, user["id"])
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    # If either date is changing, validate the resulting range against the existing values.
    if "start_date" in updates or "end_date" in updates:
        existing = ensure_date_range(dict(trip))
        new_start = updates.get("start_date", existing.get("start_date"))
        new_end = updates.get("end_date", existing.get("end_date"))
        assert_valid_range(new_start, new_end)
        if "start_date" in updates:
            updates["start_date"] = updates["start_date"].strip()
        if "end_date" in updates:
            updates["end_date"] = updates["end_date"].strip()
    if updates:
        await db.trips.update_one({"id": trip_id}, {"$set": updates})
    return ensure_date_range(await db.trips.find_one({"id": trip_id}, {"_id": 0}))


@router.delete("/trips/{trip_id}")
async def delete_trip(trip_id: str, user=Depends(get_current_user)):
    # Step 23: deleting a trip is owner-only (the shared role guard enforces it).
    await _trip_owner_or_403(trip_id, user["id"])
    await db.trips.delete_one({"id": trip_id})
    await db.expenses.delete_many({"trip_id": trip_id})
    await db.settlements.delete_many({"trip_id": trip_id})
    return {"ok": True}


async def _claim_member(trip, members, user, user_email, body):
    """action='claim': self-serve link of the caller to an existing member carrying the
    caller's OWN verified email. Keeps the member id (preserving every expense/settlement
    reference) and never recalculates a family's split (matches the §5 "App User Identity
    Mapping" rule). Idempotent; atomic against a concurrent claim of the same row.

    RBAC note: unlike admin-only member creation, claim is self-serve — but strictly limited
    to the stub carrying the caller's OWN email, so no one can hijack another person's profile.
    """
    if not body.member_id:
        raise HTTPException(400, "member_id is required to claim")
    if body.family_member_id:
        return await _claim_sub_member(trip, members, user, user_email, body)
    target = next((m for m in members if m["id"] == body.member_id), None)
    if not target:
        raise HTTPException(404, "Member not found")
    if target.get("user_id") == user["id"]:
        return trip  # idempotent: same account re-claiming its own profile
    if normalize_email(target.get("email")) != user_email:
        raise HTTPException(403, "You can only claim the profile matching your email")
    # Atomic claim: succeeds only while the row is still unclaimed (closes the TOCTOU race).
    res = await db.trips.update_one(
        {"id": trip["id"], "members": {"$elemMatch": {"id": target["id"], "user_id": None}}},
        {"$addToSet": {"user_ids": user["id"]}, "$set": {"members.$.user_id": user["id"]}},
    )
    if res.modified_count == 0:
        # Lost the race (or already linked): succeed only if it ended up linked to US.
        fresh = await db.trips.find_one({"id": trip["id"]}, {"_id": 0})
        cur = next((m for m in fresh.get("members", []) if m["id"] == target["id"]), None)
        if cur and cur.get("user_id") == user["id"]:
            return fresh
        raise HTTPException(409, "This profile is already linked to another account")
    return await db.trips.find_one({"id": trip["id"]}, {"_id": 0})


async def _claim_sub_member(trip, members, user, user_email, body):
    """action='claim' + family_member_id: link the caller to ONE family sub-member (Phase 25).

    Stamps that member's per-member linked-account slot (``family_member_user_ids[idx]``) and grants
    the caller trip access — it NEVER touches the family entity's ``user_id`` and NEVER recalculates
    the family's split, so several members of one family can each link their own account independently
    and every balance stays byte-identical. Self-serve but strictly limited to the slot carrying the
    caller's OWN verified email; idempotent; atomic against a concurrent claim of the same slot.
    """
    family = next((m for m in members if m["id"] == body.member_id), None)
    if not family or family.get("kind") != "family":
        raise HTTPException(404, "Family not found")
    ids = padded_family_member_ids(family)
    if body.family_member_id not in ids:
        raise HTTPException(404, "Family member not found")
    idx = ids.index(body.family_member_id)
    emails = family.get("family_member_emails") or []
    uids = family.get("family_member_user_ids") or []
    sub_email = emails[idx] if idx < len(emails) else None
    cur_uid = uids[idx] if idx < len(uids) else None
    if cur_uid == user["id"]:
        return trip  # idempotent: same account re-claiming its own member slot
    if normalize_email(sub_email) != user_email:
        raise HTTPException(403, "You can only claim the member matching your email")
    if cur_uid:
        raise HTTPException(409, "This member is already linked to another account")
    # Atomic: only while this exact slot is still unclaimed (null or absent). Set just the one index
    # so a concurrent claim of a DIFFERENT slot in the same family isn't clobbered.
    res = await db.trips.update_one(
        {"id": trip["id"], "members": {"$elemMatch": {
            "id": family["id"], f"family_member_user_ids.{idx}": None}}},
        {"$addToSet": {"user_ids": user["id"]},
         "$set": {f"members.$.family_member_user_ids.{idx}": user["id"]}},
    )
    if res.modified_count == 0:
        # Lost the race (or already linked): succeed only if this slot ended up linked to US.
        fresh = await db.trips.find_one({"id": trip["id"]}, {"_id": 0})
        fam = next((m for m in fresh.get("members", []) if m["id"] == family["id"]), None)
        fu = (fam or {}).get("family_member_user_ids") or []
        if idx < len(fu) and fu[idx] == user["id"]:
            return fresh
        raise HTTPException(409, "This member is already linked to another account")
    return await db.trips.find_one({"id": trip["id"]}, {"_id": 0})


async def _resolve_clean_stub_for_join_new(trip, own_stubs, user_email, body):
    """Before a join-as-new, remove the caller's OWN clean stub so no duplicate remains.

    SERVER-AUTHORITATIVE: resolves the stub itself (not the client's hint), so the
    financial-history guard fires regardless of what the client sends — even when
    replace_member_id is omitted or wrong. Never deletes a stub with financial history
    (forces a claim), and never deletes someone else's profile.
    """
    own_ids = {s["id"] for s in own_stubs}
    if body.replace_member_id and body.replace_member_id not in own_ids:
        raise HTTPException(403, "You can only replace your own profile")
    if not own_stubs:
        return
    if len(own_stubs) > 1:
        # Legacy duplicate-email data: surface + warn, never auto-destroy.
        logger.warning("join_new: %d duplicate-email stubs for %s in trip %s; not auto-removing",
                       len(own_stubs), user_email, trip["id"])
        return
    stub = own_stubs[0]
    if await member_has_financial_history(trip["id"], stub["id"]):
        raise HTTPException(409, "This profile has expense history — claim it instead of joining as new")
    # Clean stub => zero expense/settlement references => a plain $pull is balance-neutral.
    await db.trips.update_one({"id": trip["id"]}, {"$pull": {"members": {"id": stub["id"]}}})


async def _apply_mode(trip, members, user, user_email, body):
    """Create or link the joiner's OWN membership per body.mode. Shared by the legacy
    (action=None) and join_new flows; callers must have already resolved any conflicting clean
    stub. mode=None => legacy auto-claim a matching own-email stub (EITHER kind), else a new
    individual.
    """
    mode = body.mode
    if mode is None:
        # ---- Legacy auto: auto-claim a matching own-email stub (individual OR family) ----
        stubs = find_own_stubs(members, user_email)
        stub = stubs[0] if stubs else None
        if stub:
            await db.trips.update_one(
                {"id": trip["id"], "members.id": stub["id"]},
                {"$push": {"user_ids": user["id"]},
                 "$set": {"members.$.user_id": user["id"]}},
            )
        else:
            # One-email invariant: a genuine new individual can't reuse an email already in the trip
            # (member entity, another family's sub-member email, or a claimed account) — this also
            # steers a caller whose email sits on an unclaimed sub-member toward claiming it (Phase 25).
            if user_email:
                assert_gmail(user_email)
                await assert_unique_email_in_trip(trip, user_email)
            new_member = {
                "id": gen_id(), "name": user["name"],
                "kind": "individual", "family_members": [],
                "email": user_email, "user_id": user["id"],
            }
            await db.trips.update_one(
                {"id": trip["id"]},
                {"$push": {"user_ids": user["id"], "members": new_member}},
            )

    elif mode == "individual":
        if user_email:
            assert_gmail(user_email)
            await assert_unique_email_in_trip(trip, user_email)
        new_member = {
            "id": gen_id(), "name": user["name"],
            "kind": "individual", "family_members": [],
            "email": user_email, "user_id": user["id"],
        }
        await db.trips.update_one(
            {"id": trip["id"]},
            {"$push": {"user_ids": user["id"], "members": new_member}},
        )

    elif mode == "family":
        # Phase 27: "join existing family" links the caller to a specific UNCLAIMED member SLOT
        # (family_member_user_ids[idx]), never the family entity — a family carries no account/email of
        # its own. Balance-neutral (no size change). One-gmail-per-trip preserved: a slot may be taken
        # only when it has no email or that email is already the joiner's; an empty slot is stamped
        # with the joiner's email.
        if not body.family_id:
            raise HTTPException(400, "family_id is required to link into a family")
        target = next((m for m in members if m["id"] == body.family_id), None)
        if not target:
            raise HTTPException(404, "Family not found")
        if target.get("kind") != "family":
            raise HTTPException(400, "Target member is not a family")
        if not body.family_member_id:
            raise HTTPException(400, "family_member_id is required to link into a family")
        ids = padded_family_member_ids(target)
        if body.family_member_id not in ids:
            raise HTTPException(404, "Family member not found")
        idx = ids.index(body.family_member_id)
        emails = target.get("family_member_emails") or []
        uids = target.get("family_member_user_ids") or []
        cur_uid = uids[idx] if idx < len(uids) else None
        if cur_uid and cur_uid != user["id"]:
            raise HTTPException(400, "This member is already linked to another account")
        slot_email = normalize_email(emails[idx] if idx < len(emails) else None)
        set_fields = {f"members.$.family_member_user_ids.{idx}": user["id"]}
        if user_email:
            if slot_email and slot_email != user_email:
                raise HTTPException(400, "This member belongs to a different email")
            if not slot_email:
                assert_gmail(user_email)
                await assert_unique_email_in_trip(trip, user_email)
                set_fields[f"members.$.family_member_emails.{idx}"] = user_email
        # Atomic: only while this exact slot is still unclaimed (null matches null OR missing), so a
        # concurrent claim of the same slot loses. Never touches the entity user_id/email.
        res = await db.trips.update_one(
            {"id": trip["id"], "members": {"$elemMatch": {
                "id": target["id"], f"family_member_user_ids.{idx}": None}}},
            {"$addToSet": {"user_ids": user["id"]}, "$set": set_fields},
        )
        if res.modified_count == 0:
            raise HTTPException(409, "This member is already linked to another account")

    elif mode == "new_family":
        if not body.family_name:
            raise HTTPException(400, "family_name is required to create a new family")
        if not body.family_members:
            raise HTTPException(400, "Add at least one family member")
        # Duplicate family names are allowed (disambiguated at display time); only the
        # one-email invariant is enforced (members + claimed users' account emails).
        if user_email:
            assert_gmail(user_email)
            await assert_unique_email_in_trip(trip, user_email)
        # Phase 26/27: the family entity carries NO email/account — the joiner is member slot 0
        # (they list themselves first), so their email + account attach to THAT slot.
        n = len(body.family_members)
        emails = [None] * n
        uids = [None] * n
        emails[0] = user_email
        uids[0] = user["id"]
        new_member = {
            "id": gen_id(), "name": body.family_name, "kind": "family",
            "family_members": body.family_members,
            "family_member_ids": assign_family_member_ids(body.family_members),
            "family_member_emails": emails,
            "family_member_user_ids": uids,
            "email": None, "user_id": None,
        }
        await db.trips.update_one(
            {"id": trip["id"]},
            {"$push": {"user_ids": user["id"], "members": new_member}},
        )


@router.post("/trips/join")
async def join_trip(body: JoinRequest, user=Depends(get_current_user)):
    # Step 12 + Phase 11: join is self-service (the trip code is the authorization); the joiner
    # may only create/link their OWN membership — every other member mutation stays behind
    # _trip_admin_or_403. Phase 11 enforces "one gmail == at most one person per trip" on EVERY
    # path: when the caller's own email already has a profile they must CLAIM it (or explicitly
    # join-as-new, which removes a CLEAN stub) — the server never silently creates a second
    # same-email identity. action=claim/join_new drive the wizard; action=None keeps the legacy
    # contract, hardened the same way.
    code = (body.code or "").upper().strip()
    trip = await db.trips.find_one({"code": code}, {"_id": 0})
    if not trip:
        raise HTTPException(404, "Trip not found")
    if user["id"] in trip.get("user_ids", []):
        return trip  # idempotent — already a member, regardless of action/mode

    members = trip.get("members", [])
    user_email = normalize_email(user["email"])

    if body.action == "claim":
        return await _claim_member(trip, members, user, user_email, body)

    own_stubs = find_own_stubs(members, user_email)

    if body.action == "join_new":
        if body.mode not in ("individual", "family", "new_family"):
            raise HTTPException(400, "mode is required for join_new")
        await _resolve_clean_stub_for_join_new(trip, own_stubs, user_email, body)
        trip = await db.trips.find_one({"id": trip["id"]}, {"_id": 0})  # fresh after any $pull
        members = trip.get("members", [])
        await _apply_mode(trip, members, user, user_email, body)
        return await db.trips.find_one({"id": trip["id"]}, {"_id": 0})

    # ---- No explicit action: legacy contract, hardened to never create a duplicate. ----
    if body.mode is None:
        # _apply_mode auto-claims a matching own-email stub (either kind), so no dup is possible.
        await _apply_mode(trip, members, user, user_email, body)
        return await db.trips.find_one({"id": trip["id"]}, {"_id": 0})

    # Explicit mode without action. Linking the caller's OWN family slot via mode='family' is
    # fine (it claims, not duplicates); any path that would CREATE a new identity while the
    # caller's email already has a profile is rejected and steered to claim / join_new.
    creates_duplicate = bool(own_stubs) and not (
        body.mode == "family" and body.family_id in {s["id"] for s in own_stubs}
    )
    if creates_duplicate:
        if len(own_stubs) > 1:
            logger.warning("join: %d duplicate-email stubs for %s in trip %s",
                           len(own_stubs), user_email, trip["id"])
        raise HTTPException(
            409,
            "Your email already has a profile on this trip. Claim it, or choose "
            "'join as someone new' to replace it.",
        )
    await _apply_mode(trip, members, user, user_email, body)
    return await db.trips.find_one({"id": trip["id"]}, {"_id": 0})


@router.post("/trips/join/preview")
async def join_preview(body: JoinPreviewRequest, user=Depends(get_current_user)):
    # Step 12: read-only context for the join wizard. Resolve by code (no membership
    # required — the code is the authorization) and surface the family link targets.
    code = (body.code or "").upper().strip()
    trip = await db.trips.find_one({"code": code}, {"_id": 0})
    if not trip:
        raise HTTPException(404, "Trip not found")
    ensure_date_range(trip)
    members = trip.get("members", [])
    user_email = normalize_email(user["email"])
    # Phase 27: emails identify a person, never a family, so "join existing family" links to a
    # specific UNCLAIMED member slot. Surface each family's open slots (a slot with no linked account)
    # so the wizard can offer them; `size` stays for the count, `linked` for back-compat (always
    # False now — a family carries no entity account).
    families = []
    for m in members:
        if m.get("kind") != "family":
            continue
        names = m.get("family_members", []) or []
        ids = padded_family_member_ids(m)
        uids = m.get("family_member_user_ids") or []
        open_slots = [
            {"id": ids[i], "name": names[i]}
            for i in range(len(names))
            if not (uids[i] if i < len(uids) else None)
        ]
        families.append({
            "id": m["id"], "name": m["name"], "size": len(names),
            "linked": bool(m.get("user_id")), "open_slots": open_slots,
        })
    # Match an unclaimed stub carrying the caller's OWN email. An email identifies a PERSON: a
    # standalone INDIVIDUAL (find_own_stubs) or ONE family sub-member (find_own_sub_stub). The wizard
    # uses `match` to offer claim-vs-join-new and to gate join-new on financial history.
    stubs = find_own_stubs(members, user_email)
    match = None
    if stubs:
        stub = stubs[0]
        match = {
            "member_id": stub["id"],
            "member_type": "individual",
            "member_name": stub["name"],
            "family_id": None,
            "family_name": None,
            "has_financial_history": await member_has_financial_history(trip["id"], stub["id"]),
        }
        if len(stubs) > 1:
            # Legacy duplicate-email data: surface every match, never auto-destroy.
            logger.warning(
                "join/preview: %d duplicate-email stubs for %s in trip %s; surfacing all, not deleting",
                len(stubs), user_email, trip["id"],
            )
    else:
        # Phase 25: try a per-member email match (link the caller to ONE family sub-member). Reported
        # claim-only (has_financial_history=True routes the wizard's claim-only path): the email sits
        # on that member by admin intent, and "join as new" while the sub-email is still present would
        # violate the one-email invariant.
        sub = find_own_sub_stub(members, user_email)
        if sub:
            match = {
                "member_id": sub["family_id"],
                "member_type": "family_member",
                "member_name": sub["member_name"],
                "family_id": sub["family_id"],
                "family_name": sub["family_name"],
                "family_member_id": sub["member_id"],
                "has_financial_history": True,
            }
    match_conflicts = [
        {"member_id": m["id"], "member_name": m["name"], "member_type": "individual"}
        for m in stubs[1:]
    ] or None
    # Back-compat: `matched_family` (the retired whole-family-entity match) is always null now.
    matched_family = None
    return {
        "trip": {
            "id": trip["id"], "name": trip["name"], "code": trip["code"],
            "start_date": trip.get("start_date"), "end_date": trip.get("end_date"),
            "currency": trip.get("currency"),
            "member_count": len(members),
        },
        "already_member": user["id"] in trip.get("user_ids", []),
        "matched_family": matched_family,
        "families": families,
        "match": match,
        "match_conflicts": match_conflicts,
    }


# ---------- Trip Admins ----------
def _admin_payload(trip: dict) -> dict:
    # Resolve each admin app-user id to the PERSON it links to: a standalone individual (entity
    # user_id) OR a specific family sub-member (family_member_user_ids[i]). An email/account
    # identifies a person, never a family, so a family entity is never itself an admin.
    by_uid: dict = {}
    for m in trip.get("members", []):
        if m.get("kind") == "family":
            names = m.get("family_members", []) or []
            ids = padded_family_member_ids(m)
            emails = m.get("family_member_emails") or []
            uids = m.get("family_member_user_ids") or []
            for i in range(len(names)):
                uid = uids[i] if i < len(uids) else None
                if uid and uid not in by_uid:
                    by_uid[uid] = {
                        "id": ids[i], "name": names[i],
                        "email": emails[i] if i < len(emails) else None,
                        "family_id": m["id"], "family_name": m["name"],
                    }
        elif m.get("user_id") and m["user_id"] not in by_uid:
            by_uid[m["user_id"]] = {
                "id": m["id"], "name": m.get("name"), "email": m.get("email"),
                "family_id": None, "family_name": None,
            }
    admins = [
        {"user_id": uid,
         "id": (by_uid.get(uid) or {}).get("id"),
         "name": (by_uid.get(uid) or {}).get("name"),
         "email": (by_uid.get(uid) or {}).get("email"),
         "family_id": (by_uid.get(uid) or {}).get("family_id"),
         "family_name": (by_uid.get(uid) or {}).get("family_name")}
        for uid in trip.get("admin_ids", [])
    ]
    return {"owner_id": trip["owner_id"], "admin_ids": trip.get("admin_ids", []), "admins": admins}


@router.get("/trips/{trip_id}/admins")
async def list_admins(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    return _admin_payload(trip)


@router.post("/trips/{trip_id}/admins")
async def add_admin(trip_id: str, body: AdminGrant, user=Depends(get_current_user)):
    # Step 23: managing admins is an owner-only power (admins cannot promote/demote).
    trip = await _trip_owner_or_403(trip_id, user["id"])
    if body.user_id not in trip.get("user_ids", []):
        raise HTTPException(400, "User is not a member of this trip")
    await db.trips.update_one({"id": trip_id}, {"$addToSet": {"admin_ids": body.user_id}})
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    return _admin_payload(trip)


@router.delete("/trips/{trip_id}/admins/{user_id}")
async def remove_admin(trip_id: str, user_id: str, user=Depends(get_current_user)):
    # Step 23: managing admins is an owner-only power (admins cannot promote/demote).
    trip = await _trip_owner_or_403(trip_id, user["id"])
    if user_id == trip["owner_id"]:
        raise HTTPException(400, "Cannot remove the root admin")
    await db.trips.update_one({"id": trip_id}, {"$pull": {"admin_ids": user_id}})
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    return _admin_payload(trip)


@router.post("/trips/{trip_id}/transfer-ownership")
async def transfer_ownership(trip_id: str, body: OwnershipTransfer, user=Depends(get_current_user)):
    # Step 23: owner-only. Reassigns owner_id and keeps the new owner in admin_ids; the
    # previous owner stays an admin (never dropped to plain member). Touches only the
    # owner_id / admin_ids fields — no member, family, or split data changes.
    trip = await _trip_owner_or_403(trip_id, user["id"])
    if body.user_id == trip["owner_id"]:
        raise HTTPException(400, "Already the owner")
    if body.user_id not in trip.get("user_ids", []):
        raise HTTPException(400, "User is not a member of this trip")
    await db.trips.update_one(
        {"id": trip_id},
        {"$set": {"owner_id": body.user_id}, "$addToSet": {"admin_ids": body.user_id}},
    )
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    return _admin_payload(trip)
