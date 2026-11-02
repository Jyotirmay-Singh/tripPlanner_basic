"""Professional snapshot workbook, rendered from the shared reconciled report model."""

import io
from collections import defaultdict
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
from services.report_model import ReportData, routing_label
from services.report_pivot import add_allocation_pivot


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


def _total(sheet, row, columns, start_column=1):
    for col in range(start_column, start_column + columns):
        cell = sheet.cell(row, col)
        cell.font = Font(name="Calibri", size=11, bold=True, color=BRAND)
        cell.fill = PatternFill("solid", fgColor="EAF0EE")
        cell.border = Border(top=Side(style="thin", color=BRAND))


def _title(sheet, title, columns):
    sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=columns)
    cell = text_cell(sheet, 1, 1, title)
    cell.font = Font(name="Calibri", size=16, bold=True, color=BRAND)
    cell.alignment = Alignment(wrap_text=True, vertical="center")


def _widths(sheet, widths):
    for col, width in enumerate(widths, 1):
        sheet.column_dimensions[get_column_letter(col)].width = width


def _table(sheet, name, header, last, columns):
    if last <= header:
        return
    table = Table(displayName=name, ref=f"A{header}:{get_column_letter(columns)}{last}")
    table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium4", showRowStripes=True)
    sheet.add_table(table)


def _number_rules(sheet, area, anchor):
    # Filters can change pivot sums. Select a numeric Indian mask again for the new magnitude.
    style = DifferentialStyle(numFmt=NumberFormat(numFmtId=0, formatCode=indian_format(0)))
    sheet.conditional_formatting.add(area, Rule(type="expression", dxf=style,
        formula=[f"AND(ISNUMBER({anchor}),ABS({anchor})<100000)"]))
    for digits in range(6, 18, 2):
        low, high = 10 ** (digits - 1), 10 ** (digits + 1)
        style = DifferentialStyle(numFmt=NumberFormat(numFmtId=0, formatCode=indian_format(low)))
        sheet.conditional_formatting.add(area, Rule(type="expression", dxf=style,
            formula=[f"AND(ISNUMBER({anchor}),ABS({anchor})>={low},ABS({anchor})<{high})"]))


def _balance_rules(sheet, area):
    for operator, value, color, fill in (("greaterThan", 0, RECEIVE, "F0FDF4"),
                                         ("lessThan", 0, PAY, "FEF2F2"),
                                         ("equal", 0, NEUTRAL, "F1F5F9")):
        sheet.conditional_formatting.add(area, CellIsRule(operator=operator, formula=[str(value)],
            font=Font(color=color), fill=PatternFill("solid", fgColor=fill)))


def finalize_layout(sheet, money_columns=()):
    sheet.freeze_panes = None
    sheet.sheet_format.defaultRowHeight = 16
    hidden_columns = {column for key, dimension in sheet.column_dimensions.items() if dimension.hidden
                      for column in range(dimension.min or column_index_from_string(key),
                                          (dimension.max or column_index_from_string(key)) + 1)}
    for row in sheet:
        height = 16
        for cell in row:
            if cell.__class__.__name__ == "MergedCell":
                continue
            if cell.font.name is None:
                cell.font = Font(name="Calibri", size=11, color="121A18")
            if cell.column in money_columns and isinstance(cell.value, (int, float)):
                width = len(indian_number(cell.value)) + 3
                dim = sheet.column_dimensions[cell.column_letter]
                dim.width = max(dim.width or 13, width)
            if isinstance(cell.value, str) and cell.alignment.wrap_text and cell.column not in hidden_columns:
                span = next((span for span in sheet.merged_cells.ranges if cell.coordinate in span), None)
                columns = range(span.min_col, span.max_col + 1) if span else (cell.column,)
                width = max(8, int(sum(sheet.column_dimensions[get_column_letter(col)].width or 13 for col in columns)) - 2)
                lines = sum(max(1, len(wrap(line, width=width))) for line in cell.value.splitlines() or [""])
                height = max(height, (cell.font.sz or 11) * 1.35 * lines + 2)
        sheet.row_dimensions[row[0].row].height = height
    sheet.sheet_view.showGridLines = False
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.oddFooter.center.text = "Page &P of &N"


