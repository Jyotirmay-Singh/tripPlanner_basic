"""Settlement-aware authorization shared by group deletion entry points."""

from fastapi import HTTPException

from services.coverage_support import CoverageError
from services.expense_coverage import build_coverage_snapshot
from utils.balances import project_ledger_balances
from utils.permissions import can_delete_trip, is_super_admin, viewer_id


def require_trip_deletion_allowed(ledger, viewer) -> None:
    trip = ledger.trip
    if not can_delete_trip(trip, viewer):
        raise HTTPException(403, "Only the group owner or application admin can delete this group")

    balances = project_ledger_balances(ledger)
    settled = (
        balances["settlement_projection"]["status"] == "settled_exactly"
        and not balances["transfers"]
    )
    if settled:
        settled = not build_coverage_snapshot(ledger, infer_history=False).pending_reports
    if settled and trip.get("expense_settlement_schema_version") == 2:
        from services.roster_corrections import people, removal_blockers

        try:
            removal_blockers(
                ledger,
                set(people(trip["members"])),
                {member["id"] for member in (ledger.accounting_members or trip["members"])},
            )
        except CoverageError as exc:
            if exc.code not in {
                "financial_departure_blocked",
                "financial_credit_departure_blocked",
                "financial_review_departure_blocked",
                "financial_report_departure_blocked",
            }:
                raise
            settled = False

    if settled:
        if viewer_id(viewer) != trip.get("owner_id"):
            raise HTTPException(403, "Only the group owner can delete a fully settled group")
    elif not is_super_admin(viewer):
        raise HTTPException(409,
            "This group must be fully settled before its owner can delete it. "
            "Only an application admin can delete an unsettled group.")
