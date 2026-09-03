"""Display-only per-expense shares derived from authoritative scaled split math."""

import math

from services.calculator import allocate_within_family
from services.custom_split import exact_member_shares
from services.member_breakdown import family_member_ids
from services.settlement_engine import expense_entity_shares_scaled, scaled_number
from utils.display_names import family_member_display_names, member_display_names


def _apportion(raw: dict, order: list, target: float) -> dict:
    """Largest-remainder cent display whose values add to the shown target."""

    target_cents = round(target * 100)
    bases: dict = {}
    remainders: dict = {}
    for key in order:
        scaled = raw[key] * 100
        base = math.floor(scaled + 1e-9)
        bases[key] = base
        remainders[key] = scaled - base
    needed = target_cents - sum(bases.values())
    result = dict(bases)
    if needed > 0:
        ranking = sorted(order, key=lambda key: (-remainders[key], str(key)))
        for key in ranking[:needed]:
            result[key] += 1
    elif needed < 0:
        ranking = sorted(order, key=lambda key: (remainders[key], str(key)))
        for key in ranking[:-needed]:
            result[key] -= 1
    return {key: result[key] / 100.0 for key in order}


def entity_shares_raw(expense: dict, members: list) -> dict:
    """Exact per-entity shares, converted to numbers only at the display boundary."""

    _amount, _payer_id, shares = expense_entity_shares_scaled(expense, members)
    return {member_id: scaled_number(shares[member_id]) for member_id in sorted(shares)}


def expense_share_breakdown(expense: dict, members: list) -> dict:
    """Build the read-time entity/family-member share payload shown by the app."""

    members_by_id = {member["id"]: member for member in members}
    names = member_display_names(members)
    raw = entity_shares_raw(expense, members)
    output = {
        "mode": expense.get("split_mode") or "PER_CAPITA",
        "payer_id": expense.get("paid_by_member_id"),
        "amount": expense.get("amount", 0.0),
        "entities": [],
    }
    if not raw:
        return output

    order = sorted(raw)
    shown = _apportion(raw, order, output["amount"])
    family_participants = expense.get("family_participants") or {}
    for entity_id in order:
        member = members_by_id.get(entity_id)
        entity = {
            "id": entity_id,
            "name": names.get(entity_id, "?"),
            "share": shown[entity_id],
            "is_payer": entity_id == output["payer_id"],
            "members": [],
        }
        if member and member.get("kind") == "family":
            roster_ids = family_member_ids(member)
            if roster_ids:
                roster_names = family_member_display_names(member)
                if output["mode"] == "EXACT":
                    allocated = exact_member_shares(expense.get("custom_amounts"), roster_ids)
                else:
                    allocated = allocate_within_family(
                        shown[entity_id], family_participants.get(entity_id), roster_ids
                    )
                participants = [person_id for person_id in roster_ids if allocated[person_id] != 0.0]
                sub_shares = _apportion(
                    {person_id: allocated[person_id] for person_id in participants},
                    participants,
                    shown[entity_id],
                ) if participants else {}
                entity["members"] = [
                    {
                        "id": roster_ids[index],
                        "name": roster_names[index],
                        "share": sub_shares.get(roster_ids[index], 0.0),
                    }
                    for index in range(len(roster_ids))
                ]
        output["entities"].append(entity)
    return output
