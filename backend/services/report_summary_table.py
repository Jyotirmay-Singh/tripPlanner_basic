"""Independent, filterable Excel snapshot of person/category expense shares."""

from collections import defaultdict

from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.styles.differential import DifferentialStyle
from openpyxl.styles.table import TableStyle, TableStyleElement
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

from services.member_breakdown import family_member_ids
from services.report_formatting import BRAND, NEUTRAL, RECEIVE, currency_symbol
from services.report_model import ReportData


TABLE_NAME = "ReportCategoryShares"
FILTER_SCOPE = "Filters hide table rows only. Grand totals and headline figures cover the full report."


def _header_prefix(value: str, units: int) -> str:
    # Excel table headings have a 255-character limit. Do not split a UTF-16 pair.
    return value.encode("utf-16-le")[:units * 2].decode("utf-16-le", errors="ignore")


def _category_headers(categories):
    used = {"family / account", "person", "grand total"}
    headers = []
    for category in categories:
        base = _header_prefix(category, 255)
        if base != category:
            base = _header_prefix(category, 254) + "…"
        candidate, number = base, 1
        while candidate.casefold() in used:
            suffix = " (category)" if number == 1 else f" (category {number})"
            candidate = _header_prefix(base, 255 - len(suffix)) + suffix
            number += 1
        used.add(candidate.casefold())
        headers.append(candidate)
    return headers


def _ordered_people(data, totals, labels):
    accounts = {account.account_id: index for index, account in enumerate(data.accounts)}
    rosters = {
        str(member["id"]): {str(person_id): index for index, person_id in enumerate(
            family_member_ids(member) if member.get("kind") == "family" else [member["id"]])}
        for member in data.snapshot.trip.get("members", [])
    }

    def order(key):
        account_id, person_id = key
        position = rosters.get(account_id, {}).get(person_id)
        return (accounts[account_id], position is None, position if position is not None else 0,
                "" if position is not None else labels[key][1].casefold(), person_id)

    return sorted(totals, key=order)


def _forest_style(workbook):
    elements = []
    for kind, fill, color, bold in (
        ("wholeTable", "FFFFFF", "121A18", False),
        ("headerRow", BRAND, "FFFFFF", True),
        ("firstRowStripe", "F4F7F6", "121A18", False),
        ("secondRowStripe", "FFFFFF", "121A18", False),
        ("lastColumn", "EAF0EE", BRAND, True),
    ):
        style = DifferentialStyle(font=Font(name="Calibri", size=11, color=color, bold=bold),
                                  fill=PatternFill("solid", fgColor=fill))
        elements.append(TableStyleElement(type=kind, dxfId=workbook._differential_styles.add(style),
                                          size=1 if "Stripe" in kind else None))
    name = "ReportCategoryForest"
    workbook._table_styles.tableStyle.append(TableStyle(name=name, pivot=False, table=True,
                                                        tableStyleElement=elements))
    return name


def _text(sheet, row, column, value):
    cell = sheet.cell(row, column, value)
    if isinstance(value, str):
        cell.data_type = "s"
    cell.alignment = Alignment(wrap_text=True, vertical="center")
    return cell


def add_category_summary_table(workbook, sheet, data: ReportData, caption_row: int,
                               style_money, style_header) -> int:
    """Write fixed values with normal filters and a separate full-report total; return the bottom row."""
    if not data.allocations:
        _text(sheet, caption_row, 1, "No expenses recorded")
        return caption_row

    totals = defaultdict(lambda: defaultdict(int))
    labels = {}
    for allocation in data.allocations:
        key = allocation.account_id, allocation.person_id
        totals[key][allocation.category] += allocation.share
        labels[key] = allocation.account, allocation.person

    caption = _text(sheet, caption_row, 1, f"Net expense share ({currency_symbol(data.currency)})")
    caption.font = Font(name="Calibri", size=13, bold=True, color=BRAND)
    caption.alignment = Alignment(wrap_text=False, vertical="center")
    sheet.row_dimensions[caption_row].height = 22
    scope = _text(sheet, caption_row + 1, 1, FILTER_SCOPE)
    scope.font = Font(name="Calibri", size=11, color=NEUTRAL)
    scope.alignment = Alignment(wrap_text=False, vertical="center")

    header_row = caption_row + 2
    category_headers = _category_headers(data.categories)
    headers = ["Family / account", "Person", *category_headers, "Grand Total"]
    last_column = len(headers)
    for column, value in enumerate(headers, 1):
        _text(sheet, header_row, column, value)
    style_header(sheet, header_row, last_column)
    for column, (category, heading) in enumerate(zip(data.categories, category_headers), 3):
        if heading != category:
            sheet.cell(header_row, column).comment = Comment(category, "Splitora")

    row = header_row + 1
    for key in _ordered_people(data, totals, labels):
        values = [totals[key][category] for category in data.categories]
        fill = "F4F7F6" if (row - header_row) % 2 else "FFFFFF"
        for column, value in enumerate([*labels[key], *values, sum(values)], 1):
            cell = _text(sheet, row, column, value)
            cell.fill = PatternFill("solid", fgColor="EAF0EE" if column == last_column else fill)
            cell.font = Font(name="Calibri", size=11, bold=column == last_column,
                             color=RECEIVE if isinstance(value, int) and value < 0 else BRAND if column == last_column else "121A18")
            if column >= 3:
                style_money(cell)
        row += 1

    # The total is deliberately outside the table/filter range and is never a SUBTOTAL formula.
    last_letter = get_column_letter(last_column)
    table = Table(displayName=TABLE_NAME, ref=f"A{header_row}:{last_letter}{row - 1}")
    table.tableStyleInfo = TableStyleInfo(name=_forest_style(workbook), showRowStripes=True, showLastColumn=True)
    sheet.add_table(table)
    _text(sheet, row, 1, "Grand Total")
    for column, value in enumerate([*[data.category_totals[category] for category in data.categories], data.net], 3):
        style_money(sheet.cell(row, column, value))
    style_header(sheet, row, last_column)
    for cell in sheet[row][:last_column]:
        cell.border = Border(top=Side(style="thin", color=BRAND))
    return row
