from fastapi import APIRouter, HTTPException, Depends

from database import db
from models.member import MemberIn, MemberUpdate
from utils.common import gen_id
from utils.deps import get_current_user, _trip_or_404
from utils.balances import _weight_of_member

router = APIRouter()


# ---------- Members ----------
@router.post("/trips/{trip_id}/members")
async def add_member(trip_id: str, body: MemberIn, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name is required")
    # Duplicate-name check (case-insensitive) per trip
    for m in trip.get("members", []):
        if m["name"].lower() == name.lower():
            raise HTTPException(400, f"A member named '{name}' already exists in this trip")
    email = (body.email or "").lower().strip() or None
    # Determine if this email matches an existing user-individual we should merge with (in-place)
    merge_target = None
    if email and body.kind == "family":
        for m in trip.get("members", []):
            if (m.get("email") or "").lower() == email and m.get("user_id") and m.get("kind") == "individual":
                merge_target = m; break
    # Duplicate email check (skip if we plan to merge that one)
    if email:
        for m in trip.get("members", []):
            if merge_target and m["id"] == merge_target["id"]:
                continue
            if (m.get("email") or "").lower() == email:
                raise HTTPException(400, f"A member with email '{email}' already exists in this trip")
    new_member = {
        "id": gen_id(), "name": name, "kind": body.kind,
        "family_members": body.family_members if body.kind == "family" else [],
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
                "members.$.email": email,
            }},
        )
        t = await db.trips.find_one({"id": trip_id}, {"_id": 0})
        return next((m for m in t["members"] if m["id"] == merge_target["id"]), None)
    await db.trips.update_one({"id": trip_id}, {"$push": {"members": new_member}})
    return new_member


@router.patch("/trips/{trip_id}/members/{member_id}")
async def update_member(trip_id: str, member_id: str, body: MemberUpdate, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    target = next((m for m in trip["members"] if m["id"] == member_id), None)
    if not target:
        raise HTTPException(404, "Member not found")
    updates: dict = {}
    if body.name is not None:
        nm = body.name.strip()
        if not nm:
            raise HTTPException(400, "Name cannot be empty")
        # duplicate check excluding self
        for m in trip["members"]:
            if m["id"] != member_id and m["name"].lower() == nm.lower():
                raise HTTPException(400, f"A member named '{nm}' already exists in this trip")
        updates["members.$.name"] = nm
    if body.kind is not None:
        updates["members.$.kind"] = body.kind
    new_kind = body.kind if body.kind is not None else target["kind"]
    new_fm = body.family_members if body.family_members is not None else target.get("family_members", [])
    if new_kind != "family":
        new_fm = []
    if body.family_members is not None or body.kind is not None:
        updates["members.$.family_members"] = new_fm
    if body.email is not None:
        em = (body.email or "").lower().strip() or None
        if em:
            for m in trip["members"]:
                if m["id"] != member_id and (m.get("email") or "").lower() == em:
                    raise HTTPException(400, f"A member with email '{em}' already exists in this trip")
        updates["members.$.email"] = em

    # If family members list changed and user chose NOT to re-weight past, snapshot old weights
    old_fm = target.get("family_members", [])
    old_weight = _weight_of_member(target)
    new_weight_member = {**target, "kind": new_kind, "family_members": new_fm}
    new_weight = _weight_of_member(new_weight_member)
    if old_weight != new_weight and body.reweight_past is False:
        # For every past expense that has this member in split_member_ids, snapshot the OLD weight
        async for e in db.expenses.find({"trip_id": trip_id, "split_member_ids": member_id}):
            snap = e.get("weight_snapshots") or {}
            if member_id not in snap:
                snap[member_id] = old_weight
                await db.expenses.update_one({"id": e["id"]}, {"$set": {"weight_snapshots": snap}})

    if updates:
        await db.trips.update_one({"id": trip_id, "members.id": member_id}, {"$set": updates})
    t = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    return next((m for m in t["members"] if m["id"] == member_id), None)


@router.delete("/trips/{trip_id}/members/{member_id}")
async def delete_member(trip_id: str, member_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    # cannot remove if member appears in any expense
    exists = await db.expenses.find_one({"trip_id": trip_id,
                                         "$or": [{"paid_by_member_id": member_id},
                                                 {"split_member_ids": member_id}]})
    if exists:
        raise HTTPException(400, "Member has expenses; cannot delete")
    await db.trips.update_one({"id": trip_id}, {"$pull": {"members": {"id": member_id}}})
    return {"ok": True}
