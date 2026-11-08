"""Professional snapshot workbook, rendered from the shared reconciled report model."""

import io
import re
from collections import defaultdict
from dataclasses import fields, replace
from datetime import datetime
from textwrap import wrap

from openpyxl import Workbook
from openpyxl.formatting.rule import CellIsRule, Rule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.styles.differential import DifferentialStyle
from openpyxl.styles.numbers import NumberFormat
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.utils import get_column_letter, column_index_from_string

from services.report_formatting import BRAND, RECEIVE, PAY, NEUTRAL, currency_symbol, indian_format, indian_number
from services.report_model import ReportData
from services.report_excel_layout import ExcelReportType, select_excel_report_type
from services.report_summary_table import add_category_summary_table


_INVALID_XML_TEXT = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")


def _excel_text(value):
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = _INVALID_XML_TEXT.sub("\ufffd", value)
    return value if len(value) <= 32767 else value[:32766] + "\u2026"


def _excel_labels(values):
    """Keep distinct axis labels distinct under Excel's text and cell-length limits."""
    labels, used = {}, set()
    for value in values:
        if value in labels:
            continue
        base = candidate = _excel_text(value)
        number = 2
        while candidate.casefold() in used:
            suffix = f" ({number})"
            candidate = base[:32767 - len(suffix)] + suffix
            number += 1
        labels[value] = candidate
        used.add(candidate.casefold())
    return labels


def _excel_strings(record, **overrides):
    values = {field.name: _excel_text(value) for field in fields(record)
              if field.name not in {"account_id", "person_id", "payer_id", "receiver_id"}
              and isinstance(value := getattr(record, field.name), str)}
    return replace(record, **{**values, **overrides})


def _excel_display_data(data):
    # Prepare one export-only copy so every table uses the same safe, distinct labels.
    accounts = _excel_labels(account.name for account in data.accounts)
    people = _excel_labels([*(person.name for person in data.member_positions),
                            *(allocation.person for allocation in data.allocations)])
    categories = _excel_labels(data.categories)
    return replace(
        data, metadata=_excel_strings(data.metadata),
        accounts=tuple(_excel_strings(account, name=accounts[account.name]) for account in data.accounts),
        member_positions=tuple(_excel_strings(person, name=people[person.name]) for person in data.member_positions),
        allocations=tuple(_excel_strings(
            allocation, account=accounts[allocation.account], payer=accounts[allocation.payer],
            person=people[allocation.person], category=categories[allocation.category]) for allocation in data.allocations),
        transfers=tuple(_excel_strings(transfer, payer=accounts[transfer.payer], receiver=accounts[transfer.receiver])
                        for transfer in data.transfers),
        events=tuple(_excel_strings(event, payer=accounts[event.payer], receiver=accounts[event.receiver])
                     for event in data.events),
        categories=tuple(categories[category] for category in data.categories),
        category_totals={categories[category]: amount for category, amount in data.category_totals.items()},
    )


def text_cell(sheet, row, col, value):
    cell = sheet.cell(row, col, value)
    if isinstance(value, str):
        cell.data_type = "s"
    return cell


def money_cell(cell):
    cell.number_format = indian_format(int(cell.value or 0))
    cell.alignment = Alignment(horizontal="right", vertical="center")


def header_row(sheet, row, columns, start_column=1):
    for col in range(start_column, start_column + columns):
        cell = sheet.cell(row, col)
        cell.font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=BRAND)
        cell.alignment = Alignment(vertical="center", wrap_text=True)


def _row(sheet, row, values, start_column=1):
    for col, value in enumerate(values, start_column):
        cell = text_cell(sheet, row, col, value)
        if isinstance(value, (int, float)):
            money_cell(cell)
        elif isinstance(value, datetime):
            cell.number_format = 'dd mmm yyyy, h:mm AM/PM'
        cell.alignment = Alignment(vertical="center", horizontal="right" if isinstance(value, (int, float)) else "left", wrap_text=True)


def _total(sheet, row, columns, start_column=1, fill="EAF0EE"):
    for col in range(start_column, start_column + columns):
        cell = sheet.cell(row, col)
        cell.font = Font(name="Calibri", size=11, bold=True, color=BRAND)
        cell.fill = PatternFill("solid", fgColor=fill)
        cell.border = Border(top=Side(style="thin", color=BRAND))


