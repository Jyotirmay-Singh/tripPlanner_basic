"""Reconciled, read-only report data shared by the spreadsheet and PDF renderers.

Amounts in the presentation model are whole major units. Immutable source records and the
authoritative scaled ledger remain unchanged; historical display bridges are explicit adjustments.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, localcontext
from typing import Any

from services.balance_snapshot import compute_balance_snapshot
from services.calculator import allocate_within_family
from services.member_breakdown import family_member_ids
from services.report_builder import composition_label, mode_label
from services.settlement_engine import (
    SCALE, build_precise_net, expense_entity_shares_scaled, joint_round, scaled_string, to_scaled,
)
from utils.display_names import family_member_display_names, member_display_names
from utils.money_policy import apportion_whole_amounts, decimal_money, whole_money
from utils.date_rules import trip_date_label


IST = timezone(timedelta(hours=5, minutes=30))


class ReportReconciliationError(ValueError):
    """A report cannot faithfully explain its source ledger."""


def units(value: Any) -> int:
    return whole_money(value, reject_nonzero_to_zero=False)


def parse_report_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        for pattern in ("%Y-%m-%d", "%d-%m-%y", "%d/%m/%Y"):
            try:
                return datetime.strptime(value.strip(), pattern).date()
            except ValueError:
                pass
    return None


def ist_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(IST).replace(tzinfo=None)
    except (ValueError, TypeError):
        return None


def _expense_time(value) -> time | None:
    try:
        return datetime.strptime(value, "%H:%M").time() if value else None
    except (ValueError, TypeError):
        return None


def expense_datetime(expense: dict) -> datetime | None:
    day = parse_report_date(expense.get("date"))
    return datetime.combine(day, _expense_time(expense.get("time")) or time()) if day else None


@dataclass(frozen=True)
class ReportSnapshot:
    trip: dict
    expenses: tuple[dict, ...] = ()
    settlements: tuple[dict, ...] = ()
    payments: tuple[dict, ...] = ()
    migration_adjustment: dict | None = None
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass(frozen=True)
class Allocation:
    expense_id: str
    number: int
    occurred_at: datetime | None
    category: str
    description: str
    entry_type: str
    payer_id: str
    payer: str
    account_id: str
    account: str
    person_id: str
    person: str
    split_method: str
    expense_amount: int
    share: int
    original_amount: Any = None
    original_currency: str = ""
    exchange_rate: str = "1"
    rate_date: date | None = None
    rate_provider: str = "identity"
    rate_mode: str = "automatic"
    original_exact: str = ""
    date_source: str = ""
    rate_requested_date: date | None = None
    time_recorded: bool = False


@dataclass(frozen=True)
class SettlementEvent:
    source_id: str
    source: str
    payer_id: str
    receiver_id: str
    payer: str
    receiver: str
    amount: int
    occurred_at: datetime | None
    note: str
    status: str


@dataclass(frozen=True)
class Adjustment:
    account_id: str
    account: str
    kind: str
    amount: int
    explanation: str


@dataclass(frozen=True)
class AccountSummary:
    account_id: str
    name: str
    kind: str
    share: int
    gross_funded: int
    money_back: int
    funded: int
    sent: int
    received: int
    adjustment: int
    balance: int

    @property
    def before_settlements(self) -> int:
        return self.funded - self.share

    @property
    def action(self) -> str:
        return "Receive" if self.balance > 0 else "Pay" if self.balance < 0 else "Settled"


@dataclass(frozen=True)
class MemberPosition:
    account_id: str
    person_id: str
    name: str
    share: int
    balance: int | None


@dataclass(frozen=True)
class SuggestedTransfer:
    payer_id: str
    receiver_id: str
    payer: str
    receiver: str
    amount: int


@dataclass(frozen=True)
class ReportMetadata:
    trip_name: str
    trip_dates: str
    expense_dates: str
    settlement_dates: str
    exported_at: datetime
    composition: str
    currency: str
    budget: int | None
    share_code: str


@dataclass(frozen=True)
class ReportData:
    snapshot: ReportSnapshot
    metadata: ReportMetadata
    balances: dict
    transfers: tuple[SuggestedTransfer, ...]
    allocations: tuple[Allocation, ...]
    accounts: tuple[AccountSummary, ...]
    member_positions: tuple[MemberPosition, ...]
    events: tuple[SettlementEvent, ...]
    adjustments: tuple[Adjustment, ...]
    categories: tuple[str, ...]
    category_totals: dict[str, int]
    gross: int
    money_back: int
    net: int
    warnings: tuple[str, ...] = ()

    @property
    def currency(self) -> str:
        return self.metadata.currency

    @property
    def outstanding(self) -> int:
        # Direct routing may require more gross transfers than the positive net balances.
        return sum(row.amount for row in self.transfers)

    @property
    def composition(self) -> str:
        return self.metadata.composition

    @property
    def expense_period(self) -> str:
        return self.metadata.expense_dates


def _decimal_scaled(value: int) -> Decimal:
    return Decimal(scaled_string(value))


def _period(dates, empty):
    dates = [value.date() if isinstance(value, datetime) else value for value in dates if value is not None]
    if not dates:
        return empty
    first, last = min(dates), max(dates)
    return first.strftime("%d %b %Y") if first == last else f"{first:%d %b %Y} to {last:%d %b %Y}"


def routing_label(data: ReportData) -> str:
    projection = data.balances.get("settlement_projection") or {}
    if projection.get("settlement_mode") == "direct":
        return "Direct repayment plan"
    return "Minimum payment plan" if projection.get("routing", {}).get("optimal") else "Simplified payment plan"


def _unique_labels(labels: dict[str, str]) -> dict[str, str]:
    """Keep display-name conventions, resolving even a literal name like 'Alex_1'."""
    result, used = {}, set()
    for identity, label in labels.items():
        candidate = label or "Unnamed account"
        if candidate.casefold() in used:
            candidate = f"{candidate} [{identity}]"
        while candidate.casefold() in used:
            candidate += " (duplicate label)"
        result[identity] = candidate
        used.add(candidate.casefold())
    return result


def build_report_data(snapshot: ReportSnapshot, *, diagnostic: bool = False) -> ReportData:
    """Build both exports from one snapshot, independently checking each financial bridge."""
    trip = snapshot.trip
    members = trip.get("members", [])
    expenses = list(snapshot.expenses)
    settlements = [row for row in snapshot.settlements if row.get("status") != "pending"]
    payments = list(snapshot.payments)
    migration = snapshot.migration_adjustment or {}
    balances = compute_balance_snapshot(
        trip, expenses, settlements, payments, migration, diagnostic=diagnostic,
    )
    precise = build_precise_net(members, expenses, settlements, payments, migration.get("vector"))
    member_by_id = {str(row["id"]): row for row in members}
    labels = member_display_names(members)
    historical_ids = set()
    raw_expenses = []
    historical_precision = False
    for expense in expenses:
        amount, payer, shares = expense_entity_shares_scaled(expense, members)
        historical_precision |= bool(amount % SCALE or any(value % SCALE for value in shares.values()))
        raw_expenses.append((expense, amount, payer, shares))
        historical_ids.update({payer, *shares} - member_by_id.keys())
    for event in settlements + payments:
        historical_ids.update({str(event.get("from_member_id", "")), str(event.get("to_member_id", ""))} - member_by_id.keys())
    historical_ids.update(set(migration.get("vector", {})) - member_by_id.keys())
    for account_id in sorted(historical_ids):
        labels[account_id] = f"Former account ({account_id})" if account_id else "Unassigned account"
    labels = _unique_labels(labels)
    account_order = [str(row["id"]) for row in members] + sorted(historical_ids)
    current_person_owner, person_names = {}, {}
    for account_id, member in member_by_id.items():
        roster = family_member_ids(member) if member.get("kind") == "family" else []
        names = _unique_labels(dict(zip(roster, family_member_display_names(member))))
        for person_id in roster or [account_id]:
            current_person_owner[person_id] = account_id
            person_names[account_id, person_id] = names.get(person_id, labels[account_id])

    funded, shares_shown, sent, received = (defaultdict(int) for _ in range(4))
    gross_by_account, back_by_account = defaultdict(int), defaultdict(int)
    raw_funded, raw_shares, raw_sent, raw_received = (defaultdict(int) for _ in range(4))
    person_shares = defaultdict(int)
    allocations, warnings = [], []
    category_totals = defaultdict(int)
    gross = money_back = 0
    raw_expenses.sort(key=lambda row: (expense_datetime(row[0]) or datetime.min, str(row[0].get("id", ""))))
    skipped = number = 0
    for expense, raw_amount, payer_id, raw in raw_expenses:
        if not raw:
            if raw_amount:
                raise ReportReconciliationError("An expense has no eligible allocations; its amount cannot be reconciled.")
            skipped += 1
            continue
        if sum(raw.values()) != raw_amount:
            raise ReportReconciliationError("Expense allocations do not match the stored expense amount.")
        if any(value and (raw_amount == 0 or (value > 0) != (raw_amount > 0)) for value in raw.values()):
            raise ReportReconciliationError("Expense allocations contain opposing cost and money-back signs.")
        amount = units(_decimal_scaled(raw_amount))
        order = [key for key in account_order if key in raw]
        shown = apportion_whole_amounts(
            {key: _decimal_scaled(value) for key, value in raw.items()}, order, amount,
            preferred_id=payer_id if payer_id in raw else None,
        )
        funded[payer_id] += amount
        raw_funded[payer_id] += raw_amount
        if amount >= 0:
            gross += amount
            gross_by_account[payer_id] += amount
        else:
            money_back -= amount
            back_by_account[payer_id] -= amount
        category = str(expense.get("category") or "Uncategorized").strip() or "Uncategorized"
        category_totals[category] += amount
        number += 1
        expense_id = str(expense.get("id") or f"unidentified-expense-{number}")
        if not expense_datetime(expense):
            warnings.append(f"Expense {number} has no usable date; its amount remains included.")
        block_sum = 0
        exact_by_account = defaultdict(dict)
        if expense.get("split_mode") == "EXACT":
            owners = {**current_person_owner, **(expense.get("family_member_entity_snapshots") or {})}
            unknown_accounts = [aid for aid in raw if aid not in member_by_id and aid not in (expense.get("custom_amounts") or {})]
            for person_id, value in (expense.get("custom_amounts") or {}).items():
                owner = owners.get(person_id)
                if owner is None and person_id in raw:
                    owner = person_id
                if owner is None and len(unknown_accounts) == 1:
                    owner = unknown_accounts[0]
                if owner not in raw:
                    raise ReportReconciliationError("An exact allocation has unresolved account attribution.")
                exact_by_account[owner][person_id] = decimal_money(value)
        for account_id in order:
            shares_shown[account_id] += shown[account_id]
            raw_shares[account_id] += raw[account_id]
            member = member_by_id.get(account_id, {})
            roster = family_member_ids(member) if member.get("kind") == "family" else []
            if expense.get("split_mode") == "EXACT":
                values = exact_by_account[account_id]
                eligible = [pid for pid in roster if pid in values]
                eligible.extend(sorted(set(values) - set(eligible)))
                if any(value and (raw_amount == 0 or (value > 0) != (raw_amount > 0)) for value in values.values()):
                    raise ReportReconciliationError("Exact expense allocations have conflicting signs.")
                person_values = apportion_whole_amounts(values, eligible, shown[account_id])
            elif roster:
                selected = list(dict.fromkeys((expense.get("family_participants") or {}).get(account_id) or []))
                # Retain recorded departed participants as explicit historical IDs. The account's
                # authoritative share is unchanged; this divides that share only within the account.
                extended_roster = roster + sorted(set(selected) - set(roster))
                eligible = [pid for pid in extended_roster if pid in selected] or roster
                values = allocate_within_family(shown[account_id], eligible, extended_roster)
                if not eligible and shown[account_id]:
                    raise ReportReconciliationError("A family expense has no identifiable participants.")
                person_values = apportion_whole_amounts(values, eligible, shown[account_id])
            else:
                eligible = [account_id]
                person_values = {account_id: shown[account_id]}
            for person_id in eligible:
                person_label = person_names.get((account_id, person_id))
                if person_label is None:
                    person_label = f"Former person ({person_id})" if person_id != account_id else "Person attribution not recorded"
                    used_labels = {name.casefold() for (aid, _), name in person_names.items() if aid == account_id}
                    while person_label.casefold() in used_labels:
                        person_label += f" [{person_id}]"
                    person_names[account_id, person_id] = person_label
                value = person_values[person_id]
                person_shares[account_id, person_id] += value
                block_sum += value
                original = expense.get("original_amount")
                original_currency = str(expense.get("original_currency") or trip.get("currency", "INR"))
                foreign = original_currency != trip.get("currency", "INR")
                original = decimal_money(original) if original is not None else None if foreign else _decimal_scaled(raw_amount)
                allocations.append(Allocation(
                    expense_id=expense_id, number=number, occurred_at=expense_datetime(expense),
                    category=category, description=str(expense.get("description") or ""),
                    entry_type="Money back" if raw_amount < 0 else "Expense",
                    payer_id=payer_id, payer=labels[payer_id], account_id=account_id,
                    account=labels[account_id], person_id=person_id,
                    person=person_label,
                    split_method=mode_label(expense.get("split_mode")), expense_amount=amount, share=value,
                    original_amount=original,
                    original_currency=original_currency,
                    exchange_rate=str(expense.get("exchange_rate") or ("Not recorded" if foreign else "1")),
                    rate_date=parse_report_date(expense.get("exchange_rate_date")),
                    rate_provider=str(expense.get("exchange_rate_provider") or ("Not recorded" if foreign else "identity")),
                    rate_mode=str(expense.get("exchange_rate_mode") or ("Not recorded" if foreign else "automatic")),
                    original_exact="; ".join(f"{key}: {value}" for key, value in (expense.get("original_custom_amounts") or {}).items()),
                    date_source=str(expense.get("date") or ""),
                    rate_requested_date=parse_report_date(expense.get("exchange_rate_requested_date")),
                    time_recorded=_expense_time(expense.get("time")) is not None,
                ))
        if block_sum != amount:
            raise ReportReconciliationError("Person allocations do not match the expense total.")
    if skipped:
        warnings.append(f"{skipped} expense record(s) have no eligible split and do not affect the ledger.")

    events = []
    for source, records in (("Legacy settlement", settlements), ("Recorded payment", payments)):
        for index, record in enumerate(records):
            payer_id, receiver_id = str(record.get("from_member_id", "")), str(record.get("to_member_id", ""))
            raw_amount = to_scaled(record.get("amount"), field="settlement amount")
            historical_precision |= bool(raw_amount % SCALE)
            amount = units(_decimal_scaled(raw_amount))
            sent[payer_id] += amount
            received[receiver_id] += amount
            raw_sent[payer_id] += raw_amount
            raw_received[receiver_id] += raw_amount
            confirmed = source == "Recorded payment" and record.get("source") == "upi_recipient_confirmed"
            events.append(SettlementEvent(
                source_id=str(record.get("id") or f"unidentified-{index + 1}"), source=source,
                payer_id=payer_id, receiver_id=receiver_id, payer=labels[payer_id], receiver=labels[receiver_id],
                amount=amount, occurred_at=ist_datetime(record.get("paid_at") or record.get("created_at")),
                note=str(record.get("note") or record.get("remark") or ""),
                status="Recipient confirmed" if confirmed else "Recorded",
            ))
    events.sort(key=lambda row: (row.occurred_at or datetime.min, row.source, row.source_id))

    accounts, adjustments, member_positions = [], [], []
    historical_precision |= any(to_scaled(value) % SCALE for value in migration.get("vector", {}).values())
    expected_balances = joint_round(precise, SCALE)
    per_person = {row["member_id"]: row for row in balances["per_person"]}
    for account_id in account_order:
        migration_raw = to_scaled(migration.get("vector", {}).get(account_id, 0), field="migration adjustment")
        migration_units = units(_decimal_scaled(migration_raw))
        expected_raw = raw_funded[account_id] - raw_shares[account_id] + raw_sent[account_id] - raw_received[account_id] + migration_raw
        if expected_raw != precise.get(account_id, 0):
            raise ReportReconciliationError("The report's source records do not explain the authoritative ledger.")
        balance = units(balances["net"].get(account_id, 0))
        if balance != expected_balances.get(account_id, 0):
            raise ReportReconciliationError("The final balance differs from the authoritative whole-unit projection.")
        before = funded[account_id] - shares_shown[account_id]
        rounding = balance - (before + sent[account_id] - received[account_id] + migration_units)
        if rounding and not historical_precision:
            raise ReportReconciliationError("Whole-unit source records have an unexplained reconciliation difference.")
        # Prove the bridge from independent source precision, not an arbitrary balancing plug.
        with localcontext() as context:
            context.prec = 60
            proof = Decimal(balance) - _decimal_scaled(precise.get(account_id, 0))
            proof += _decimal_scaled(raw_funded[account_id]) - funded[account_id]
            proof -= _decimal_scaled(raw_shares[account_id]) - shares_shown[account_id]
            proof += _decimal_scaled(raw_sent[account_id]) - sent[account_id]
            proof -= _decimal_scaled(raw_received[account_id]) - received[account_id]
            proof += _decimal_scaled(migration_raw) - migration_units
        if proof != rounding:
            raise ReportReconciliationError("Historical rounding does not reconcile.")
        if migration_raw:
            adjustments.append(Adjustment(account_id, labels[account_id], "Migration", migration_units,
                                          f"Recorded migration adjustment ({migration.get('policy_version', 'historical')}); "
                                          f"source account {account_id}, stored amount {scaled_string(migration_raw)}."))
        if rounding:
            adjustments.append(Adjustment(account_id, labels[account_id], "Historical rounding", rounding,
                                          f"Verified historical precision bridge: precise ledger balance {scaled_string(precise.get(account_id, 0))}; "
                                          f"whole-unit balance {balance}; displayed funding, shares, payments and migration yield "
                                          f"{before + sent[account_id] - received[account_id] + migration_units}."))
        member = member_by_id.get(account_id, {})
        accounts.append(AccountSummary(
            account_id, labels[account_id], "Family" if member.get("kind") == "family" else "Individual" if member else "Historical",
            shares_shown[account_id], gross_by_account[account_id], back_by_account[account_id],
            funded[account_id], sent[account_id], received[account_id], migration_units + rounding, balance,
        ))
        for person in per_person.get(account_id, {}).get("members", []):
            member_positions.append(MemberPosition(account_id, person["id"], person_names[account_id, person["id"]],
                                                   person_shares[account_id, person["id"]], units(person["net"])))
        current_ids = set(family_member_ids(member)) if member.get("kind") == "family" else {account_id}
        for aid, person_id in person_shares:
            if aid == account_id and person_id not in current_ids:
                member_positions.append(MemberPosition(account_id, person_id, person_names[aid, person_id],
                                                       person_shares[aid, person_id], None))
    net = gross - money_back
    if sum(row.share for row in allocations) != net or sum(category_totals.values()) != net:
        raise ReportReconciliationError("Report summaries do not conserve net spending.")
    if sum(row.balance for row in accounts) or sum(row.adjustment for row in accounts):
        raise ReportReconciliationError("Report balances or adjustments do not conserve money.")
    transfers = tuple(SuggestedTransfer(t["from_member_id"], t["to_member_id"], labels[t["from_member_id"]],
                                        labels[t["to_member_id"]], units(t["amount"])) for t in balances.get("transfers", []))
    trip_dates = [parse_report_date(trip.get("start_date") or trip.get("travel_date")), parse_report_date(trip.get("end_date"))]
    metadata = ReportMetadata(
        str(trip.get("name", "Group")), _period(trip_dates, trip_date_label(trip) or "Not set"),
        _period((a.occurred_at for a in allocations), "No dated expenses"),
        _period((e.occurred_at for e in events), "No dated settlements"),
        ist_datetime(snapshot.generated_at), composition_label(members), trip.get("currency", "INR"),
        units(trip["budget"]) if trip.get("budget") is not None else None, str(trip.get("code") or ""),
    )
    return ReportData(snapshot, metadata, balances, transfers, tuple(allocations), tuple(accounts), tuple(member_positions),
                      tuple(events), tuple(adjustments), tuple(sorted(category_totals)), dict(category_totals),
                      gross, money_back, net, tuple(warnings))
