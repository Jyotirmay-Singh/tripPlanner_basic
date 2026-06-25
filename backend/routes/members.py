from fastapi import APIRouter, HTTPException, Depends

from database import db
from models.member import MemberIn, MemberUpdate
from utils.common import gen_id
from utils.deps import get_current_user, _trip_admin_or_403
from utils.balances import _weight_of_member, _compute_balances
from utils.email_rules import assert_gmail, normalize_email
from utils.members import assert_unique_email, assign_family_member_ids
from utils.settlement_gate import (
    is_settled, entity_net, family_member_net, unsettled_family_members,
)
from services.member_breakdown import family_member_ids
from services.reallocation import run_member_update_with_reallocation, freeze_and_remove_member

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
    # P3 — HARD INVARIANT mirror: a family must always have >=1 member. The bulk editor only
    # soft-blocks this client-side (edit-member.tsx); enforce it server-side too so a crafted PATCH
    # (or an individual->family conversion with no members) can't create a zero-member family.
    # Family->individual conversion is unaffected (the guard only fires when the RESULT is a family).
    if new_kind == "family" and not new_fm:
        raise HTTPException(400, "A family must have at least one member.")
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


async def _settlement_block_reason(trip_id: str, target: dict):
    """Return a 409 message if ``target`` is NOT fully settled, else None (re-reads balances).

    Single source of truth for the entity-removal gate, used both for the upfront fast-fail and for
    the write-time re-check (P5). "Fully settled" == net rounds to 0.00 in the EXISTING engine. For a
    family the gate is strict: EVERY family member's displayed net AND the family entity net must be
    settled. This only READS balances; it never changes them.
    """
    bal = await _compute_balances(trip_id)
    member_id = target["id"]
    name = target.get("name") or "This member"
    if target.get("kind") == "family":
        unsettled = unsettled_family_members(bal, member_id)
        if unsettled or not is_settled(entity_net(bal, member_id)):
            who = ", ".join(r["name"] for r in unsettled) or name
            return f"Cannot remove {name}: outstanding balance for {who}. Settle up first."
    elif not is_settled(entity_net(bal, member_id)):
        return f"{name} has an outstanding balance. Settle up before removing."
    return None


@router.delete("/trips/{trip_id}/members/{member_id}")
async def delete_member(trip_id: str, member_id: str, user=Depends(get_current_user)):
    """Remove an individual OR a whole family (a family is a single member doc), gated by settlement.

    A target may be removed only when fully settled (net rounds to 0.00) in the EXISTING balance
    engine — removal is gated by balances and never changes them. Past expense records are kept; the
    family's weight is pinned onto its past PER_CAPITA expenses so every other balance stays
    byte-identical (see ``freeze_and_remove_member``). An app-user member is also evicted from trip
    access + admin rights (P2), and the gate is re-checked at write time to close the TOCTOU window
    (P5).
    """
    trip = await _trip_admin_or_403(trip_id, user["id"])
    target = next((m for m in trip.get("members", []) if m["id"] == member_id), None)
    # A missing member id stays an idempotent no-op (preserves the historical DELETE contract).
    if not target:
        return {"ok": True}
    # The owner's member row is the trip root and cannot be removed by anyone — not a promoted
    # admin, nor the owner themselves (mirrors remove_admin's "Cannot remove the root admin").
    if target.get("user_id") and target["user_id"] == trip.get("owner_id"):
        raise HTTPException(403, "Cannot remove the trip owner")

    reason = await _settlement_block_reason(trip_id, target)
    if reason:
        raise HTTPException(409, reason)

    async def _verify():
        # P5: recompute the gate at write time so a concurrent expense added between the check above
        # and the write below can't slip a now-unsettled member through (rolls back, raises 409).
        again = await _settlement_block_reason(trip_id, target)
        if again:
            raise HTTPException(409, again)

    await freeze_and_remove_member(
        trip_id, member_id, _weight_of_member(target),
        user_id=target.get("user_id"), verify=_verify,
    )
    return {"ok": True}


@router.delete("/trips/{trip_id}/members/{family_id}/family-members/{fm_id}")
async def delete_family_member(trip_id: str, family_id: str, fm_id: str,
                               user=Depends(get_current_user)):
    """Remove ONE member from inside a family, gated by settlement + the no-empty-family invariant.

    Allowed only when (1) the targeted family member's displayed net rounds to 0.00 and (2) at least
    one member remains afterward — the LAST member must be removed via whole-family removal
    (``DELETE /trips/{id}/members/{family_id}``), never by emptying the roster. The surviving rows
    keep their stable ids; ``reweight_past=False`` pins the family's OLD weight onto past PER_CAPITA
    expenses so the family's net — and every other balance — is unchanged.
    """
    trip = await _trip_admin_or_403(trip_id, user["id"])
    family = next((m for m in trip.get("members", []) if m["id"] == family_id), None)
    if not family or family.get("kind") != "family":
        raise HTTPException(404, "Family not found")
    names = family.get("family_members", []) or []
    ids = family_member_ids(family)  # padded, parallel to names (tolerates legacy rows w/o ids)
    if fm_id not in ids:
        raise HTTPException(404, "Family member not found")
    # HARD INVARIANT: never leave a family with zero members.
    if len(names) <= 1:
        raise HTTPException(
            409, "Cannot remove the last member of a family. Remove the family instead.",
        )
    idx = ids.index(fm_id)

    bal = await _compute_balances(trip_id)
    n = family_member_net(bal, family_id, fm_id)
    if n is None or not is_settled(n):
        who = names[idx] if idx < len(names) else "This member"
        raise HTTPException(409, f"{who} has an outstanding balance. Settle up before removing.")

    new_names = [nm for i, nm in enumerate(names) if i != idx]
    surviving_ids = [iid for i, iid in enumerate(ids) if i != idx]
    new_ids = assign_family_member_ids(new_names, surviving_ids)
    old_weight = _weight_of_member(family)
    new_weight = _weight_of_member({**family, "family_members": new_names})
    updates = {
        "members.$.family_members": new_names,
        "members.$.family_member_ids": new_ids,
    }
    await run_member_update_with_reallocation(
        trip_id, family_id, updates, old_weight, new_weight, reweight_past=False,
    )
    t = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    updated = next((m for m in t["members"] if m["id"] == family_id), None)
    # P5: consistent shape with delete_member ({"ok": True}); the family survives, so also return it.
    return {"ok": True, "member": updated}
