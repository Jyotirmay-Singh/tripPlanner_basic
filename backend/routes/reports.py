import io

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from database import db
from utils.deps import get_current_user, _trip_or_404
from utils.date_rules import ensure_date_range, trip_date_label
from utils.balances import _compute_balances
from utils.display_names import member_display_names
from utils.security import decode_token
from services.report_builder import (
    build_members_families_rows,
    build_split_math_rows,
    build_summary_spend_rows,
    build_transaction_rows,
    composition_label,
    entity_ledger_components,
    mode_label,
    settle_adj_by_entity,
)

router = APIRouter()

# ---------- XLSX styling (Phase 16) ----------
_BRAND = "1C3F39"
_HEADER_FILL = PatternFill("solid", fgColor=_BRAND)
_HEADER_FONT = Font(bold=True, color="FFFFFF")
_TITLE_FONT = Font(bold=True, size=14, color=_BRAND)
_BOLD = Font(bold=True)
_RIGHT = Alignment(horizontal="right")
# Thousands separator, 2dp, negatives in red parentheses (professional accounting format).
_MONEY_FMT = "#,##0.00;[Red](#,##0.00)"


def _style_header_row(ws, row: int, ncols: int) -> None:
    """Bold white text on the brand fill across a header row."""
    for col in range(1, ncols + 1):
        c = ws.cell(row=row, column=col)
        c.font = _HEADER_FONT
        c.fill = _HEADER_FILL


def _money(cell) -> None:
    """Right-align a numeric cell and apply the currency number format."""
    cell.number_format = _MONEY_FMT
    cell.alignment = _RIGHT


def _set_widths(ws, widths) -> None:
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


# ---------- Reports ----------
@router.get("/trips/{trip_id}/report")
async def report(trip_id: str, user=Depends(get_current_user)):
    trip = ensure_date_range(await _trip_or_404(trip_id, user["id"]))
    expenses = await db.expenses.find({"trip_id": trip_id}, {"_id": 0}).to_list(5000)
    bal = await _compute_balances(trip_id)
    # category breakdown — signed amounts net together (a refund reduces its category + the total).
    by_cat = {}
    by_date = {}
    total_expense = 0.0
    for e in expenses:
        by_cat[e["category"]] = by_cat.get(e["category"], 0) + e["amount"]
        by_date[e["date"]] = by_date.get(e["date"], 0) + e["amount"]
        total_expense += e["amount"]
    return {
        "trip": trip,
        "total_expense": round(total_expense, 2),
        "budget": trip.get("budget"),
        "by_category": [{"category": k, "amount": round(v, 2)} for k, v in by_cat.items()],
        "by_date": [{"date": k, "amount": round(v, 2)} for k, v in sorted(by_date.items())],
        "balances": bal,
    }


