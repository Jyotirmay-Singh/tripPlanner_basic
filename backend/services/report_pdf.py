"""Phase 18/23 — PDF rendering of the FULL trip report.

View layer only: it renders the SAME pure-builder data the XLSX tabs show — ``build_summary_spend_rows``
+ ``build_category_rows`` (Summary), ``build_members_families_rows`` (Members & Families, passed in by
the route because it needs the async ledger), and ``build_expense_member_rows`` (exploded Transactions +
pivot) — so the PDF and the spreadsheet can never diverge in value. The Members & Families Settlements
column therefore includes Phase-20 partial payments exactly like the ledger and the XLSX.

Uses ONLY ``reportlab`` (pure-Python wheels, no cairo/pango/system libraries), so it runs within
Render's free-tier constraints. Builds entirely in-memory and returns PDF bytes.
"""

import io
from functools import partial

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    HRFlowable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

from services.report_builder import (
    build_category_rows,
    build_expense_member_rows,
    build_summary_spend_rows,
    composition_label,
)
from utils.date_rules import trip_date_label
from utils.display_names import member_display_names

_BRAND = colors.HexColor("#1C3F39")      # header fill / headings (matches the XLSX _BRAND)
_RED = colors.HexColor("#C0392B")        # negatives (mirrors the XLSX [Red] number format)
_GRID = colors.HexColor("#D5DCDA")
_SUBTLE = colors.HexColor("#5A6B67")
_ZEBRA = colors.HexColor("#F4F7F6")      # even-row stripe
_TOTAL_BG = colors.HexColor("#EAF0EE")   # subtotal / total row highlight
_META_BG = colors.HexColor("#F4F7F6")    # meta label column

# Free-text (user-entered) columns are wrapped in Paragraphs so long names wrap instead of overflowing.
_CELL = ParagraphStyle("cell", fontSize=7.3, leading=8.6)
_CELL_BOLD = ParagraphStyle("cellBold", fontSize=7.3, leading=8.6, fontName="Helvetica-Bold")
_CELL_INDENT = ParagraphStyle("cellIndent", parent=_CELL, leftIndent=10)
_CELL_HDR = ParagraphStyle("cellHdr", fontSize=7.3, leading=8.6, fontName="Helvetica-Bold",
                           textColor=colors.white)


def _fmt_money(v) -> str:
    """'#,##0.00' with negatives in parentheses (paired with red text) — mirrors the XLSX format."""
    if v is None:
        return ""
    s = f"{abs(v):,.2f}"
    return f"({s})" if v < 0 else s


def _p(text, bold=False):
    return Paragraph(str(text) if text is not None else "", _CELL_BOLD if bold else _CELL)


def _hp(text):
    """White bold header-cell paragraph (wraps long headers; contrast on the brand fill)."""
    return Paragraph(str(text) if text is not None else "", _CELL_HDR)


