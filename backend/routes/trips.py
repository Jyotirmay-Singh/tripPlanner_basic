from fastapi import APIRouter, HTTPException, Depends

from database import db
from models.trip import TripIn, TripUpdate
from utils.common import gen_id, gen_trip_code, now_utc
from utils.deps import get_current_user, _trip_or_404

router = APIRouter()


# ---------- Trips ----------
@router.post("/trips")
async def create_trip(body: TripIn, user=Depends(get_current_user)):
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
        "id": tid, "code": code, "name": body.name, "travel_date": body.travel_date,
        "budget": body.budget, "currency": body.currency or "INR",
        "owner_id": user["id"], "user_ids": [user["id"]],
        "members": [owner_member],
        "created_at": now_utc().isoformat(),
    }
    await db.trips.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/trips")
async def list_trips(user=Depends(get_current_user)):
    cur = db.trips.find({"user_ids": user["id"]}, {"_id": 0}).sort("created_at", -1)
    return await cur.to_list(500)


@router.get("/trips/{trip_id}")
async def get_trip(trip_id: str, user=Depends(get_current_user)):
    return await _trip_or_404(trip_id, user["id"])


@router.patch("/trips/{trip_id}")
async def update_trip(trip_id: str, body: TripUpdate, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if updates:
        await db.trips.update_one({"id": trip_id}, {"$set": updates})
    return await db.trips.find_one({"id": trip_id}, {"_id": 0})


@router.delete("/trips/{trip_id}")
async def delete_trip(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    if trip["owner_id"] != user["id"]:
        raise HTTPException(403, "Only the owner can delete")
    await db.trips.delete_one({"id": trip_id})
    await db.expenses.delete_many({"trip_id": trip_id})
    await db.settlements.delete_many({"trip_id": trip_id})
    return {"ok": True}


@router.post("/trips/join")
async def join_trip(body: dict, user=Depends(get_current_user)):
    code = (body.get("code") or "").upper().strip()
    trip = await db.trips.find_one({"code": code}, {"_id": 0})
    if not trip:
        raise HTTPException(404, "Trip not found")
    if user["id"] in trip.get("user_ids", []):
        return trip
    # Check if a family member in this trip has this user's email -> link instead of adding
    user_email = user["email"].lower().strip()
    linked_family = None
    for m in trip.get("members", []):
        if m.get("kind") == "family" and (m.get("email") or "").lower() == user_email and not m.get("user_id"):
            linked_family = m
            break
    if linked_family:
        await db.trips.update_one(
            {"id": trip["id"], "members.id": linked_family["id"]},
            {"$push": {"user_ids": user["id"]},
             "$set": {"members.$.user_id": user["id"]}},
        )
    else:
        new_member = {
            "id": gen_id(), "name": user["name"], "kind": "individual",
            "family_members": [], "email": user_email, "user_id": user["id"],
        }
        await db.trips.update_one(
            {"id": trip["id"]},
            {"$push": {"user_ids": user["id"], "members": new_member}},
        )
    return await db.trips.find_one({"id": trip["id"]}, {"_id": 0})