@router.get("/trips/{trip_id}/report.xlsx")
async def report_xlsx(trip_id: str, token: str,
                      _unused=None):
    # token in query for easy mobile download
    payload = decode_token(token)
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user:
        raise HTTPException(401, "User not found")
    trip = await _trip_or_404(trip_id, user["id"])
    expenses = await db.expenses.find({"trip_id": trip_id}, {"_id": 0}).to_list(5000)
    bal = await _compute_balances(trip_id)
    # Disambiguated top-level labels (rule a + families) — one source of truth shared with the app.
    display = member_display_names(trip["members"])

    members = trip["members"]
    cur = trip.get("currency", "INR")
    # Same non-pending settlement overlay _compute_balances applies (read-only; no engine change).
    settlements = await db.settlements.find(
        {"trip_id": trip_id, "status": {"$ne": "pending"}}, {"_id": 0}).to_list(5000)

    wb = Workbook()

    # ----- Tab 1: Summary (trip header + spend-by-entity + by-category) -----
    s1 = wb.active
    s1.title = "Summary"
    s1["A1"] = trip["name"]
    s1["A1"].font = Font(bold=True, size=16)
    row = 2
    for label, value in [("Dates", trip_date_label(trip)),
                         ("Share code", trip.get("code", "")),
                         ("Currency", cur),
                         ("Members", composition_label(members))]:
        s1.cell(row=row, column=1, value=label).font = _BOLD
        s1.cell(row=row, column=2, value=value)
        row += 1
    s1.cell(row=row, column=1, value="Budget").font = _BOLD
    if trip.get("budget") is not None:
        _money(s1.cell(row=row, column=2, value=round(trip["budget"], 2)))
    else:
        s1.cell(row=row, column=2, value="N/A")
    row += 1
    total_signed = round(sum(e["amount"] for e in expenses), 2)  # signed: refunds net it down
    s1.cell(row=row, column=1, value="Total Spent").font = _BOLD
    _money(s1.cell(row=row, column=2, value=total_signed))
    row += 2

    # Spend by entity (gross amount paid, descending — mirrors the in-app SpendBarChart)
    s1.cell(row=row, column=1, value="Spend by entity (gross amount paid)").font = _TITLE_FONT
    row += 1
    s1.cell(row=row, column=1, value="Entity")
    s1.cell(row=row, column=2, value="Type")
    s1.cell(row=row, column=3, value=f"Gross Spent ({cur})")
    _style_header_row(s1, row, 3)
    row += 1
    spend = build_summary_spend_rows(members, expenses)
    for sr in spend["rows"]:
        s1.cell(row=row, column=1, value=sr["name"])
        s1.cell(row=row, column=2, value=sr["type"])
        _money(s1.cell(row=row, column=3, value=sr["paid"]))
        row += 1
    s1.cell(row=row, column=1, value="Subtotal").font = _BOLD
    sc = s1.cell(row=row, column=3, value=spend["total"])
    _money(sc)
    sc.font = _BOLD
    row += 2

    # By category (signed totals, kept as-is)
    s1.cell(row=row, column=1, value="By category").font = _TITLE_FONT
    row += 1
    s1.cell(row=row, column=1, value="Category")
    s1.cell(row=row, column=2, value=f"Amount ({cur})")
    _style_header_row(s1, row, 2)
    row += 1
    by_cat = {}
    for e in expenses:
        by_cat[e["category"]] = by_cat.get(e["category"], 0) + e["amount"]
    cat_total = 0.0
    for k, v in by_cat.items():
        s1.cell(row=row, column=1, value=k)
        _money(s1.cell(row=row, column=2, value=round(v, 2)))
        cat_total += round(v, 2)
        row += 1
    s1.cell(row=row, column=1, value="Total").font = _BOLD
    ct = s1.cell(row=row, column=2, value=round(cat_total, 2))
    _money(ct)
    ct.font = _BOLD
    _set_widths(s1, [28, 22, 18])

    # ----- Tab 2: Members & Families (Paid | Share | Settlements | Net, reconciling) -----
    s2 = wb.create_sheet("Members & Families")
    mf_headers = ["Name", "Type", "Family", f"Gross Spent ({cur})", f"Share of Expenses ({cur})",
                  f"Settlements ({cur})", f"Net Balance ({cur})"]
    s2.append(mf_headers)
    _style_header_row(s2, 1, len(mf_headers))
    paid_map, _ = entity_ledger_components(expenses, members)
    settle_map = settle_adj_by_entity(settlements)
    for mf in build_members_families_rows(bal["per_person"], paid_map, settle_map, display):
        s2.append([mf["name"], mf["type"], mf["family"],
                   mf["paid"] if mf["paid"] is not None else "—",
                   mf["share"] if mf["share"] is not None else "—",
                   mf["settle"] if mf["settle"] is not None else "—",
                   mf["net"] if mf["net"] is not None else "—"])
        rr = s2.max_row
        for col in range(4, 8):
            c = s2.cell(row=rr, column=col)
            if isinstance(c.value, (int, float)):
                _money(c)
            else:
                c.alignment = _RIGHT
        if mf["kind"] in ("family_subtotal", "total"):
            for col in range(1, len(mf_headers) + 1):
                s2.cell(row=rr, column=col).font = _BOLD
        elif mf["kind"] == "family_member":
            s2.cell(row=rr, column=1).alignment = Alignment(indent=2)
    s2.freeze_panes = "A2"
    _set_widths(s2, [22, 14, 18, 16, 18, 16, 16])

    # ----- Tab 3: Split Math (flagship — one auditable block per expense) -----
    s3 = wb.create_sheet("Split Math")
    sm_headers = ["Expense", "Date", "Total Amount", "Split Mode", "Participant",
                  "Participant Type", "Units", f"Per-Unit Cost ({cur})", f"Allocated ({cur})"]
    s3.append(sm_headers)
    _style_header_row(s3, 1, len(sm_headers))
    for blk in build_split_math_rows(expenses, members):
        amt = round(blk["amount"], 2)
        for p in blk["participants"]:
            s3.append([blk["expense"], blk["date"], amt, blk["mode"], p["participant"],
                       p["ptype"], p["units"], round(p["per_unit"], 2), round(p["allocated"], 2)])
            rr = s3.max_row
            _money(s3.cell(row=rr, column=3))
            s3.cell(row=rr, column=7).alignment = _RIGHT
            _money(s3.cell(row=rr, column=8))
            _money(s3.cell(row=rr, column=9))
        s3.append([f"{blk['expense']} — Subtotal", "", amt, blk["mode"], "", "",
                   blk["subtotal_units"], "", blk["subtotal_allocated"]])
        rr = s3.max_row
        for col in range(1, len(sm_headers) + 1):
            s3.cell(row=rr, column=col).font = _BOLD
        _money(s3.cell(row=rr, column=3))
        s3.cell(row=rr, column=7).alignment = _RIGHT
        _money(s3.cell(row=rr, column=9))
    s3.freeze_panes = "A2"
    _set_widths(s3, [24, 18, 14, 12, 20, 16, 8, 16, 16])

    # ----- Tab 4: Transactions (one row per expense journal) -----
    s4 = wb.create_sheet("Transactions")
    tx_headers = ["Date", "Category", "Description", f"Amount ({cur})", "Paid By",
                  "Split Among", "Split Mode"]
    s4.append(tx_headers)
    _style_header_row(s4, 1, len(tx_headers))
    sorted_expenses = sorted(expenses, key=lambda x: x.get("date", ""))
    for r in build_transaction_rows(sorted_expenses, members):
        s4.append([r["date"], r["category"], r["description"], round(r["amount"], 2),
                   r["paid_by"], r["split_among"], mode_label(r["split_mode"])])
        _money(s4.cell(row=s4.max_row, column=4))
    s4.freeze_panes = "A2"
    _set_widths(s4, [18, 14, 24, 14, 16, 28, 12])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f"{trip['name'].replace(' ','_')}_report.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )
