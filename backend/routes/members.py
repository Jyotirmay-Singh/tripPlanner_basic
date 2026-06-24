from fastapi import APIRouter, HTTPException, Depends

from database import db
from models.member import MemberIn, MemberUpdate
from utils.common import gen_id
from utils.deps import get_current_user, _trip_admin_or_403
from utils.balances import _weight_of_member
from utils.email_rules import assert_gmail, normalize_email
from utils.members import assert_unique_email, assign_family_member_ids
from services.reallocation import run_member_update_with_reallocation

router = APIRouter()


# ---------- Members ----------
@router.post("/trips/{trip_id}/members")
async def add_member(trip_id: str, body: MemberIn, user=Depends(get_current_user)):
    trip = await _trip_admin_or_403(trip_id, user["id"])
    name = body.name
    members = trip.get("members", [])
    email = normalize_email(body.email)
    if email:
        assert_gmail(email)
    # Determine if this email matches an existing user-individual we should merge with (in-place)
    merge_target = None
    if email and body.kind == "family":
        for m in members:
            if (m.get("email") or "").lower() == email and m.get("user_id") and m.get("kind") == "individual":
                merge_target = m; break
    exclude_id = merge_target["id"] if merge_target else None
    # Duplicate names are allowed (disambiguated at display time via utils.display_names); only the
    # linked-email uniqueness invariant (Step 3) is still enforced here.
    assert_unique_email(members, email, exclude_id=exclude_id)
    fam_names = body.family_members if body.kind == "family" else []
    new_member = {
        "id": gen_id(), "name": name, "kind": body.kind,
        "family_members": fam_names,
        # Stable ids parallel to family_members (used by per-expense family_participants).
        "family_member_ids": assign_family_member_ids(fam_names, body.family_member_ids) if body.kind == "family" else [],
        "email": email, "user_id": None,
    }
    # If a user already in the trip has this email AND currently exists as an individual,
    # convert that individual into this family IN-PLACE (preserves member.id so all past
    # expenses automatically apply to the family — avoids double-counting).
    if merge_target:
        await db.trips.update_one(
            {"id": trip_id, "members.id": merge_target["id"]},
            {"$set": {
                "members.$.name": name,
                "members.$.kind": "family",
                "members.$.family_members": body.family_members,
                "members.$.family_member_ids": assign_family_member_ids(
                    body.family_members, body.family_member_ids,
                    merge_target.get("family_member_ids"),
                ),
                "members.$.email": email,
            }},
        )
        t = await db.trips.find_one({"id": trip_id}, {"_id": 0})
        return next((m for m in t["members"] if m["id"] == merge_target["id"]), None)
    await db.trips.update_one({"id": trip_id}, {"$push": {"members": new_member}})
    return new_member


@router.patch("/trips/{trip_id}/members/{member_id}")
async def update_member(trip_id: str, member_id: str, body: MemberUpdate, user=Depends(get_current_user)):
    trip = await _trip_admin_or_403(trip_id, user["id"])
    target = next((m for m in trip["members"] if m["id"] == member_id), None)
    if not target:
        raise HTTPException(404, "Member not found")
    updates: dict = {}
    if body.name is not None:
        # Duplicate names allowed (display-time disambiguation); no uniqueness check on rename.
        updates["members.$.name"] = body.name
    if body.kind is not None:
        updates["members.$.kind"] = body.kind
    new_kind = body.kind if body.kind is not None else target["kind"]
    new_fm = body.family_members if body.family_members is not None else target.get("family_members", [])
    if new_kind != "family":
        new_fm = []
    if body.family_members is not None or body.kind is not None:
        updates["members.$.family_members"] = new_fm
        # Keep stable ids parallel to the roster: preserve ids for retained rows (the editor sends
        # them), mint for new rows, and clear ids when this stops being a family.
        updates["members.$.family_member_ids"] = (
            assign_family_member_ids(new_fm, body.family_member_ids, target.get("family_member_ids"))
            if new_kind == "family" else []
        )
    if body.email is not None:
        em = normalize_email(body.email)
        if em:
            assert_gmail(em)
            assert_unique_email(trip["members"], em, exclude_id=member_id)
        updates["members.$.email"] = em

    # Step 8: a family size change re-allocates past PER_CAPITA expenses. reweight_past defaults to
    # True (recalculate the past); False freezes the past at the pre-mutation weight. The member-doc
    # update and the expense reallocation are applied atomically (transaction with a standalone
    # fallback). Name/email-only edits (old_weight == new_weight) touch no expenses.
    old_weight = _weight_of_member(target)
    new_weight_member = {**target, "kind": new_kind, "family_members": new_fm}
    new_weight = _weight_of_member(new_weight_member)
    await run_member_update_with_reallocation(
        trip_id, member_id, updates, old_weight, new_weight,
        reweight_past=(body.reweight_past is not False),
    )
    t = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    return next((m for m in t["members"] if m["id"] == member_id), None)


@router.delete("/trips/{trip_id}/members/{member_id}")
async def delete_member(trip_id: str, member_id: str, user=Depends(get_current_user)):
    trip = await _trip_admin_or_403(trip_id, user["id"])
    # cannot remove if member appears in any expense
    exists = await db.expenses.find_one({"trip_id": trip_id,
                                         "$or": [{"paid_by_member_id": member_id},
                                                 {"split_member_ids": member_id}]})
    if exists:
        raise HTTPException(400, "Member has expenses; cannot delete")
    await db.trips.update_one({"id": trip_id}, {"$pull": {"members": {"id": member_id}}})
    return {"ok": True}