def _title(sheet, title):
    cell = text_cell(sheet, 1, 1, title)
    cell.font = Font(name="Calibri", size=16, bold=True, color=BRAND)
    cell.alignment = Alignment(wrap_text=False, vertical="center")
    sheet.row_dimensions[1].height = 26


def _widths(sheet, widths):
    for col, width in enumerate(widths, 1):
        sheet.column_dimensions[get_column_letter(col)].width = width


def _table(sheet, name, header, last, columns, style="TableStyleMedium4"):
    if last <= header:
        return
    table = Table(displayName=name, ref=f"A{header}:{get_column_letter(columns)}{last}")
    table.tableStyleInfo = TableStyleInfo(name=style, showRowStripes=True)
    sheet.add_table(table)


def _number_rules(sheet, area, anchor):
    # Keep numeric Indian masks correct if a workbook user edits a monetary cell.
    rules = []
    def number_style(value):
        code = indian_format(value)
        # A custom code must not masquerade as built-in format 0 (General).
        return DifferentialStyle(numFmt=NumberFormat(
            numFmtId=sheet.parent._number_formats.add(code) + 164, formatCode=code))

    style = number_style(0)
    rules.append(Rule(type="expression", dxf=style,
        formula=[f"AND(ISNUMBER({anchor}),ABS({anchor})<100000)"]))
    for digits in range(6, 18, 2):
        low, high = 10 ** (digits - 1), 10 ** (digits + 1)
        style = number_style(low)
        rules.append(Rule(type="expression", dxf=style,
            formula=[f"AND(ISNUMBER({anchor}),ABS({anchor})>={low},ABS({anchor})<{high})"]))
    for rule in rules:
        sheet.conditional_formatting.add(area, rule)
    return rules


def _balance_rules(sheet, area):
    for operator, value, color, fill in (("greaterThan", 0, RECEIVE, "F0FDF4"),
                                         ("lessThan", 0, PAY, "FEF2F2"),
                                         ("equal", 0, NEUTRAL, "F1F5F9")):
        sheet.conditional_formatting.add(area, CellIsRule(operator=operator, formula=[str(value)],
            font=Font(color=color), fill=PatternFill("solid", fgColor=fill)))


def finalize_layout(sheet, money_columns=()):
    sheet.sheet_format.defaultRowHeight = 16
    hidden_columns = {column for key, dimension in sheet.column_dimensions.items() if dimension.hidden
                      for column in range(dimension.min or column_index_from_string(key),
                                          (dimension.max or column_index_from_string(key)) + 1)}
    for row in sheet:
        height = max(16, sheet.row_dimensions[row[0].row].height or 0)
        for cell in row:
            if cell.font.name is None:
                cell.font = Font(name="Calibri", size=11, color="121A18")
            if cell.column in money_columns and isinstance(cell.value, (int, float)):
                width = len(indian_number(cell.value)) + 3
                dim = sheet.column_dimensions[cell.column_letter]
                dim.width = max(dim.width or 13, width)
            if isinstance(cell.value, str) and cell.alignment.wrap_text and cell.column not in hidden_columns:
                width = max(8, int(sheet.column_dimensions[cell.column_letter].width or 13) - 2)
                lines = sum(max(1, len(wrap(line, width=width))) for line in cell.value.splitlines() or [""])
                height = max(height, (cell.font.sz or 11) * 1.35 * lines + 2)
        sheet.row_dimensions[row[0].row].height = min(height, 409.5)
    sheet.sheet_view.showGridLines = False
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.oddFooter.center.text = "Page &P of &N"


_EXCHANGE_WIDTHS = (18, 17, 24, 19, 24, 17, 36, 19)


def _exchange_headers(currency):
    return ["Original amount", "Original currency", f"Stored rate ({currency} per original unit)",
            "Effective rate date", "Rate provider", "Rate mode", "Original exact allocations", "Requested rate date"]


