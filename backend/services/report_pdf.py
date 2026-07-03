"""Phase 18 — PDF rendering of the exploded Transactions report.

View layer only: it takes the trip/members/expenses the route already fetched and renders the SAME
``build_expense_member_rows`` data the XLSX Transactions tab shows, so the PDF and the spreadsheet can
never diverge (identical numbers, same reconciliation to Sum(Amount) == Sum(Total Payable)).

Uses ONLY ``reportlab`` (pure-Python wheels, no cairo/pango/system libraries), so it runs within
Render's free-tier constraints. Builds entirely in-memory and returns PDF bytes.
"""

import io

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from services.report_builder import build_expense_member_rows
from utils.date_rules import trip_date_label

_BRAND = colors.HexColor("#1C3F39")      # matches the XLSX header fill
_RED = colors.HexColor("#C0392B")        # negatives (mirrors the XLSX [Red] number format)
_GRID = colors.HexColor("#D5DCDA")
_SUBTLE = colors.HexColor("#5A6B67")

# Free-text (user-entered) columns are wrapped in Paragraphs so long names wrap instead of overflowing.
_CELL = ParagraphStyle("cell", fontSize=7.3, leading=8.6)
_CELL_BOLD = ParagraphStyle("cellBold", fontSize=7.3, leading=8.6, fontName="Helvetica-Bold")


def _fmt_money(v) -> str:
    """'#,##0.00' with negatives in parentheses (paired with red text) — mirrors the XLSX format."""
    if v is None:
        return ""
    s = f"{abs(v):,.2f}"
    return f"({s})" if v < 0 else s


def _p(text, bold=False):
    return Paragraph(str(text) if text is not None else "", _CELL_BOLD if bold else _CELL)


def build_report_pdf(trip: dict, members: list, expenses: list, currency: str) -> bytes:
    """Render the exploded Transactions report (per-member rows + per-person pivot) to PDF bytes."""
    tx = build_expense_member_rows(expenses, members)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(A4),
        leftMargin=12 * mm, rightMargin=12 * mm, topMargin=11 * mm, bottomMargin=11 * mm,
        title=f"{trip.get('name', 'Trip')} - Transactions",
    )
    base = getSampleStyleSheet()
    title_style = ParagraphStyle("rTitle", parent=base["Title"], fontSize=15, spaceAfter=1,
                                 textColor=_BRAND)
    sub_style = ParagraphStyle("rSub", parent=base["Normal"], fontSize=9, textColor=_SUBTLE,
                               spaceAfter=8)
    story = [
        Paragraph(trip.get("name", "Trip"), title_style),
        Paragraph(f"Transactions &middot; {trip_date_label(trip)} &middot; {currency}", sub_style),
    ]

    # ---------- Main exploded table (one row per member) ----------
    headers = ["Sr", "Category", "Description", "Date", f"Amount ({currency})", "Split Mode",
               "Paid By", "Family", "Person", f"Total Payable ({currency})"]
    data = [[_p(h, bold=True) if i in (1, 2, 6, 7, 8) else h for i, h in enumerate(headers)]]
    neg_cells = []  # (col, row) -> red text (negative Amount / Total Payable)
    r = 1
    for blk in tx["blocks"]:
        for i, row in enumerate(blk["rows"]):
            first = i == 0
            participates = row["participates"]
            data.append([
                str(blk["sr_no"]) if first else "",
                _p(blk["category"] if first else ""),
                _p(blk["description"] if first else ""),
                blk["date"] if first else "",
                _fmt_money(round(blk["amount"], 2)) if first else "",
                blk["mode"] if first else "",
                _p(blk["paid_by"] if first else ""),
                _p(row["family"]),
                _p(row["person"]),
                _fmt_money(row["payable"]) if participates else "-",
            ])
            if first and blk["amount"] < 0:
                neg_cells.append((4, r))
            if participates and row["payable"] < 0:
                neg_cells.append((9, r))
            r += 1
    data.append([_p("Grand Total", bold=True), "", "", "", _fmt_money(tx["grand_amount"]), "", "",
                 "", "", _fmt_money(tx["grand_payable"])])
    gt_row = r
    if tx["grand_amount"] < 0:
        neg_cells.append((4, gt_row))
    if tx["grand_payable"] < 0:
        neg_cells.append((9, gt_row))

    col_widths = [20, 60, 86, 82, 66, 58, 92, 92, 62, 76]
    main = Table(data, colWidths=col_widths, repeatRows=1)
    main_style = [
        ("BACKGROUND", (0, 0), (-1, 0), _BRAND),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.3),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),   # Sr
        ("ALIGN", (4, 0), (4, -1), "RIGHT"),    # Amount
        ("ALIGN", (5, 0), (5, -1), "CENTER"),   # Split Mode
        ("ALIGN", (9, 0), (9, -1), "RIGHT"),    # Total Payable
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.4, _GRID),
        ("LINEABOVE", (0, gt_row), (-1, gt_row), 0.9, _BRAND),
        ("FONTNAME", (0, gt_row), (-1, gt_row), "Helvetica-Bold"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]
    for (c, rr) in neg_cells:
        main_style.append(("TEXTCOLOR", (c, rr), (c, rr), _RED))
    main.setStyle(TableStyle(main_style))
    story.append(main)
    story.append(Spacer(1, 9 * mm))

    # ---------- Per-person pivot ----------
    story.append(Paragraph("Per-person totals", ParagraphStyle(
        "pivotHdr", parent=base["Heading3"], fontSize=11, textColor=_BRAND, spaceAfter=4)))
    pdata = [["Person", f"Sum of Total Payable ({currency})"]]
    pneg = []
    pr = 1
    for prow in tx["pivot"]["rows"]:
        pdata.append([_p(prow["name"]), _fmt_money(prow["total"])])
        if prow["total"] < 0:
            pneg.append((1, pr))
        pr += 1
    pdata.append([_p("Grand Total", bold=True), _fmt_money(tx["pivot"]["grand_total"])])
    if tx["pivot"]["grand_total"] < 0:
        pneg.append((1, pr))
    pivot = Table(pdata, colWidths=[130, 150])
    pivot_style = [
        ("BACKGROUND", (0, 0), (-1, 0), _BRAND),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.4, _GRID),
        ("FONTNAME", (0, pr), (-1, pr), "Helvetica-Bold"),
        ("LINEABOVE", (0, pr), (-1, pr), 0.9, _BRAND),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    for (c, rr) in pneg:
        pivot_style.append(("TEXTCOLOR", (c, rr), (c, rr), _RED))
    pivot.setStyle(TableStyle(pivot_style))
    story.append(pivot)

    doc.build(story)
    buf.seek(0)
    return buf.getvalue()
