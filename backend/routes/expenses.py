from fastapi import APIRouter, HTTPException, Depends

from config import CATEGORIES
from database import db
from models.expense import ExpenseIn, ExpenseUpdate
from utils.common import gen_id, now_utc
from utils.deps import get_current_user, _trip_or_404, _expense_modify_or_403
from services.receipts import delete_receipts_for_expense

router = APIRouter()


def _clean_family_participants(raw, split_mode, split_ids, members):
    """Normalize the incoming family_participants map to genuine intra-family restrictions.

    Keeps an entry only when: PER_CAPITA, the family is in the split, and the recorded participant
    ids are a proper, non-empty subset of that family's current roster ids. Anything else (all
    members, unknown families/ids, PER_FAMILY) collapses to None => all participate (back-compat).
    """
    if not raw or split_mode != "PER_CAPITA":
        return None
    member_by_id = {m["id"]: m for m in members}
    split_set = set(split_ids)
    clean = {}
    for fam_id, pids in raw.items():
        if fam_id not in split_set:
            continue
        fam = member_by_id.get(fam_id)
        if not fam or fam.get("kind") != "family":
            continue
        roster = [str(x) for x in (fam.get("family_member_ids") or [])]
        roster_set = set(roster)
        kept = [p for p in (pids or []) if p in roster_set]
        if kept and len(kept) < len(roster):  # only a real (proper, non-empty) restriction
            clean[fam_id] = kept
    return clean or None


# ---------- Expenses ----------
@router.post("/trips/{trip_id}/expenses")
async def add_expense(trip_id: str, body: ExpenseIn, force: bool = False,
                      user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    if body.category not in CATEGORIES:
        raise HTTPException(400, "Invalid category")
    member_ids = {m["id"] for m in trip["members"]}
    if body.paid_by_member_id not in member_ids:
        raise HTTPException(400, "paid_by_member_id invalid")
    split_ids = body.split_member_ids or [m["id"] for m in trip["members"]]
    for sid in split_ids:
        if sid not in member_ids:
            raise HTTPException(400, f"split member {sid} invalid")

    # Intra-family participation (PER_CAPITA only): keep only genuine restrictions — a family that is
    # in the split, and a proper non-empty subset of its current roster ids. Everything else collapses
    # to None (=> all members participate), preserving exact back-compat.
    family_participants = _clean_family_participants(body.family_participants, body.split_mode,
                                                     split_ids, trip["members"])

    # budget over-check (category vs overall)
    warning = None
    if body.kind == "expense" and trip.get("budget"):
        cur = await db.expenses.aggregate([
            {"$match": {"trip_id": trip_id, "kind": "expense"}},
            {"$group": {"_id": None, "sum": {"$sum": "$amount"}}},
        ]).to_list(1)
        current = cur[0]["sum"] if cur else 0
        if current + body.amount > trip["budget"]:
            warning = f"This expense puts you {(current + body.amount) - trip['budget']:.2f} {trip.get('currency','INR')} over the trip budget."
            if not force:
                return {"requires_confirmation": True, "warning": warning}

    eid = gen_id()
    doc = {
        "id": eid, "trip_id": trip_id, "kind": body.kind,
        "amount": float(body.amount), "category": body.category,
        "description": body.description or "",
        "date": body.date,
        "time": body.time,  # optional wall-clock "HH:MM" (24h); None = no time
        "paid_by_member_id": body.paid_by_member_id,
        "split_member_ids": split_ids,
        "split_mode": body.split_mode,
        "weight_snapshots": body.weight_snapshots or None,
        "family_participants": family_participants,
        # Step 22: receipts are no longer stored inline; the client uploads the bill image to
        # POST /trips/{id}/expenses/{eid}/receipt after the expense is created, which sets receipt_id.
        "created_by": user["id"], "created_at": now_utc().isoformat(),
    }
    await db.expenses.insert_one(doc)
    doc.pop("_id", None)
    return {"expense": doc, "warning": warning}


@router.get("/trips/{trip_id}/expenses")
async def list_expenses(trip_id: str, user=Depends(get_current_user)):
    await _trip_or_404(trip_id, user["id"])
    # Step 22: never return the heavy receipt bytes in the list. Expose a lightweight
    # `has_receipt` flag (true for a GridFS receipt_id OR a legacy inline blob) so the client
    # can render a thumbnail via the streamed GET endpoint without downloading bytes here.
    cur = db.expenses.aggregate([
        {"$match": {"trip_id": trip_id}},
        {"$sort": {"created_at": -1}},
        {"$addFields": {"has_receipt": {"$or": [
            {"$ifNull": ["$receipt_id", False]},
            {"$ifNull": ["$receipt_base64", False]},
        ]}}},
        {"$project": {"_id": 0, "receipt_base64": 0}},
    ])
    expenses = await cur.to_list(1000)
    for e in expenses:
        e["split_mode"] = e.get("split_mode", "PER_CAPITA")
        e["has_receipt"] = bool(e.get("has_receipt"))
    return expenses


@router.patch("/trips/{trip_id}/expenses/{expense_id}")
async def update_expense(trip_id: str, expense_id: str, body: ExpenseUpdate,
                         user=Depends(get_current_user)):
    # Step 10: only the expense creator or a trip admin may edit (404 if missing, 403 otherwise).
    _trip, expense = await _expense_modify_or_403(trip_id, expense_id, user["id"])
    # exclude_unset: only persist fields the client actually sent, so an explicit
    # null (e.g. clearing weight_snapshots when switching to PER_FAMILY, or removing
    # a receipt) clears the field instead of being silently dropped.
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k != "force"}
    if not updates:
        return expense
    await db.expenses.update_one({"id": expense_id, "trip_id": trip_id}, {"$set": updates})
    return await db.expenses.find_one({"id": expense_id}, {"_id": 0})


@router.delete("/trips/{trip_id}/expenses/{expense_id}")
async def delete_expense(trip_id: str, expense_id: str, user=Depends(get_current_user)):
    # Step 10: only the expense creator or a trip admin may delete (404 if missing, 403 otherwise).
    await _expense_modify_or_403(trip_id, expense_id, user["id"])
    # Step 22: clean up any GridFS receipt so we never leave orphaned receipts.files/.chunks.
    await delete_receipts_for_expense(expense_id)
    await db.expenses.delete_one({"id": expense_id, "trip_id": trip_id})
    return {"ok": True}
