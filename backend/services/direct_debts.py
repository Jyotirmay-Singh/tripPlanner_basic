"""Direct pair debts, with completed simplified settlements retained as carry-over.

All arithmetic uses the settlement engine's scaled integers and expense allocations. A
payment's mode is immutable ledger context: changing the trip setting never rewrites money.
"""

from datetime import datetime, timezone
from typing import Mapping

from services.settlement_engine import (
    SCALE,
    SettlementLedgerError,
    expense_entity_shares_scaled,
    route_integer_balances,
    to_scaled,
)


def settlement_mode(trip: dict) -> str:
    return "direct" if trip.get("simplify_debts", True) is False else "simplified"


def _add(graph: dict, payer: str, receiver: str, amount: int) -> None:
    if payer == receiver or not amount:
        return
    pair = tuple(sorted((payer, receiver)))
    value = graph.get(pair, 0) + (amount if payer == pair[0] else -amount)
    if value:
        graph[pair] = value
    else:
        graph.pop(pair, None)


def _net(graph: dict, member_ids=()) -> dict[str, int]:
    result = {member_id: 0 for member_id in member_ids}
    for (left, right), amount in graph.items():
        result[left] = result.get(left, 0) - amount
        result[right] = result.get(right, 0) + amount
    return result


def _route_into(graph: dict, net: Mapping[str, int]) -> None:
    for transfer in route_integer_balances(net).transfers:
        _add(graph, transfer["from_member_id"], transfer["to_member_id"], transfer["amount_units"])


def _event_key(record: dict, kind: str) -> tuple:
    raw = (record.get("paid_at") if kind == "settlement" else None) or record.get("created_at")
    if raw:
        try:
            stamp = raw if isinstance(raw, datetime) else datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            stamp = stamp.astimezone(timezone.utc)
        except (ValueError, TypeError, OverflowError):
            raw = None
    if not raw:
        # Undated legacy costs precede payments; undated payments close the dated history.
        stamp = datetime.min.replace(tzinfo=timezone.utc) if kind == "expense" \
            else datetime.max.replace(tzinfo=timezone.utc)
    return stamp, 0 if kind == "expense" else 1, str(record.get("id", "")), kind


def _remove_settled_historical_nodes(graph: dict, current_ids: set[str]) -> None:
    """Bypass already-departed zero-net entities without resurrecting their accounts."""
    for member_id in sorted(set(_net(graph)) - current_ids):
        incoming, outgoing = [], []
        for (left, right), value in sorted(graph.items()):
            payer, receiver = (left, right) if value > 0 else (right, left)
            if receiver == member_id:
                incoming.append([payer, abs(value)])
            if payer == member_id:
                outgoing.append([receiver, abs(value)])
        if sum(row[1] for row in incoming) != sum(row[1] for row in outgoing):
            raise SettlementLedgerError("Historical direct debt is not settled", code="orphaned_member_balance")
        i = j = 0
        while i < len(incoming) and j < len(outgoing):
            payer, debit = incoming[i]
            receiver, credit = outgoing[j]
            amount = min(debit, credit)
            _add(graph, payer, member_id, -amount)
            _add(graph, member_id, receiver, -amount)
            _add(graph, payer, receiver, amount)
            incoming[i][1] -= amount
            outgoing[j][1] -= amount
            if incoming[i][1] == 0:
                i += 1
            if outgoing[j][1] == 0:
                j += 1


def build_direct_projection(
    members: list[dict],
    expenses: list[dict],
    settlements: list[dict],
    payments: list[dict],
    precise_net: Mapping[str, int],
    projection: dict,
    migration_adjustments: Mapping[str, object] | None = None,
) -> tuple[list[dict], dict]:
    graph: dict[tuple[str, str], int] = {}
    # These private adjustments are historical carry-over, never new expenses or payments.
    if migration_adjustments:
        _route_into(graph, {str(mid): to_scaled(value) for mid, value in migration_adjustments.items()})
    events = [(expense, "expense") for expense in expenses]
    events.extend((row, "settlement") for row in settlements if row.get("status") != "pending")
    events.extend((row, "payment") for row in payments)
    events.sort(key=lambda event: _event_key(*event))
    for row, kind in events:
        if kind == "expense":
            _amount, payer, shares = expense_entity_shares_scaled(row, members)
            for member_id, share in shares.items():
                _add(graph, member_id, payer, share)
        else:
            if row.get("settlement_mode", "simplified") != "direct":
                carry_over: dict = {}
                _route_into(carry_over, _net(graph))
                graph = carry_over
            _add(graph, str(row.get("from_member_id", "")), str(row.get("to_member_id", "")),
                 -to_scaled(row.get("amount")))

    current_ids = {str(member["id"]) for member in members}
    _remove_settled_historical_nodes(graph, current_ids)
    if _net(graph, current_ids) != dict(precise_net):
        raise SettlementLedgerError("Direct debts disagree with canonical balances", code="direct_ledger_mismatch")

    # Jointly reconcile legacy fractional edges to the same conserving member vector as simplified
    # mode. Active whole-unit rows take this path without any correction or new relationships.
    rounded: dict = {}
    for (left, right), value in graph.items():
        count = (abs(value) + SCALE // 2) // SCALE
        _add(rounded, left, right, count if value > 0 else -count)
    rounded_net = _net(rounded, current_ids)
    residual = {mid: int(value) - rounded_net[mid] for mid, value in projection["rounded_net"].items()}
    _route_into(rounded, residual)
    if _net(rounded, current_ids) != projection["rounded_net"]:
        raise SettlementLedgerError("Direct rounding is not conserving", code="ledger_imbalance")
    transfers = []
    for (left, right), value in rounded.items():
        payer, receiver = (left, right) if value > 0 else (right, left)
        transfers.append({"from_member_id": payer, "to_member_id": receiver, "amount": abs(value)})
    transfers.sort(key=lambda row: (row["from_member_id"], row["to_member_id"]))
    result = {**projection, "settlement_mode": "direct"}
    result["routing"] = {
        "algorithm": "pairwise_v1", "optimal": False, "states_explored": 0,
        "fallback_reason": None, "transfer_count_bound": None,
    }
    result["status"] = "open" if transfers else (
        "settled_exactly" if not graph and not any(precise_net.values()) else "settled_within_rounding"
    )
    return transfers, result