def _transactions(workbook, data):
    sheet = workbook.create_sheet("Transactions")
    symbol = currency_symbol(data.currency)
    headers = ["Expense No", "Date (IST)", "Category", "Description", "Entry type", "Paid by",
               "Family / account", "Person", "Split method", f"Expense total ({symbol})", f"Expense share ({symbol})",
               "Expense ID", "Original amount", "Original currency",
               "Stored exchange rate", "Effective rate date", "Rate provider", "Rate mode", "Original exact allocations", "Requested rate date"]
    _title(sheet, "Transactions", 11)
    _row(sheet, 2, headers)
    header_row(sheet, 2, len(headers))
    source_rows = []
    for number, allocation in enumerate(data.allocations, 3):
        row = [allocation.number, allocation.occurred_at or allocation.date_source or "Not recorded", allocation.category, allocation.description,
               allocation.entry_type, allocation.payer, allocation.account, allocation.person,
               allocation.split_method, allocation.expense_amount, allocation.share,
               allocation.expense_id,
               float(allocation.original_amount) if allocation.original_amount is not None else None, allocation.original_currency, allocation.exchange_rate,
               datetime.combine(allocation.rate_date, datetime.min.time()) if allocation.rate_date else None,
               allocation.rate_provider, allocation.rate_mode, allocation.original_exact,
               datetime.combine(allocation.rate_requested_date, datetime.min.time()) if allocation.rate_requested_date else None]
        source_rows.append(row)
        _row(sheet, number, row)
        if allocation.occurred_at and not allocation.time_recorded:
            sheet.cell(number, 2).number_format = 'dd mmm yyyy'
        sheet.cell(number, 1).number_format = "0"
        sheet.cell(number, 13).number_format = '#,##0.###############'
        sheet.cell(number, 16).number_format = "dd mmm yyyy"
        sheet.cell(number, 20).number_format = "dd mmm yyyy"
        for col in (10, 11):
            money_cell(sheet.cell(number, col))
        sheet.cell(number, 10).font = Font(name="Calibri", size=11, bold=True, color=BRAND)
    last = 2 + len(source_rows)
    _table(sheet, "ReportAllocations", 2, last, len(headers))
    if source_rows:
        _row(sheet, last + 1, ["Net expense shares", None, None, None, None, None, None, None, None, None, data.net])
        sheet.merge_cells(start_row=last + 1, start_column=1, end_row=last + 1, end_column=10)
        _total(sheet, last + 1, 11)
        sheet.conditional_formatting.add(f"K3:K{last}", CellIsRule(operator="lessThan", formula=["0"], font=Font(color=RECEIVE)))
        _number_rules(sheet, f"J3:K{last + 1}", "J3")
    else:
        text_cell(sheet, 3, 1, "No expenses recorded")
    _widths(sheet, [9, 23, 18, 32, 14, 20, 23, 21, 14, 17, 17, 23, 17, 16, 23, 18, 20, 16, 36, 18])
    sheet.column_dimensions.group("L", "T", hidden=True)
    sheet.print_title_rows = "1:2"
    sheet.print_area = f"A1:K{max(last + 1, 3)}"
    return headers, source_rows


def _summary(workbook, data, headers, source_rows):
    sheet = workbook["Summary"]
    meta = data.metadata
    symbol = currency_symbol(data.currency)
    columns = max(7, len(data.categories) + 3)
    _widths(sheet, [28, 24, *([17] * (columns - 2))])
    for col, category in enumerate(data.categories, 3):
        sheet.column_dimensions[get_column_letter(col)].width = min(24, max(13, max(map(len, category.split())) + 2))
    sheet.column_dimensions['D'].width = max(24, sheet.column_dimensions['D'].width)
    _title(sheet, meta.trip_name, columns)
    metadata = [("Trip dates", meta.trip_dates), ("Included expense dates", meta.expense_dates),
                ("Included settlement dates", meta.settlement_dates),
                (f"Budget ({symbol})", meta.budget if meta.budget is not None else "Not set")]
    for row, (label, value) in enumerate(metadata, 2):
        cell = text_cell(sheet, row, 1, label)
        cell.font = Font(name="Calibri", size=11, bold=True, color=BRAND)
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        if not isinstance(value, (int, float)):
            sheet.merge_cells(start_row=row, start_column=2, end_row=row, end_column=3)
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
    # Keep the growing native pivot below every fixed table and its two page-filter rows.
    pivot_start = max(10, funding_total) + (4 if source_rows else 1)
    bottom = add_allocation_pivot(workbook, sheet, headers, source_rows, data, pivot_start, money_cell, header_row)
    for row in range(pivot_start + 2, bottom + 1):
        label = sheet.cell(row, 1).value
        if isinstance(label, str) and (label.endswith(" Total") or label == "Grand Total"):
            _total(sheet, row, len(data.categories) + 3)
        sheet.cell(row, len(data.categories) + 3).font = Font(name="Calibri", size=11, bold=True, color=BRAND)
    if source_rows:
        region = f"C{pivot_start + 2}:{get_column_letter(len(data.categories) + 3)}{bottom}"
        _number_rules(sheet, region, f"C{pivot_start + 2}")
        sheet.conditional_formatting.add(region, CellIsRule(operator="lessThan", formula=["0"], font=Font(color=RECEIVE)))
    sheet.print_area = f"A1:{get_column_letter(columns)}{bottom}"


