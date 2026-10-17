"""Database-loading boundary for authoritative trip balances."""

from database import db
from services.ledger_snapshot import LedgerSnapshot, load_ledger
from services.balance_snapshot import _weight_of_member, compute_balance_snapshot


async def _compute_balances(trip_id: str, *, diagnostic: bool = False, session=None) -> dict:
    ledger = await load_ledger(trip_id, db, session=session)
    return project_ledger_balances(ledger, diagnostic=diagnostic)


def project_ledger_balances(ledger: LedgerSnapshot, *, diagnostic=False) -> dict:
    """Evaluate both settlement modes against the effective accounting ledger."""
    trip = {**ledger.trip, "members": ledger.accounting_members or ledger.trip["members"]}
    settlements = [row for row in ledger.settlements if row.get("status") != "pending"]
    return compute_balance_snapshot(
        trip, ledger.expenses, settlements, ledger.payments,
        {"vector": ledger.adjustments}, diagnostic=diagnostic,
    )