def _exchange_values(allocation):
    return [float(allocation.original_amount) if allocation.original_amount is not None else None,
            allocation.original_currency, allocation.exchange_rate,
            datetime.combine(allocation.rate_date, datetime.min.time()) if allocation.rate_date else None,
            allocation.rate_provider, allocation.rate_mode, allocation.original_exact,
            datetime.combine(allocation.rate_requested_date, datetime.min.time()) if allocation.rate_requested_date else None]


def _format_exchange_cells(sheet, row, first_column):
    original = sheet.cell(row, first_column)
    original.number_format = ('#,##0' if original.value is None or original.value == int(original.value)
                              else '#,##0.###############')
    for offset in (3, 7):
        sheet.cell(row, first_column + offset).number_format = "dd mmm yyyy"


def _transactions(workbook, data, report_type: ExcelReportType):
    sheet = workbook.create_sheet("Transactions")
    sheet.freeze_panes = "A3"
    include_exchange = report_type.includes_exchange_details
    visible_last_column = 15 if include_exchange else 11
    symbol = currency_symbol(data.currency)
    headers = ["Expense No", "Date (IST)", "Category", "Description", "Entry type", "Paid by",
               "Family / account", "Person", "Split method", f"Expense total ({symbol})", f"Expense share ({symbol})",
               "Expense ID"]
    if include_exchange:
        headers.extend(_exchange_headers(data.currency))
    _title(sheet, "Transactions")
    _row(sheet, 2, headers)
    header_row(sheet, 2, len(headers))
    for number, allocation in enumerate(data.allocations, 3):
        row = [allocation.number, allocation.occurred_at or allocation.date_source or "Not recorded", allocation.category, allocation.description,
               allocation.entry_type, allocation.payer, allocation.account, allocation.person,
               allocation.split_method, allocation.expense_amount, allocation.share, allocation.expense_id]
        if include_exchange:
            row.extend(_exchange_values(allocation))
        _row(sheet, number, row)
        if allocation.occurred_at and not allocation.time_recorded:
            sheet.cell(number, 2).number_format = 'dd mmm yyyy'
        sheet.cell(number, 1).number_format = "0"
        if include_exchange:
            _format_exchange_cells(sheet, number, 13)
        for col in (10, 11):
            money_cell(sheet.cell(number, col))
        sheet.cell(number, 10).font = Font(name="Calibri", size=11, bold=True, color=BRAND)
    last = 2 + len(data.allocations)
    _table(sheet, "ReportAllocations", 2, last, len(headers))
    if data.allocations:
        _row(sheet, last + 1, ["Net expense shares", None, None, None, None, None, None, None, None, None, data.net])
        sheet.cell(last + 1, 1).alignment = Alignment(wrap_text=False, vertical="center")
        _total(sheet, last + 1, 11)
        sheet.conditional_formatting.add(f"K3:K{last}", CellIsRule(operator="lessThan", formula=["0"], font=Font(color=RECEIVE)))
        _number_rules(sheet, f"J3:K{last + 1}", "J3")
    else:
        text_cell(sheet, 3, 1, "No expenses recorded")
    widths = [9, 23, 18, 32, 14, 20, 23, 21, 14, 17, 17, 23]
    if include_exchange:
        widths.extend(_EXCHANGE_WIDTHS)
    _widths(sheet, widths)
    sheet.column_dimensions.group("L", "L", hidden=True)
    if include_exchange:
        sheet.column_dimensions.group("P", "T", hidden=True)
    sheet.print_title_rows = "1:2"
    sheet.print_area = f"A1:{get_column_letter(visible_last_column)}{max(last + 1, 3)}"