def _members(workbook, data):
    sheet = workbook.create_sheet("Members & Families")
    symbol = currency_symbol(data.currency)
    headers = ["Name", f"Expense share ({symbol})", f"Net funded ({symbol})", f"Before settlements ({symbol})",
               f"Settlements paid ({symbol})", f"Settlements received ({symbol})"]
    headers += [f"Balance now ({symbol})", "Action"]
    _title(sheet, "Members & Families", len(headers))
    _row(sheet, 2, headers)
    header_row(sheet, 2, len(headers))
    positions = defaultdict(list)
    for person in data.member_positions:
        positions[person.account_id].append(person)
    row = 3
    balance_col = len(headers) - 1
    for account in data.accounts:
        values = [account.name, account.share, account.funded, account.before_settlements, account.sent, account.received]
        _row(sheet, row, [*values, account.balance, account.action])
        _total(sheet, row, len(headers))
        sheet.cell(row, 5).font = Font(name="Calibri", size=11, bold=True, color=PAY)
        sheet.cell(row, 6).font = Font(name="Calibri", size=11, bold=True, color=RECEIVE)
        start = row + 1
        row += 1
        for person in positions[account.account_id]:
            action = "Within family total" if person.balance is not None else "Historical share only"
            values = [person.name, person.share] + [None] * (balance_col - 3) + [person.balance, action]
            _row(sheet, row, values)
            sheet.cell(row, 1).alignment = Alignment(indent=2, vertical="center", wrap_text=True)
            row += 1
        if row > start:
            sheet.row_dimensions.group(start, row - 1, outline_level=1, hidden=False)
    values = ["Total", sum(a.share for a in data.accounts), sum(a.funded for a in data.accounts),
              sum(a.before_settlements for a in data.accounts), sum(a.sent for a in data.accounts), sum(a.received for a in data.accounts)]
    _row(sheet, row, [*values, 0, ""])
    _total(sheet, row, len(headers))
    _balance_rules(sheet, f"{get_column_letter(balance_col)}3:{get_column_letter(balance_col)}{row}")
    sheet.conditional_formatting.add(f"B3:B{row}", CellIsRule(operator="lessThan", formula=["0"], font=Font(color=RECEIVE)))
    _number_rules(sheet, f"B3:{get_column_letter(balance_col)}{row}", "B3")
    sheet.sheet_properties.outlinePr.summaryBelow = False
    _widths(sheet, [26, 17, 17, 18, 18, 18, 17, 21])
    sheet.print_title_rows = "1:2"
    sheet.print_area = f"A1:{get_column_letter(len(headers))}{row}"


def _payments(workbook, data):
    sheet = workbook.create_sheet("Payments")
    _title(sheet, "Payments", 6)
    _row(sheet, 2, ["Routing", routing_label(data)])
    headers = ["Suggested payer", "Suggested receiver", f"Amount ({currency_symbol(data.currency)})", "Status"]
    _row(sheet, 3, headers)
    header_row(sheet, 3, 4)
    row = 4
    for transfer in data.transfers:
        _row(sheet, row, [transfer.payer, transfer.receiver, transfer.amount, "Suggested"])
        sheet.cell(row, 1).font = Font(name="Calibri", size=11, color=PAY)
        sheet.cell(row, 2).font = Font(name="Calibri", size=11, color=RECEIVE)
        row += 1
    if row == 4:
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
    workbook = Workbook()
    workbook.active.title = "Summary"
    workbook.properties.title = str(data.snapshot.trip.get("name", "Group")) + " - Report"
    workbook.properties.subject = "Trip report; report format 3"
    workbook.properties.creator = "Trip Splitter"
    headers, source_rows = _transactions(workbook, data)
    _summary(workbook, data, headers, source_rows)
    _members(workbook, data)
    _payments(workbook, data)
    workbook._sheets.sort(key=lambda sheet: ["Summary", "Members & Families", "Transactions", "Payments"].index(sheet.title))
    for sheet in workbook:
        finalize_layout(sheet, tuple(range(2, 12)))
    return workbook


def build_report_xlsx(data: ReportData) -> bytes:
    output = io.BytesIO()
    build_report_workbook(data).save(output)
    return output.getvalue()
