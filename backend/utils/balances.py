"""Authoritative trip balance calculation and derived settlement projection."""

from fastapi import HTTPException

from config import WHOLE_UNIT_SETTLEMENTS_ENABLED
from database import db
from services.member_breakdown import family_member_breakdown
from services.settlement_engine import (
    CENT_INCREMENT_SCALED,
    SettlementLedgerError,
    build_precise_net,
    build_settlement_projection,
    joint_round,
    scaled_number,
)


def _weight_of_member(member: dict) -> int:
    if member["kind"] == "family":
        return max(1, len(member.get("family_members", [])))
    return 1


async def _compute_balances(trip_id: str, *, diagnostic: bool = False) -> dict:
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    if not trip:
        raise HTTPException(404, "Trip not found")
    members = trip["members"]

    # Canonical expense amounts were fixed when saved. Settlement never calls the FX service and
    # never mutates historical conversion metadata. There is deliberately no accounting row cap.
    expenses = await db.expenses.find({"trip_id": trip_id}, {"_id": 0}).to_list(None)
    settlements = await db.settlements.find(
        {"trip_id": trip_id, "status": {"$ne": "pending"}}, {"_id": 0}
    ).to_list(None)
    payments = await db.payments.find({"trip_id": trip_id}, {"_id": 0}).to_list(None)

    try:
        precise_net = build_precise_net(members, expenses, settlements, payments)

        # Keep the legacy numeric ``net`` response at two decimals, but round it jointly so it is
        # conserving. Whole-unit balances are additive metadata under settlement_projection.
        compatibility_counts = joint_round(precise_net, CENT_INCREMENT_SCALED)
        net = {
            member_id: scaled_number(count * CENT_INCREMENT_SCALED)
            for member_id, count in compatibility_counts.items()
        }
        transfers, projection = build_settlement_projection(
            precise_net,
            trip.get("currency", "INR"),
            whole_unit_enabled=WHOLE_UNIT_SETTLEMENTS_ENABLED,
        )
    except SettlementLedgerError as exc:
        generic = (
            "Settlement is temporarily unavailable because this trip's ledger needs review. "
            "Ask a trip admin."
        )
        detail = f"{generic} [{exc.code}: {exc}]" if diagnostic else generic
        raise HTTPException(status_code=409, detail=detail) from exc

    # Display-only family positions replay the same effective events and reconcile to the compatible
    # two-decimal family net. They never drive recommendations.
    breakdown = family_member_breakdown(members, expenses, settlements + payments, net)

    return {
        "net": net,
        "transfers": transfers,
        "members": members,
        "currency": trip.get("currency", "INR"),
        "settlement_projection": projection,
        "per_person": [
            {
                "member_id": member["id"],
                "member_name": member["name"],
                "kind": member["kind"],
                "people_count": _weight_of_member(member),
                "net_total": net.get(member["id"], 0.0),
                "net_per_person": round(
                    net.get(member["id"], 0.0) / _weight_of_member(member), 2
                ),
                "family_members": member.get("family_members", []),
                "members": breakdown.get(member["id"], []),
            }
            for member in members
        ],
    }
