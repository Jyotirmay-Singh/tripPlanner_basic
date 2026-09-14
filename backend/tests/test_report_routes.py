"""Route-level regression tests for report data loading."""

import asyncio
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock

from openpyxl import load_workbook
from openpyxl import Workbook

from routes import reports
from utils.currency_rules import SUPPORTED_CURRENCIES


def test_xlsx_money_values_and_formats_follow_whole_unit_policy():
    assert reports._money_value("1.005", "USD") == 1
    assert reports._money_value("2.5", "JPY") == 3
    assert reports._money_value("1.2345", "KWD") == 1
    assert reports._money_value("-2.5", "INR") == -3

    workbook = Workbook()
    sheet = workbook.active
    for row, currency in enumerate(SUPPORTED_CURRENCIES, start=1):
        cell = sheet.cell(row=row, column=1, value=reports._money_value("1", currency))
        reports._money(cell, currency)
        assert cell.number_format == "#,##0;[Red](#,##0)"


def test_xlsx_layout_wraps_long_text_and_fits_complete_money_values():
    workbook = Workbook()
    sheet = workbook.active
    sheet.column_dimensions["A"].width = 12
    sheet.column_dimensions["B"].width = 8
    sheet["A1"] = "Participant with a deliberately long display name"
    reports._money(sheet.cell(row=1, column=2, value=-9_876_543_210_123))

    reports._finalize_sheet_layout(sheet, (2,))

    assert sheet["A1"].alignment.wrap_text is True
    assert sheet.row_dimensions[1].height > 15
    assert sheet.column_dimensions["B"].width >= len("(9,876,543,210,123)") + 2


class _Cursor:
    def __init__(self, rows):
        self.rows = rows
        self.requested_length = "not-called"

    async def to_list(self, length=None):
        self.requested_length = length
        return self.rows

    def sort(self, *args):
        return self


class _ExpensesCollection:
    def __init__(self, cursor):
        self.cursor = cursor
        self.find_args = None

    def find(self, query, projection):
        self.find_args = (query, projection)
        return self.cursor


def test_load_report_expenses_uses_unbounded_cursor(monkeypatch):
    rows = [{"id": "gross"}, {"id": "reimbursement"}]
    cursor = _Cursor(rows)
    expenses = _ExpensesCollection(cursor)
    monkeypatch.setattr(reports, "db", SimpleNamespace(expenses=expenses))

    assert asyncio.run(reports._load_report_expenses("trip-1")) == rows
    assert expenses.find_args == ({"trip_id": "trip-1"}, {"_id": 0})
    assert cursor.requested_length is None


