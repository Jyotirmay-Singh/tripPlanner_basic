"""Display-only per-expense shares derived from authoritative scaled split math."""

from services.calculator import allocate_within_family
from services.custom_split import exact_member_shares
from services.member_breakdown import family_member_ids
from services.settlement_engine import expense_entity_shares_scaled, scaled_number
from utils.currency_rules import apportion_currency_amounts
from utils.display_names import family_member_display_names, member_display_names


def _apportion(raw: dict, order: list, target: float, currency: str) -> dict:
    """Largest-remainder display whose values add in the currency's minor units."""
    return apportion_currency_amounts(raw, order, target, currency)


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
    currency = expense.get("currency") or "INR"
    shown = _apportion(raw, order, output["amount"], currency)
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
                    currency,
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
