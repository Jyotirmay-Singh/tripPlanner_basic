"""Deterministic, conserving settlement projection over a precise ledger.

The expense ledger remains authoritative at ``BALANCE_SCALE`` decimal places. Settlement
recommendations are a projection: member balances are rounded together so the rounded vector
still sums to zero, then routed using integer arithmetic only. This module is pure and never reads
the database or fetches an exchange rate; callers pass stored canonical trip-currency amounts.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import heapq
from typing import Iterable, Mapping

from services.member_breakdown import family_member_ids


BALANCE_SCALE = 12
SCALE = 10 ** BALANCE_SCALE
QUANTUM = Decimal(1).scaleb(-BALANCE_SCALE)
CENT_INCREMENT_SCALED = SCALE // 100
WHOLE_UNIT_CURRENCIES = frozenset({"LKR", "NPR"})
POLICY_VERSION = "whole_unit_v1"
COMPATIBILITY_POLICY_VERSION = "cent_projection_v1"
ROUNDING_ALGORITHM = "joint_largest_remainder_v1"
ROUNDING_TIE_BREAK = "toward_zero_then_member_id"
EXACT_ENTITY_LIMIT = 12
EXACT_STATE_LIMIT = 100_000


class SettlementLedgerError(ValueError):
    """The persisted canonical ledger cannot safely produce a settlement projection."""

    def __init__(self, message: str, *, code: str = "invalid_ledger") -> None:
        super().__init__(message)
        self.code = code


class _SearchLimitReached(RuntimeError):
    pass


@dataclass(frozen=True)
class RoutingResult:
    transfers: tuple[dict, ...]
    algorithm: str
    optimal: bool
    states_explored: int
    fallback_reason: str | None = None


def to_scaled(value: object, *, field: str = "amount") -> int:
    """Parse a persisted numeric value without making a binary-float rounding decision."""

    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise SettlementLedgerError(f"{field} is not a valid number") from exc
    if not parsed.is_finite():
        raise SettlementLedgerError(f"{field} must be finite")
    with localcontext() as context:
        context.prec = 60
        quantized = parsed.quantize(QUANTUM, rounding=ROUND_HALF_UP)
        return int((quantized * SCALE).to_integral_exact())


def scaled_decimal(units: int) -> Decimal:
    with localcontext() as context:
        context.prec = 60
        return Decimal(units) / Decimal(SCALE)


def scaled_string(units: int) -> str:
    """Fixed-width, API-safe decimal representation of scaled ledger units."""

    sign = "-" if units < 0 else ""
    magnitude = abs(units)
    whole, fraction = divmod(magnitude, SCALE)
    return f"{sign}{whole}.{fraction:0{BALANCE_SCALE}d}"


def scaled_number(units: int) -> float:
    return float(scaled_decimal(units))


def allocate_weighted(total: int, weights: Mapping[str, int]) -> dict[str, int]:
    """Allocate signed scaled units by integer weights while conserving ``total`` exactly."""

    normalized: dict[str, int] = {}
    for member_id, raw_weight in weights.items():
        try:
            weight = int(raw_weight)
        except (TypeError, ValueError) as exc:
            raise SettlementLedgerError(f"Invalid split weight for member '{member_id}'") from exc
        if weight < 0:
            raise SettlementLedgerError(f"Split weight cannot be negative for member '{member_id}'")
        if weight:
            normalized[str(member_id)] = weight
    denominator = sum(normalized.values())
    if denominator <= 0:
        raise SettlementLedgerError("Expense has no positive split weight")

    sign = -1 if total < 0 else 1
    magnitude = abs(total)
    bases: dict[str, int] = {}
    remainders: dict[str, int] = {}
    for member_id in sorted(normalized):
        base, remainder = divmod(magnitude * normalized[member_id], denominator)
        bases[member_id] = base
        remainders[member_id] = remainder

    needed = magnitude - sum(bases.values())
    if needed < 0 or needed >= len(bases):
        raise SettlementLedgerError("Weighted allocation could not be conserved")
    ranking = sorted(bases, key=lambda member_id: (-remainders[member_id], member_id))
    for member_id in ranking[:needed]:
        bases[member_id] += 1
    allocation = {
        member_id: sign * bases[member_id]
        for member_id in sorted(bases)
    }
    if sum(allocation.values()) != total:
        raise SettlementLedgerError("Weighted allocation does not match the expense total")
    return allocation


def _family_roster(member: dict) -> list[str]:
    return [str(member_id) for member_id in family_member_ids(member)]


def _chosen_participant_count(participant_ids: Iterable[str], roster: list[str]) -> int:
    roster = list(dict.fromkeys(roster))
    if not roster:
        return 0
    selected = set(participant_ids or [])
    chosen = [member_id for member_id in roster if member_id in selected]
    return len(chosen or roster)


def _expense_weights(expense: dict, split_ids: list[str], members_by_id: Mapping[str, dict]) -> dict[str, int]:
    snapshots = expense.get("weight_snapshots") or {}
    participants = expense.get("family_participants") or {}
    weights: dict[str, int] = {}
    for member_id in split_ids:
        member = members_by_id[member_id]
        if member_id in snapshots:
            weight = int(snapshots[member_id])
        elif member.get("kind") == "family" and member_id in participants:
            weight = _chosen_participant_count(participants[member_id], _family_roster(member))
        elif member.get("kind") == "family":
            weight = max(1, len(member.get("family_members") or []))
        else:
            weight = 1
        weights[member_id] = weight
    return weights


def _person_to_entity(members: Iterable[dict]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for member in members:
        entity_id = str(member["id"])
        if member.get("kind") == "family":
            for person_id in _family_roster(member):
                if person_id in mapping:
                    raise SettlementLedgerError(f"Duplicate family member ID '{person_id}'")
                mapping[person_id] = entity_id
        else:
            mapping[entity_id] = entity_id
    return mapping


def _exact_entity_shares(expense: dict, members: list[dict], amount: int) -> dict[str, int]:
    custom_amounts = expense.get("custom_amounts") or {}
    if not custom_amounts:
        raise SettlementLedgerError(
            f"Exact expense '{expense.get('id', '?')}' has no allocations",
            code="invalid_exact_split",
        )
    owner_by_person = _person_to_entity(members)
    shares: dict[str, int] = {}
    unknown_people: list[tuple[str, object]] = []
    for person_id, raw_amount in custom_amounts.items():
        person_id = str(person_id)
        entity_id = owner_by_person.get(person_id)
        if entity_id is None:
            unknown_people.append((person_id, raw_amount))
            continue
        share = to_scaled(raw_amount, field=f"exact share for '{person_id}'")
        shares[entity_id] = shares.get(entity_id, 0) + share

    if unknown_people:
        # A removed family leaves its entity ID in split_member_ids and its former person IDs in
        # custom_amounts. The current roster can no longer reconstruct that mapping, but when exactly
        # one historical family participated the allocation is unambiguous. build_precise_net later
        # requires that historical entity's complete ledger position to be exactly zero before it is
        # omitted from current recommendations.
        custom_ids = {str(person_id) for person_id in custom_amounts}
        historical_entities = sorted(
            str(member["id"])
            for member in members
            if member.get("_historical")
            and str(member["id"]) in {
                str(member_id) for member_id in (expense.get("split_member_ids") or [])
            }
            and str(member["id"]) not in custom_ids
        )
        if len(historical_entities) != 1:
            people = ", ".join(person_id for person_id, _amount in unknown_people)
            raise SettlementLedgerError(
                f"Exact expense '{expense.get('id', '?')}' references unknown person(s): {people}",
                code="unknown_member",
            )
        historical_id = historical_entities[0]
        shares[historical_id] = shares.get(historical_id, 0) + sum(
            (
                to_scaled(raw_amount, field=f"exact share for '{person_id}'")
                for person_id, raw_amount in unknown_people
            ),
            0,
        )
    if sum(shares.values()) != amount:
        raise SettlementLedgerError(
            f"Exact expense '{expense.get('id', '?')}' allocations total "
            f"{scaled_string(sum(shares.values()))}, expected {scaled_string(amount)}",
            code="invalid_exact_split",
        )
    return shares


def expense_entity_shares_scaled(expense: dict, members: Iterable[dict]) -> tuple[int, str, dict[str, int]]:
    """Return ``(amount, payer_id, shares)`` using the authoritative scaled split math."""

    member_list = list(members)
    members_by_id = {str(member["id"]): member for member in member_list}
    if len(members_by_id) != len(member_list):
        raise SettlementLedgerError("Trip contains duplicate member IDs", code="duplicate_member")
    expense_id = expense.get("id", "?")
    amount = to_scaled(expense.get("amount"), field=f"expense '{expense_id}' amount")
    payer_id = str(expense.get("paid_by_member_id", ""))
    if not members_by_id:
        return amount, payer_id, {}
    if payer_id not in members_by_id:
        raise SettlementLedgerError(
            f"Expense '{expense_id}' references unknown payer '{payer_id}'",
            code="unknown_member",
        )
    raw_split_ids = expense.get("split_member_ids") or list(members_by_id)
    split_ids = sorted({str(member_id) for member_id in raw_split_ids})
    # Settled member removal deliberately keeps historical expense rows. Preserve the old engine's
    # ability to replay those rows by using an entity-sized placeholder; snapshots still supply a
    # removed family's historical PER_CAPITA weight. An unresolved historical position is rejected
    # after the complete ledger (including payments) is replayed, never silently discarded.
    for member_id in sorted({payer_id, *split_ids} - set(members_by_id)):
        placeholder = {"id": member_id, "kind": "individual", "_historical": True}
        member_list.append(placeholder)
        members_by_id[member_id] = placeholder

    mode = expense.get("split_mode", "PER_CAPITA")
    if mode == "EXACT":
        shares = _exact_entity_shares(expense, member_list, amount)
    elif mode == "PER_CAPITA":
        weights = _expense_weights(expense, split_ids, members_by_id)
        shares = allocate_weighted(amount, weights) if sum(weights.values()) > 0 else {}
    elif mode == "PER_FAMILY":
        shares = allocate_weighted(amount, {member_id: 1 for member_id in split_ids})
    else:
        raise SettlementLedgerError(
            f"Expense '{expense_id}' has unsupported split mode '{mode}'",
            code="invalid_split_mode",
        )
    return amount, payer_id, shares


def build_precise_net(
    members: Iterable[dict],
    expenses: Iterable[dict],
    settlements: Iterable[dict] = (),
    payments: Iterable[dict] = (),
) -> dict[str, int]:
    """Build the canonical signed net vector in 12-decimal scaled integers."""

    member_list = list(members)
    members_by_id = {str(member["id"]): member for member in member_list}
    if len(members_by_id) != len(member_list):
        raise SettlementLedgerError("Trip contains duplicate member IDs", code="duplicate_member")
    net = {member_id: 0 for member_id in sorted(members_by_id)}

    for expense in expenses:
        amount, payer_id, shares = expense_entity_shares_scaled(expense, member_list)
        if not shares:
            continue

        for member_id, share in shares.items():
            net[member_id] = net.get(member_id, 0) - share
        net[payer_id] = net.get(payer_id, 0) + amount

    def apply_overlay(record: dict, kind: str) -> None:
        from_id = str(record.get("from_member_id", ""))
        to_id = str(record.get("to_member_id", ""))
        net.setdefault(from_id, 0)
        net.setdefault(to_id, 0)
        record_id = record.get("id", "?")
        amount = to_scaled(record.get("amount"), field=f"{kind} '{record_id}' amount")
        net[from_id] += amount
        net[to_id] -= amount

    for settlement in settlements:
        if settlement.get("status") == "pending":
            continue
        apply_overlay(settlement, "settlement")
    for payment in payments:
        apply_overlay(payment, "payment")

    current_member_ids = set(members_by_id)
    unresolved_historical = {
        member_id: value
        for member_id, value in net.items()
        if member_id not in current_member_ids and value
    }
    if unresolved_historical:
        summary = ", ".join(
            f"{member_id}={scaled_string(value)}"
            for member_id, value in sorted(unresolved_historical.items())
        )
        raise SettlementLedgerError(
            f"Historical member balance is not settled exactly ({summary})",
            code="orphaned_member_balance",
        )
    net = {member_id: net.get(member_id, 0) for member_id in sorted(current_member_ids)}

    imbalance = sum(net.values())
    if imbalance:
        raise SettlementLedgerError(
            f"Canonical net vector is out of balance by {scaled_string(imbalance)}",
            code="ledger_imbalance",
        )
    return net


def joint_round(net: Mapping[str, int], increment: int) -> dict[str, int]:
    """Round a zero-sum scaled vector jointly to signed counts of ``increment``."""

    if increment <= 0:
        raise ValueError("Settlement increment must be positive")
    normalized = {str(member_id): int(value) for member_id, value in net.items()}
    imbalance = sum(normalized.values())
    if imbalance:
        raise SettlementLedgerError(
            f"Cannot round an imbalanced net vector ({scaled_string(imbalance)})",
            code="ledger_imbalance",
        )

    bases: dict[str, int] = {}
    remainders: dict[str, int] = {}
    for member_id in sorted(normalized):
        base, remainder = divmod(normalized[member_id], increment)
        bases[member_id] = base
        remainders[member_id] = remainder
    needed = -sum(bases.values())
    if needed < 0 or needed > len(bases):
        raise SettlementLedgerError("Joint rounding could not conserve the balance vector")

    ranking = sorted(
        bases,
        key=lambda member_id: (
            -remainders[member_id],
            0 if bases[member_id] < 0 else 1,
            member_id,
        ),
    )
    rounded = dict(bases)
    for member_id in ranking[:needed]:
        rounded[member_id] += 1
    if sum(rounded.values()) != 0:
        raise SettlementLedgerError("Rounded net vector is not balanced")
    return {member_id: rounded[member_id] for member_id in sorted(rounded)}


def _greedy_route(net_units: Mapping[str, int]) -> tuple[dict, ...]:
    debtors = [(-abs(value), member_id, abs(value)) for member_id, value in net_units.items() if value < 0]
    creditors = [(-value, member_id, value) for member_id, value in net_units.items() if value > 0]
    heapq.heapify(debtors)
    heapq.heapify(creditors)
    transfers: list[dict] = []
    while debtors and creditors:
        _debtor_key, debtor_id, owed = heapq.heappop(debtors)
        _creditor_key, creditor_id, due = heapq.heappop(creditors)
        paid = min(owed, due)
        transfers.append(
            {"from_member_id": debtor_id, "to_member_id": creditor_id, "amount_units": paid}
        )
        owed -= paid
        due -= paid
        if owed:
            heapq.heappush(debtors, (-owed, debtor_id, owed))
        if due:
            heapq.heappush(creditors, (-due, creditor_id, due))
    if debtors or creditors:
        raise SettlementLedgerError("Routing ended with an unmatched balance", code="ledger_imbalance")
    return tuple(transfers)


def _exact_zero_sum_groups(net_units: Mapping[str, int], state_limit: int) -> tuple[tuple[tuple[str, ...], ...], int]:
    ids = tuple(sorted(member_id for member_id, value in net_units.items() if value))
    values = tuple(net_units[member_id] for member_id in ids)
    full_mask = (1 << len(ids)) - 1
    memo: dict[int, tuple[tuple[str, ...], ...]] = {0: ()}
    states_explored = 0

    def solve(mask: int) -> tuple[tuple[str, ...], ...]:
        nonlocal states_explored
        cached = memo.get(mask)
        if cached is not None:
            return cached
        first_bit = mask & -mask
        rest = mask ^ first_bit
        candidates: list[int] = []
        submask = rest
        while True:
            states_explored += 1
            if states_explored > state_limit:
                raise _SearchLimitReached
            group_mask = first_bit | submask
            if sum(values[index] for index in range(len(ids)) if group_mask & (1 << index)) == 0:
                candidates.append(group_mask)
            if submask == 0:
                break
            submask = (submask - 1) & rest

        candidates.sort(
            key=lambda group_mask: (
                group_mask.bit_count(),
                tuple(ids[index] for index in range(len(ids)) if group_mask & (1 << index)),
            )
        )
        best: tuple[tuple[str, ...], ...] | None = None
        for group_mask in candidates:
            group = tuple(ids[index] for index in range(len(ids)) if group_mask & (1 << index))
            candidate = (group,) + solve(mask ^ group_mask)
            if best is None or len(candidate) > len(best) or (
                len(candidate) == len(best) and candidate < best
            ):
                best = candidate
        if best is None:
            raise SettlementLedgerError("Exact routing could not partition the balanced vector")
        memo[mask] = best
        return best

    return solve(full_mask), states_explored


def route_integer_balances(
    rounded_units: Mapping[str, int],
    *,
    exact_entity_limit: int = EXACT_ENTITY_LIMIT,
    state_limit: int = EXACT_STATE_LIMIT,
) -> RoutingResult:
    """Route signed integer balances with exact optimization for bounded small groups."""

    normalized = {str(member_id): int(value) for member_id, value in rounded_units.items()}
    if sum(normalized.values()):
        raise SettlementLedgerError("Cannot route an imbalanced rounded vector", code="ledger_imbalance")
    nonzero = {member_id: value for member_id, value in normalized.items() if value}
    if not nonzero:
        return RoutingResult((), "exact_dfs_v1", True, 0)

    fallback_reason: str | None = None
    explored = 0
    if len(nonzero) <= exact_entity_limit:
        try:
            groups, explored = _exact_zero_sum_groups(nonzero, state_limit)
            transfers: list[dict] = []
            for group in groups:
                transfers.extend(_greedy_route({member_id: nonzero[member_id] for member_id in group}))
            expected_count = len(nonzero) - len(groups)
            if len(transfers) != expected_count:
                raise SettlementLedgerError("Exact routing produced a non-minimal component plan")
            return RoutingResult(tuple(transfers), "exact_dfs_v1", True, explored)
        except _SearchLimitReached:
            fallback_reason = "state_limit"
            explored = state_limit
    else:
        fallback_reason = "entity_limit"

    return RoutingResult(
        _greedy_route(nonzero),
        "greedy_heap_v1",
        False,
        explored,
        fallback_reason,
    )


def settlement_increment(currency: str, whole_unit_enabled: bool) -> tuple[int, bool]:
    enabled = bool(whole_unit_enabled and str(currency).upper() in WHOLE_UNIT_CURRENCIES)
    return (SCALE if enabled else CENT_INCREMENT_SCALED), enabled


def build_settlement_projection(
    precise_net: Mapping[str, int],
    currency: str,
    *,
    whole_unit_enabled: bool,
    exact_entity_limit: int = EXACT_ENTITY_LIMIT,
    state_limit: int = EXACT_STATE_LIMIT,
) -> tuple[list[dict], dict]:
    increment, enabled = settlement_increment(currency, whole_unit_enabled)
    rounded_counts = joint_round(precise_net, increment)
    routing = route_integer_balances(
        rounded_counts,
        exact_entity_limit=exact_entity_limit,
        state_limit=state_limit,
    )
    transfers = []
    for transfer in routing.transfers:
        amount = (
            transfer["amount_units"]
            if enabled
            else scaled_number(transfer["amount_units"] * increment)
        )
        transfers.append({
            "from_member_id": transfer["from_member_id"],
            "to_member_id": transfer["to_member_id"],
            "amount": amount,
        })
    rounded_scaled = {member_id: count * increment for member_id, count in rounded_counts.items()}
    exact_zero = all(value == 0 for value in precise_net.values())
    status = "settled_exactly" if exact_zero else ("settled_within_rounding" if not transfers else "open")

    def projected_number(value: int) -> int | float:
        return value // SCALE if enabled else scaled_number(value)

    ordered_ids = sorted(str(member_id) for member_id in precise_net)
    projection = {
        "enabled": enabled,
        "currency": str(currency).upper(),
        "increment": "1" if enabled else "0.01",
        "balance_scale": BALANCE_SCALE,
        "policy_version": POLICY_VERSION if enabled else COMPATIBILITY_POLICY_VERSION,
        "status": status,
        "precise_net": {member_id: scaled_string(int(precise_net[member_id])) for member_id in ordered_ids},
        "rounded_net": {member_id: projected_number(rounded_scaled[member_id]) for member_id in ordered_ids},
        "rounding_adjustments": {
            member_id: scaled_string(rounded_scaled[member_id] - int(precise_net[member_id]))
            for member_id in ordered_ids
        },
        "rounding_algorithm": ROUNDING_ALGORITHM,
        "tie_break": ROUNDING_TIE_BREAK,
        "routing": {
            "algorithm": routing.algorithm,
            "optimal": routing.optimal,
            "states_explored": routing.states_explored,
            "fallback_reason": routing.fallback_reason,
            "transfer_count_bound": max(
                0,
                sum(1 for value in rounded_counts.values() if value < 0)
                + sum(1 for value in rounded_counts.values() if value > 0)
                - 1,
            ),
        },
    }
    return transfers, projection