def test_xlsx_summary_renders_time_gross_reimbursement_and_net_separately(monkeypatch):
    members = [{
        "id": "time",
        "name": "Time",
        "kind": "family",
        "family_members": ["Hour", "Minute"],
        "family_member_ids": ["time:0", "time:1"],
    }]
    trip = {
        "id": "trip-1",
        "name": "Time report",
        "start_date": "2026-01-01",
        "end_date": "2026-01-02",
        "currency": "LKR",
        "code": "TIME",
        "members": members,
    }
    expenses = [
        {
            "id": "gross",
            "amount": 14_000.0,
            "category": "Local Transportation",
            "description": "Taxi",
            "date": "01-01-26",
            "paid_by_member_id": "time",
            "split_member_ids": ["time"],
            "split_mode": "PER_FAMILY",
        },
        {
            "id": "reimbursement",
            "amount": -4_000.0,
            "category": "Local Transportation",
            "description": "Taxi refund",
            "date": "02-01-26",
            "paid_by_member_id": "time",
            "split_member_ids": ["time"],
            "split_mode": "PER_FAMILY",
        },
    ]
    per_person = [{
        "member_id": "time",
        "member_name": "Time",
        "kind": "family",
        "net_total": 0.0,
        "members": [
            {"id": "time:0", "name": "Hour", "net": 0.0},
            {"id": "time:1", "name": "Minute", "net": 0.0},
        ],
    }]

    monkeypatch.setattr(reports, "decode_token", lambda _token: {"sub": "user-1"})
    monkeypatch.setattr(reports, "_trip_or_404", AsyncMock(return_value=trip))
    monkeypatch.setattr(reports, "_load_report_expenses", AsyncMock(return_value=expenses))
    monkeypatch.setattr(
        reports, "_compute_balances", AsyncMock(return_value={
            "per_person": per_person,
            "transfers": [],
            "settlement_projection": {
                "enabled": True,
                "currency": "LKR",
                "increment": "1",
                "status": "settled_exactly",
                "policy_version": "whole_unit_v1",
                "precise_net": {"time": "0.000000000000"},
                "rounded_net": {"time": 0},
                "rounding_adjustments": {"time": "0.000000000000"},
                "routing": {"optimal": True},
            },
        }),
    )
    monkeypatch.setattr(reports, "db", SimpleNamespace(
        users=SimpleNamespace(find_one=AsyncMock(return_value={"id": "user-1"})),
        settlements=SimpleNamespace(find=lambda *_args, **_kwargs: _Cursor([])),
        payments=SimpleNamespace(find=lambda *_args, **_kwargs: _Cursor([])),
    ))

    async def render():
        response = await reports.report_xlsx("trip-1", "token")
        chunks = [chunk async for chunk in response.body_iterator]
        return response, b"".join(chunks)

    response, payload = asyncio.run(render())
    assert response.media_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    workbook = load_workbook(io.BytesIO(payload), data_only=True)
    summary = workbook["Summary"]
    rows = [tuple(cell.value for cell in row[:3]) for row in summary.iter_rows()]

    assert [row[0] for row in rows].count("GROSS SPEND") == 2
    assert [row[0] for row in rows].count("REIMBURSEMENTS") == 2
    assert [row[0] for row in rows].count("Gross spend subtotal") == 2
    assert [row[0] for row in rows].count("Total reimbursements") == 2
    assert [row[2] for row in rows if row[0] == "Time" and isinstance(row[2], (int, float))] == [
        14_000.0, 4_000.0,
    ]
    assert [row[1] for row in rows
            if row[0] == "Local Transportation" and isinstance(row[1], (int, float))] == [
        14_000.0, 4_000.0,
    ]
    assert [next(value for value in row[1:] if isinstance(value, (int, float)))
            for row in rows if row[0] == "Gross spend subtotal"] == [14_000.0, 14_000.0]
    assert [next(value for value in row[1:] if isinstance(value, (int, float)))
            for row in rows if row[0] == "Total reimbursements"] == [4_000.0, 4_000.0]
    assert [next(value for value in row[1:] if isinstance(value, (int, float)))
            for row in rows if row[0] == "Net spend"] == [10_000.0, 10_000.0, 10_000.0]

    payment_rows = [tuple(cell.value for cell in row[:4])
                    for row in workbook["Payments"].iter_rows()]
    assert any(row[0] == "Settlement plan" for row in payment_rows)
    assert ("Settlement currency", "LKR", None, None) in payment_rows
    assert ("Increment", "1", None, None) in payment_rows
    assert ("Status", "settled_exactly", None, None) in payment_rows
    assert ("Routing", "Minimum payment plan", None, None) in payment_rows
    assert ("Policy version", "whole_unit_v1", None, None) in payment_rows
    assert ("Suggested payer", "Suggested receiver", "Whole amount (LKR)", None) in payment_rows
    payment_text = " ".join(str(value) for row in payment_rows for value in row if value is not None)
    assert "Exact balance" not in payment_text
    assert "Rounded balance" not in payment_text
    assert "Rounding adjustment" not in payment_text
    assert "0.000000000000" not in payment_text


def test_xlsx_payment_source_is_labeled_without_private_attempt_data(monkeypatch):
    members = [
        {"id": "payer", "name": "Payer", "kind": "individual"},
        {"id": "receiver", "name": "Receiver", "kind": "individual"},
    ]
    trip = {
        "id": "trip-1",
        "name": "UPI report",
        "start_date": "2026-09-12",
        "end_date": "2026-09-13",
        "currency": "INR",
        "code": "UPI123",
        "members": members,
    }
    upi_payment = {
        "id": "payment-1",
        "trip_id": "trip-1",
        "from_member_id": "payer",
        "to_member_id": "receiver",
        "amount": 12.34,
        "created_at": "2026-09-12T10:00:00+00:00",
        "note": None,
        "source": "upi_recipient_confirmed",
        "payment_attempt_id": "private-attempt-id",
        "upi_id_snapshot": "private@upi",
        "transaction_reference": "PRIVATE-UTR",
    }
    per_person = [
        {
            "member_id": member["id"],
            "member_name": member["name"],
            "kind": "individual",
            "net_total": 0.0,
            "members": [],
        }
        for member in members
    ]

    monkeypatch.setattr(reports, "decode_token", lambda _token: {"sub": "user-1"})
    monkeypatch.setattr(reports, "_trip_or_404", AsyncMock(return_value=trip))
    monkeypatch.setattr(reports, "_load_report_expenses", AsyncMock(return_value=[]))
    monkeypatch.setattr(reports, "_compute_balances", AsyncMock(return_value={
        "per_person": per_person,
        "transfers": [],
        "settlement_projection": {"enabled": False},
    }))
    monkeypatch.setattr(reports, "db", SimpleNamespace(
        users=SimpleNamespace(find_one=AsyncMock(return_value={"id": "user-1"})),
        settlements=SimpleNamespace(find=lambda *_args, **_kwargs: _Cursor([])),
        payments=SimpleNamespace(find=lambda *_args, **_kwargs: _Cursor([upi_payment])),
    ))

    async def render():
        response = await reports.report_xlsx("trip-1", "token")
        return b"".join([chunk async for chunk in response.body_iterator])

    workbook = load_workbook(io.BytesIO(asyncio.run(render())), data_only=True)
    rows = list(workbook["Payments"].iter_rows(values_only=True))

    assert rows[0] == (
        "Payer", "Receiver", "Amount (INR)", "Date & Time", "Remark", "Source",
    )
    assert rows[1][0:3] == ("Payer", "Receiver", 12)
    assert rows[1][4:] == ("—", "UPI — recipient confirmed")
    all_text = " ".join(str(value) for row in rows for value in row if value is not None)
    assert "private@upi" not in all_text
    assert "PRIVATE-UTR" not in all_text
    assert "private-attempt-id" not in all_text


