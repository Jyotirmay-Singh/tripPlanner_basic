"""Display-only per-expense shares derived from authoritative scaled split math."""

from services.calculator import allocate_within_family, _chosen_participants
from services.custom_split import exact_member_shares
from services.member_breakdown import family_member_ids
from services.settlement_engine import expense_entity_shares_scaled, scaled_number, to_scaled
from utils.money_policy import apportion_whole_amounts
from utils.display_names import family_member_display_names, member_display_names


def person_shares_for_entity(expense: dict, entity: dict, entity_share: object) -> tuple[dict, list]:
    """Shared whole-unit person amounts and actual participation (including rounded zeros).

    The entity amount comes from the authoritative split engine; this never changes it.
    Callers doing historical accounting must separately verify the roster's provenance.
    """
    frozen = [row for row in expense.get("_frozen_share_rows", []) if row["wallet_id"] == entity["id"]]
    if frozen:
        return ({row["person_id"]: scaled_number(to_scaled(row["original_share"])) for row in frozen},
                [row["person_id"] for row in frozen if row["participating"]])
    if entity.get("kind") != "family":
        person_id = str(entity["id"])
        exact = expense.get("original_custom_amounts") or expense.get("custom_amounts") or {}
        participating = expense.get("split_mode") != "EXACT" or to_scaled(exact.get(person_id) or 0) != 0
        return {person_id: entity_share}, [person_id] if participating else []
    roster = family_member_ids(entity)
    if not roster:
        return {}, []
    if expense.get("split_mode") == "EXACT":
        allocated = exact_member_shares(expense.get("custom_amounts"), roster)
        original = expense.get("original_custom_amounts") or expense.get("custom_amounts") or {}
        chosen = [person_id for person_id in roster if to_scaled(original.get(person_id) or 0) != 0]
    else:
        chosen = _chosen_participants((expense.get("family_participants") or {}).get(entity["id"]), roster)
        allocated = allocate_within_family(entity_share, chosen, roster)
    nonzero = [person_id for person_id in roster if allocated[person_id] != 0]
    amounts = apportion_whole_amounts(
        {person_id: allocated[person_id] for person_id in nonzero}, nonzero, entity_share,
    ) if nonzero else {}
    return {person_id: amounts.get(person_id, 0) for person_id in roster}, chosen


def _apportion(raw: dict, order: list, target: float, currency: str) -> dict:
    """Whole-unit allocation whose values add exactly to the stored total."""
    return apportion_whole_amounts(raw, order, target)


def entity_shares_raw(expense: dict, members: list) -> dict:
    """Exact per-entity shares, converted to numbers only at the display boundary."""

    _amount, _payer_id, shares = expense_entity_shares_scaled(expense, members)
    return {member_id: scaled_number(shares[member_id]) for member_id in sorted(shares)}


def expense_share_breakdown(expense: dict, members: list) -> dict:
    """Build the read-time entity/family-member share payload shown by the app."""

    members = expense.get("_revision_members_snapshot") or members
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
                sub_shares, _participants = person_shares_for_entity(expense, member, shown[entity_id])
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