def _summary(workbook, data):
    sheet = workbook["Summary"]
    meta = data.metadata
    symbol = currency_symbol(data.currency)
    columns = max(7, len(data.categories) + 3)
    _widths(sheet, [28, 24, *([17] * (columns - 2))])
    for col, category in enumerate(data.categories, 3):
        sheet.column_dimensions[get_column_letter(col)].width = min(24, max(13, max(map(len, category.split())) + 2))
    sheet.column_dimensions['D'].width = max(24, sheet.column_dimensions['D'].width)
    _title(sheet, meta.trip_name)
    metadata = [("Trip dates", meta.trip_dates), ("Included expense dates", meta.expense_dates),
                ("Included settlement dates", meta.settlement_dates),
                (f"Budget ({symbol})", meta.budget if meta.budget is not None else "Not set")]
    for row, (label, value) in enumerate(metadata, 2):
        cell = text_cell(sheet, row, 1, label)
        cell.font = Font(name="Calibri", size=11, bold=True, color=BRAND)
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        cell = text_cell(sheet, row, 2, value)
        cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        if isinstance(value, datetime):
            cell.number_format = 'dd mmm yyyy, h:mm AM/PM'
        elif isinstance(value, (int, float)):
            money_cell(cell)
    _row(sheet, 6, ["Measure", f"Amount ({symbol})"])
    header_row(sheet, 6, 2)
    for row, (label, value) in enumerate((("Gross spending", data.gross), ("Money back", data.money_back),
                                        ("Net spending", data.net), ("Still to settle", data.outstanding)), 7):
        _row(sheet, row, [label, value])
        if label in ("Net spending", "Still to settle"):
            _total(sheet, row, 2)
        elif label == "Money back":
            sheet.cell(row, 2).font = Font(name="Calibri", size=11, color=RECEIVE)
    text_cell(sheet, 2, 4, "Funding by account").font = Font(name="Calibri", size=13, bold=True, color=BRAND)
    _row(sheet, 3, ["Account", f"Gross funded ({symbol})", f"Money back ({symbol})", f"Net funded ({symbol})"], 4)
    header_row(sheet, 3, 4, 4)
    for row, account in enumerate(data.accounts, 4):
        _row(sheet, row, [account.name, account.gross_funded, account.money_back, account.funded], 4)
        sheet.cell(row, 6).font = Font(name="Calibri", size=11, color=RECEIVE)
    funding_total = 4 + len(data.accounts)
    _row(sheet, funding_total, ["Total", data.gross, data.money_back, data.net], 4)
    _total(sheet, funding_total, 4, 4)
    caption_row = max(10, funding_total) + 2
    bottom = add_category_summary_table(workbook, sheet, data, caption_row, money_cell, header_row)
    sheet.print_area = f"A1:{get_column_letter(columns)}{bottom}"


def _members(workbook, data):
    sheet = workbook.create_sheet("Members & Families")
    sheet.freeze_panes = "A3"
    symbol = currency_symbol(data.currency)
    headers = ["Family / account", "Name", f"Expense share ({symbol})", f"Net funded ({symbol})",
               f"Before settlements ({symbol})", f"Settlements paid ({symbol})",
               f"Settlements received ({symbol})", f"Balance now ({symbol})", "Action"]
    _title(sheet, "Members & Families")
    _row(sheet, 2, headers)
    header_row(sheet, 2, len(headers))
    positions = defaultdict(list)
    for person in data.member_positions:
        positions[person.account_id].append(person)
    row = 3

    def detail(values, number):
        _row(sheet, number, values)
        for cell in sheet[number][:len(headers)]:
            cell.fill = PatternFill("solid", fgColor="F4F7F6" if (number - 3) % 2 == 0 else "FFFFFF")

    for account in data.accounts:
        if account.kind != "Family":
            detail([account.name, account.name, account.share, account.funded, account.before_settlements,
                    account.sent, account.received, account.balance, account.action], row)
            sheet.cell(row, 6).font = Font(name="Calibri", size=11, color=PAY)
            sheet.cell(row, 7).font = Font(name="Calibri", size=11, color=RECEIVE)
            row += 1
        for person in positions[account.account_id]:
            action = "Within family account" if person.balance is not None else "Historical share only"
            detail([account.name, person.name, person.share, None, None, None, None, person.balance, action], row)
            row += 1
    _row(sheet, row, ["Group total", None, sum(a.share for a in data.accounts), sum(a.funded for a in data.accounts),
                     sum(a.before_settlements for a in data.accounts), sum(a.sent for a in data.accounts),
                     sum(a.received for a in data.accounts), sum(a.balance for a in data.accounts), None])
    header_row(sheet, row, len(headers))
    if row > 3:
        _balance_rules(sheet, f"H3:H{row - 1}")
        sheet.conditional_formatting.add(f"C3:C{row - 1}", CellIsRule(operator="lessThan", formula=["0"], font=Font(color=RECEIVE)))
    _number_rules(sheet, f"C3:H{row}", "C3")
    for offset, caption in enumerate((
        "Group total includes family account funding and settlements.",
        "Person rows leave these account-level amounts blank; see Summary and Payments.",
    ), 1):
        cell = text_cell(sheet, row + offset, 1, caption)
        cell.font = Font(name="Calibri", size=10, color=NEUTRAL)
        cell.alignment = Alignment(wrap_text=False, vertical="center")
    _widths(sheet, [26, 26, 17, 17, 18, 18, 18, 17, 24])
    sheet.print_title_rows = "1:2"
    sheet.print_area = f"A1:I{row + 2}"


