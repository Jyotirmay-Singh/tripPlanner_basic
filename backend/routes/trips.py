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
    email_exists,
    assert_unique_email,
    assert_unique_email_in_trip,
    assign_family_member_ids,
    find_own_stubs,
    member_has_financial_history,
)

router = APIRouter()
logger = logging.getLogger(__name__)


# ---------- Trips ----------
@router.post("/trips")
async def create_trip(body: TripIn, user=Depends(get_current_user)):
    # Calendar dates are stored as 'YYYY-MM-DD'; reject impossible dates and end-before-start.
    assert_valid_range(body.start_date, body.end_date)
    tid = gen_id()
    code = gen_trip_code()
    while await db.trips.find_one({"code": code}):
        code = gen_trip_code()
    # create an "owner member" automatically (individual)
    owner_member = {
        "id": gen_id(), "name": user["name"], "kind": "individual",
        "family_members": [], "email": user["email"], "user_id": user["id"],
    }
    doc = {
        "id": tid, "code": code, "name": body.name,
        "start_date": body.start_date.strip(), "end_date": body.end_date.strip(),
        "budget": body.budget, "currency": body.currency or "INR",
        "owner_id": user["id"], "user_ids": [user["id"]],
        "admin_ids": [user["id"]],
        "members": [owner_member],
        "created_at": now_utc().isoformat(),
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


@router.post("/trips/join")
async def join_trip(body: JoinRequest, user=Depends(get_current_user)):
    # Step 12: join is self-service — possession of the valid trip code is the
    # authorization. The joiner may only create/link their OWN membership; every
    # other member mutation stays behind _trip_admin_or_403. The joiner's explicit
    # `mode` decides how they enter; a missing mode preserves the legacy auto-behavior.
    code = (body.code or "").upper().strip()
    trip = await db.trips.find_one({"code": code}, {"_id": 0})
    if not trip:
        raise HTTPException(404, "Trip not found")
    if user["id"] in trip.get("user_ids", []):
        return trip  # idempotent — already a member, regardless of mode

    members = trip.get("members", [])
    user_email = normalize_email(user["email"])
    mode = body.mode

    if mode is None:
        # ---- Legacy auto-behavior: email auto-link, else new individual ----
        linked_family = next(
            (m for m in members
             if m.get("kind") == "family"
             and normalize_email(m.get("email")) == user_email
             and not m.get("user_id")),
            None,
        )
        if linked_family:
            await db.trips.update_one(
                {"id": trip["id"], "members.id": linked_family["id"]},
                {"$push": {"user_ids": user["id"]},
                 "$set": {"members.$.user_id": user["id"]}},
            )
        else:
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
        # Explicit individual — never auto-link, even if an email-matching family exists.
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
        if not body.family_id:
            raise HTTPException(400, "family_id is required to link into a family")
        target = next((m for m in members if m["id"] == body.family_id), None)
        if not target:
            raise HTTPException(404, "Family not found")
        if target.get("kind") != "family":
            raise HTTPException(400, "Target member is not a family")
        if target.get("user_id") and target["user_id"] != user["id"]:
            raise HTTPException(400, "This family is already linked to another account")
        set_fields = {"members.$.user_id": user["id"]}
        # Stamp the joiner's email only if the family has none and it stays unique.
        if user_email and not normalize_email(target.get("email")) \
                and not email_exists(members, user_email, exclude_id=target["id"]):
            set_fields["members.$.email"] = user_email
        await db.trips.update_one(
            {"id": trip["id"], "members.id": target["id"]},
            {"$push": {"user_ids": user["id"]}, "$set": set_fields},
        )

    elif mode == "new_family":
        if not body.family_name:
            raise HTTPException(400, "family_name is required to create a new family")
        # Duplicate family names are allowed (disambiguated at display time); only linked-email
        # uniqueness is still enforced below.
        if user_email:
            assert_gmail(user_email)
            assert_unique_email(members, user_email)
        new_member = {
            "id": gen_id(), "name": body.family_name, "kind": "family",
            "family_members": body.family_members,
            "family_member_ids": assign_family_member_ids(body.family_members),
            "email": user_email, "user_id": user["id"],
        }
        await db.trips.update_one(
            {"id": trip["id"]},
            {"$push": {"user_ids": user["id"], "members": new_member}},
        )

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
    families = [
        {"id": m["id"], "name": m["name"],
         "size": len(m.get("family_members", [])),
         "linked": bool(m.get("user_id"))}
        for m in members if m.get("kind") == "family"
    ]
    # Phase 11: match an unclaimed stub carrying the caller's OWN email — an individual OR a
    # whole family (linked_email lives on the entity). The wizard uses `match` to offer
    # claim-vs-join-new and to gate join-new on financial history.
    stubs = find_own_stubs(members, user_email)
    match = None
    if stubs:
        stub = stubs[0]
        is_family = stub.get("kind") == "family"
        match = {
            "member_id": stub["id"],
            "member_type": "family" if is_family else "individual",
            "member_name": stub["name"],
            "family_id": stub["id"] if is_family else None,
            "family_name": stub["name"] if is_family else None,
            "has_financial_history": await member_has_financial_history(trip["id"], stub["id"]),
        }
        if len(stubs) > 1:
            # Legacy duplicate-email data: surface every match, never auto-destroy.
            logger.warning(
                "join/preview: %d duplicate-email stubs for %s in trip %s; surfacing all, not deleting",
                len(stubs), user_email, trip["id"],
            )
    match_conflicts = [
        {"member_id": m["id"], "member_name": m["name"],
         "member_type": "family" if m.get("kind") == "family" else "individual"}
        for m in stubs[1:]
    ] or None
    # Back-compat: matched_family stays populated only when the (first) match is a family entity.
    matched_family = (
        {"id": stubs[0]["id"], "name": stubs[0]["name"]}
        if stubs and stubs[0].get("kind") == "family" else None
    )
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
    by_uid = {m.get("user_id"): m for m in trip.get("members", []) if m.get("user_id")}
    admins = [
        {"user_id": uid, "id": (by_uid.get(uid) or {}).get("id"),
         "name": (by_uid.get(uid) or {}).get("name"),
         "email": (by_uid.get(uid) or {}).get("email")}
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