def test_xlsx_reports_integer_allocations_iso_labels_and_migration_adjustments(monkeypatch):
    members = [
        {"id": "a", "name": "Ann", "kind": "individual"},
        {"id": "b", "name": "Bob", "kind": "individual"},
        {"id": "c", "name": "Cam", "kind": "individual"},
    ]
    trip = {
        "id": "trip-1",
        "name": "Allocation report",
        "start_date": "2026-09-12",
        "end_date": "2026-09-13",
        "currency": "INR",
        "code": "ALLOC",
        "members": members,
    }
    expenses = [{
        "id": "expense-1",
        "amount": 10,
        "category": "Food",
        "description": "Remainder dinner",
        "date": "2026-09-12",
        "paid_by_member_id": "a",
        "split_member_ids": ["a", "b", "c"],
        "split_mode": "PER_FAMILY",
    }]
    per_person = [
        {
            "member_id": member["id"],
            "member_name": member["name"],
            "kind": "individual",
            "net_total": 0,
            "members": [],
        }
        for member in members
    ]

    monkeypatch.setattr(reports, "decode_token", lambda _token: {"sub": "user-1"})
    monkeypatch.setattr(reports, "_trip_or_404", AsyncMock(return_value=trip))
    monkeypatch.setattr(reports, "_load_report_expenses", AsyncMock(return_value=expenses))
    monkeypatch.setattr(reports, "_compute_balances", AsyncMock(return_value={
        "per_person": per_person,
        "transfers": [],
        "settlement_projection": {"enabled": False},
    }))
    monkeypatch.setattr(reports, "db", SimpleNamespace(
        users=SimpleNamespace(find_one=AsyncMock(return_value={"id": "user-1"})),
        settlements=SimpleNamespace(find=lambda *_args, **_kwargs: _Cursor([])),
        payments=SimpleNamespace(find=lambda *_args, **_kwargs: _Cursor([])),
        money_migration_adjustments=SimpleNamespace(find_one=AsyncMock(return_value={
            "trip_id": "trip-1",
            "policy_version": "whole_unit_v1",
            "created_at": "2026-09-13T00:00:00+00:00",
            "vector": {"a": 1, "b": -1, "c": 0},
        })),
    ))

    async def render():
        response = await reports.report_xlsx("trip-1", "token")
        return b"".join([chunk async for chunk in response.body_iterator])

    workbook = load_workbook(io.BytesIO(asyncio.run(render())), data_only=True)
    split_sheet = workbook["Split Math"]
    split_rows = list(split_sheet.iter_rows(values_only=True))
    assert split_rows[0][2] == "Total Amount (INR)"
    assert split_rows[0][7] == "Actual Allocation (INR)"
    allocations = {row[4]: (row[7], row[8]) for row in split_rows[1:4]}
    assert allocations == {
        "Ann": (4, "Yes"),
        "Bob": (3, "No"),
        "Cam": (3, "No"),
    }
    for row in range(2, 5):
        assert split_sheet.cell(row=row, column=8).number_format == "#,##0;[Red](#,##0)"

    adjustment_sheet = workbook["Migration Adjustments"]
    adjustment_rows = list(adjustment_sheet.iter_rows(values_only=True))
    assert adjustment_rows[0][0] == "Whole-unit migration adjustments"
    assert adjustment_rows[4][:2] == ("Entity", "Adjustment (INR)")
    assert adjustment_rows[5][:2] == ("Ann", 1)
    assert adjustment_rows[6][:2] == ("Bob", -1)
    assert adjustment_rows[8][:2] == ("TOTAL", 0)
    for row in range(6, 10):
        assert adjustment_sheet.cell(row=row, column=2).number_format == "#,##0;[Red](#,##0)"
