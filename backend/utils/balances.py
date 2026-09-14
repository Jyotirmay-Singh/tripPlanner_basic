"""Authoritative trip balance calculation and derived settlement projection."""

from decimal import Decimal

from fastapi import HTTPException

from database import db
from services.member_breakdown import family_member_breakdown
from services.settlement_engine import (
    SettlementLedgerError,
    apply_migration_adjustments,
    build_precise_net,
    build_settlement_projection,
    joint_round,
    scaled_number,
    settlement_increment,
)
from utils.money_policy import whole_money


def _weight_of_member(member: dict) -> int:
    if member["kind"] == "family":
        return max(1, len(member.get("family_members", [])))
    return 1


async def _compute_balances(
    trip_id: str,
    *,
    diagnostic: bool = False,
    session=None,
) -> dict:
    session_options = {"session": session} if session is not None else {}
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0}, **session_options)
    if not trip:
        raise HTTPException(404, "Trip not found")
    members = trip["members"]

    # Canonical expense amounts were fixed when saved. Settlement never calls the FX service and
    # never mutates historical conversion metadata. There is deliberately no accounting row cap.
    expenses = await db.expenses.find(
        {"trip_id": trip_id}, {"_id": 0}, **session_options
    ).to_list(None)
    settlements = await db.settlements.find(
        {"trip_id": trip_id, "status": {"$ne": "pending"}}, {"_id": 0}, **session_options
    ).to_list(None)
    payments = await db.payments.find(
        {"trip_id": trip_id}, {"_id": 0}, **session_options
    ).to_list(None)
    adjustment_collection = getattr(db, "money_migration_adjustments", None)
    migration_adjustment = await adjustment_collection.find_one(
        {"trip_id": trip_id}, {"_id": 0}, **session_options
    ) if adjustment_collection is not None else None

    try:
        precise_net = build_precise_net(members, expenses, settlements, payments)
        precise_net = apply_migration_adjustments(
            precise_net,
            (migration_adjustment or {}).get("vector"),
        )

        # Keep the legacy numeric ``net`` response shape while jointly projecting every currency to
        # the application-wide one-major-unit increment so the vector remains conserving.
        currency = trip.get("currency", "INR")
        compatibility_increment, _ = settlement_increment(currency, True)
        compatibility_counts = joint_round(precise_net, compatibility_increment)
        net = {
            member_id: scaled_number(count * compatibility_increment)
            for member_id, count in compatibility_counts.items()
        }
        transfers, projection = build_settlement_projection(
            precise_net,
            currency,
            whole_unit_enabled=True,
        )
    except SettlementLedgerError as exc:
        generic = (
            "Settlement is temporarily unavailable because this trip's ledger needs review. "
            "Ask a trip admin."
        )
        detail = f"{generic} [{exc.code}: {exc}]" if diagnostic else generic
        raise HTTPException(status_code=409, detail=detail) from exc

    # Display-only family positions replay the same effective events and reconcile to the compatible
    # currency-rounded family net. They never drive recommendations.
    breakdown = family_member_breakdown(
        members, expenses, settlements + payments, net, trip.get("currency", "INR")
    )

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
                "net_per_person": whole_money(
                    Decimal(str(net.get(member["id"], 0)))
                    / Decimal(_weight_of_member(member)),
                    label="Per-person balance",
                    reject_nonzero_to_zero=False,
                ),
                "family_members": member.get("family_members", []),
                "members": breakdown.get(member["id"], []),
            }
            for member in members
        ],
    }