class NumberedCanvas(canvas.Canvas):
    """Adds a 'Page X of Y' footer (+ trip name + hairline rule) to every page. Standard two-pass
    reportlab recipe: buffer each page's state on showPage, then, once the total page count is known,
    replay them stamping the footer on save."""

    def __init__(self, *args, **kwargs):
        self._footer_left = kwargs.pop("footer_left", "")
        canvas.Canvas.__init__(self, *args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_footer(total)
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

    def _draw_footer(self, total):
        w, _h = self._pagesize
        self.setStrokeColor(_GRID)
        self.setLineWidth(0.4)
        self.line(12 * mm, 8 * mm, w - 12 * mm, 8 * mm)
        self.setFont("Helvetica", 7)
        self.setFillColor(_SUBTLE)
        if self._footer_left:
            self.drawString(12 * mm, 5 * mm, self._footer_left)
        self.drawRightString(w - 12 * mm, 5 * mm, f"Page {self._pageNumber} of {total}")


def _section(base, title):
    """Brand-colored section heading + rule (returns a list of flowables)."""
    return [
        Paragraph(title, ParagraphStyle("sec", parent=base["Heading2"], fontSize=13,
                                        textColor=_BRAND, spaceBefore=2, spaceAfter=3)),
        HRFlowable(width="100%", thickness=1, color=_BRAND, spaceAfter=6),
    ]


def _styled_table(data, col_widths, *, right_cols=(), center_cols=(), total_row=None,
                  bold_rows=(), neg_cells=(), zebra=True, repeat=True, fontsize=7.3):
    """One consistent look for every report table: brand header, hairline grid, zebra body, right/center
    aligned columns, bold + ruled + highlighted total row, red negative cells, repeating header."""
    t = Table(data, colWidths=col_widths, repeatRows=1 if repeat else 0)
    style = [
        ("FONTSIZE", (0, 0), (-1, -1), fontsize),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.4, _GRID),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("BACKGROUND", (0, 0), (-1, 0), _BRAND),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ]
    if zebra:
        style.append(("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _ZEBRA]))
    for c in right_cols:
        style.append(("ALIGN", (c, 0), (c, -1), "RIGHT"))
    for c in center_cols:
        style.append(("ALIGN", (c, 0), (c, -1), "CENTER"))
    for rr in bold_rows:
        style.append(("FONTNAME", (0, rr), (-1, rr), "Helvetica-Bold"))
    if total_row is not None:
        style += [
            ("FONTNAME", (0, total_row), (-1, total_row), "Helvetica-Bold"),
            ("LINEABOVE", (0, total_row), (-1, total_row), 0.9, _BRAND),
            ("BACKGROUND", (0, total_row), (-1, total_row), _TOTAL_BG),
        ]
    for (c, rr) in neg_cells:
        style.append(("TEXTCOLOR", (c, rr), (c, rr), _RED))
    t.setStyle(TableStyle(style))
    return t


def _summary_section(base, trip, members, expenses, currency):
    """Section 1 — trip meta + spend-by-entity + by-category (reuses the XLSX Summary builders)."""
    flow = _section(base, "Summary")

    total_signed = round(sum(e.get("amount", 0.0) for e in expenses), 2)  # signed: refunds net down
    budget = trip.get("budget")
    meta = [
        ["Dates", trip_date_label(trip)],
        ["Share code", trip.get("code", "")],
        ["Currency", currency],
        ["Members", composition_label(members)],
        ["Budget", _fmt_money(round(budget, 2)) if budget is not None else "N/A"],
        ["Total Spent", _fmt_money(total_signed)],
    ]
    meta_tbl = Table([[_p(k, bold=True), _p(v)] for k, v in meta], colWidths=[90, 320])
    meta_tbl.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, 0), (0, -1), _META_BG),
        ("GRID", (0, 0), (-1, -1), 0.4, _GRID),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    flow += [meta_tbl, Spacer(1, 6 * mm)]

    # Spend by entity (gross amount paid, descending — mirrors the in-app SpendBarChart).
    spend = build_summary_spend_rows(members, expenses)
    flow.append(Paragraph("Spend by entity (gross amount paid)", ParagraphStyle(
        "subH", parent=base["Heading3"], fontSize=10, textColor=_BRAND, spaceAfter=3)))
    sdata = [[_hp("Entity"), _hp("Type"), _hp(f"Gross Spent ({currency})")]]
    sneg = []
    for i, sr in enumerate(spend["rows"], start=1):
        sdata.append([_p(sr["name"]), sr["type"], _fmt_money(sr["paid"])])
        if sr["paid"] < 0:
            sneg.append((2, i))
    sdata.append([_p("Subtotal", bold=True), "", _fmt_money(spend["total"])])
    flow += [_styled_table(sdata, [220, 90, 120], right_cols=(2,),
                           total_row=len(sdata) - 1, neg_cells=sneg), Spacer(1, 6 * mm)]

    # By category (signed totals) — shared builder with the XLSX Summary tab.
    cats = build_category_rows(expenses)
    flow.append(Paragraph("By category", ParagraphStyle(
        "subH2", parent=base["Heading3"], fontSize=10, textColor=_BRAND, spaceAfter=3)))
    cdata = [[_hp("Category"), _hp(f"Amount ({currency})")]]
    cneg = []
    for i, cr in enumerate(cats["rows"], start=1):
        cdata.append([_p(cr["category"]), _fmt_money(cr["amount"])])
        if cr["amount"] < 0:
            cneg.append((1, i))
    cdata.append([_p("Total", bold=True), _fmt_money(cats["total"])])
    if cats["total"] < 0:
        cneg.append((1, len(cdata) - 1))
    flow.append(_styled_table(cdata, [220, 130], right_cols=(1,),
                              total_row=len(cdata) - 1, neg_cells=cneg))
    return flow


def _members_families_section(base, mf_rows, currency):
    """Section 2 — hierarchical Members & Families with the payment-inclusive Settlements column."""
    flow = _section(base, "Members & Families")
    headers = ["Name", "Type", "Family", f"Gross Spent ({currency})",
               f"Share of Expenses ({currency})", f"Settlements ({currency})",
               f"Net Balance ({currency})"]
    data = [[_hp(h) for h in headers]]
    bold_rows, neg_cells = [], []
    ri = 1
    for mf in mf_rows:
        kind = mf["kind"]
        if kind == "family_member":
            name_cell = Paragraph(str(mf["name"]), _CELL_INDENT)
        else:
            name_cell = _p(mf["name"], bold=kind in ("family_subtotal", "total"))
        row = [name_cell, mf["type"], mf["family"]]
        for ci, key in zip((3, 4, 5, 6), ("paid", "share", "settle", "net")):
            v = mf[key]
            row.append(_fmt_money(v) if isinstance(v, (int, float)) else "—")
            if isinstance(v, (int, float)) and v < 0:
                neg_cells.append((ci, ri))
        data.append(row)
        if kind in ("family_subtotal", "total"):
            bold_rows.append(ri)
        ri += 1
    total_row = len(data) - 1 if mf_rows else None
    flow.append(_styled_table(data, [110, 66, 90, 78, 92, 84, 84], right_cols=(3, 4, 5, 6),
                              total_row=total_row, bold_rows=bold_rows, neg_cells=neg_cells))
    return flow


def _transactions_section(base, tx, currency):
    """Section 3 — exploded per-member Transactions + per-person pivot (unchanged data/totals)."""
    flow = _section(base, "Transactions")
    headers = ["Sr", "Category", "Description", "Date", f"Amount ({currency})", "Split Mode",
               "Paid By", "Family", "Person", f"Total Payable ({currency})"]
    data = [[_hp(h) for h in headers]]
    neg_cells = []
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
    flow.append(_styled_table(
        data, [20, 60, 86, 82, 66, 58, 92, 92, 62, 76],
        right_cols=(4, 9), center_cols=(0, 5), total_row=gt_row, neg_cells=neg_cells))
    flow.append(Spacer(1, 8 * mm))

    # Per-person pivot.
    flow.append(Paragraph("Per-person totals", ParagraphStyle(
        "pivotHdr", parent=base["Heading3"], fontSize=10, textColor=_BRAND, spaceAfter=4)))
    pdata = [[_hp("Person"), _hp(f"Sum of Total Payable ({currency})")]]
    pneg = []
    for i, prow in enumerate(tx["pivot"]["rows"], start=1):
        pdata.append([_p(prow["name"]), _fmt_money(prow["total"])])
        if prow["total"] < 0:
            pneg.append((1, i))
    pdata.append([_p("Grand Total", bold=True), _fmt_money(tx["pivot"]["grand_total"])])
    if tx["pivot"]["grand_total"] < 0:
        pneg.append((1, len(pdata) - 1))
    flow.append(_styled_table(pdata, [150, 160], right_cols=(1,),
                              total_row=len(pdata) - 1, neg_cells=pneg))
    return flow


def _payments_section(base, payments, members, currency):
    """Section 4 — the recorded (partial) payments log; 'Receiver' names the creditor."""
    flow = _section(base, "Payments")
    names = member_display_names(members)
    data = [[_hp("Payer"), _hp("Receiver"), _hp(f"Amount ({currency})"), _hp("Date & Time"),
             _hp("Remark")]]
    total = 0.0
    for p in payments:
        ca = p.get("created_at") or ""
        data.append([
            _p(names.get(p["from_member_id"], "?")),
            _p(names.get(p["to_member_id"], "?")),
            _fmt_money(round(p["amount"], 2)),
            f"{ca[:10]} {ca[11:16]}".strip(),
            _p((p.get("note") or "").strip() or "—"),
        ])
        total += round(p["amount"], 2)
    data.append([_p("Total", bold=True), "", _fmt_money(round(total, 2)), "", ""])
    flow.append(_styled_table(data, [130, 140, 100, 120, 150], right_cols=(2,),
                              total_row=len(data) - 1))
    return flow


def build_report_pdf(trip: dict, members: list, expenses: list, currency: str,
                     payments: list = None, mf_rows: list = None) -> bytes:
    """Render the FULL report (Summary, Members & Families, exploded Transactions, Payments) to PDF bytes.

    ``mf_rows`` (Phase 23) is the ``build_members_families_rows`` output supplied by the route (it needs
    the async ledger); when None the Members & Families section is skipped. ``payments`` (Phase 20)
    appends the Payments log; when empty/None the Payments section is skipped.
    """
    tx = build_expense_member_rows(expenses, members)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(A4),
        leftMargin=12 * mm, rightMargin=12 * mm, topMargin=11 * mm, bottomMargin=14 * mm,
        title=f"{trip.get('name', 'Trip')} - Report",
    )
    base = getSampleStyleSheet()
    title_style = ParagraphStyle("rTitle", parent=base["Title"], fontSize=18, spaceAfter=1,
                                 textColor=_BRAND, alignment=0)
    sub_style = ParagraphStyle("rSub", parent=base["Normal"], fontSize=9.5, textColor=_SUBTLE,
                               spaceAfter=2)

    # ---------- Cover / title block ----------
    story = [
        Paragraph(trip.get("name", "Trip"), title_style),
        Paragraph(f"{composition_label(members)} &middot; {trip_date_label(trip)} &middot; {currency}",
                  sub_style),
        HRFlowable(width="100%", thickness=1.4, color=_BRAND, spaceBefore=3, spaceAfter=10),
    ]

    # ---------- Section 1: Summary ----------
    story += _summary_section(base, trip, members, expenses, currency)

    # ---------- Section 2: Members & Families ----------
    if mf_rows:
        story.append(Spacer(1, 8 * mm))
        story += _members_families_section(base, mf_rows, currency)

    # ---------- Section 3: Transactions (wide — start on a fresh page) ----------
    story.append(PageBreak())
    story += _transactions_section(base, tx, currency)

    # ---------- Section 4: Payments ----------
    if payments:
        story.append(Spacer(1, 8 * mm))
        story += _payments_section(base, payments, members, currency)

    footer = trip.get("name", "Trip")
    doc.build(story, canvasmaker=partial(NumberedCanvas, footer_left=footer))
    buf.seek(0)
    return buf.getvalue()