def _payments(workbook, data):
    sheet = workbook.create_sheet("Payments")
    sheet.freeze_panes = "A3"
    _title(sheet, "Payments")
    headers = ["Suggested payer", "Suggested receiver", f"Amount ({currency_symbol(data.currency)})", "Status"]
    _row(sheet, 2, headers)
    header_row(sheet, 2, 4)
    row = 3
    for transfer in data.transfers:
        _row(sheet, row, [transfer.payer, transfer.receiver, transfer.amount, "Suggested"])
        sheet.cell(row, 1).font = Font(name="Calibri", size=11, color=PAY)
        sheet.cell(row, 2).font = Font(name="Calibri", size=11, color=RECEIVE)
        row += 1
    if row == 3:
        text_cell(sheet, row, 1, "Everyone is settled")
        row += 1
    _row(sheet, row, ["Outstanding plan total", None, data.outstanding])
    _total(sheet, row, 4)
    row += 1
    text_cell(sheet, row, 1, "Recorded settlement history").font = Font(name="Calibri", size=13, bold=True, color=BRAND)
    row += 1
    header = row
    _row(sheet, row, ["Payer", "Receiver", f"Amount ({currency_symbol(data.currency)})", "Date & time (IST)", "Source", "Status", "Event ID"])
    header_row(sheet, row, 7)
    for event in data.events:
        row += 1
        _row(sheet, row, [event.payer, event.receiver, event.amount, event.occurred_at, event.source, event.status, event.source_id])
        sheet.cell(row, 1).font = Font(name="Calibri", size=11, color=PAY)
        sheet.cell(row, 2).font = Font(name="Calibri", size=11, color=RECEIVE)
    _table(sheet, "ReportSettlements", header, row, 7)
    for label, value in (("History total", sum(e.amount for e in data.events)),
                         ("Recorded payments total", sum(e.amount for e in data.events if e.source == "Recorded payment")),
                         ("Legacy settlements total", sum(e.amount for e in data.events if e.source == "Legacy settlement"))):
        row += 1
        _row(sheet, row, [label, None, value])
        _total(sheet, row, 6)
    _widths(sheet, [27, 24, 17, 23, 20, 21, 26])
    sheet.column_dimensions["G"].hidden = True
    sheet.print_area = f"A1:F{row}"
    sheet.print_title_rows = f"{header}:{header}"


def build_report_workbook(data: ReportData):
    report_type = select_excel_report_type(data)
    data = _excel_display_data(data)
    workbook = Workbook()
    workbook.active.title = "Summary"
    workbook.properties.title = data.metadata.trip_name + " - Report"
    workbook.properties.subject = f"Trip report; report format 7; {report_type.value}"
    workbook.properties.creator = "Splitora"
    _transactions(workbook, data, report_type)
    _summary(workbook, data)
    _members(workbook, data)
    _payments(workbook, data)
    workbook._sheets.sort(key=lambda sheet: ["Summary", "Members & Families", "Transactions", "Payments"].index(sheet.title))
    for sheet in workbook:
        sheet.sheet_properties.tabColor = BRAND
        finalize_layout(sheet, tuple(range(2, 12)))
    return workbook


def build_report_xlsx(data: ReportData) -> bytes:
    output = io.BytesIO()
    build_report_workbook(data).save(output)
    return output.getvalue()
