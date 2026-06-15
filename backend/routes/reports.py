import io

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

from database import db
from utils.deps import get_current_user, _trip_or_404
from utils.balances import _compute_balances
from utils.security import decode_token
from services.report_builder import (
    build_per_capita_rows,
    build_per_family_rows,
    build_transaction_rows,
)

router = APIRouter()


# ---------- Reports ----------
@router.get("/trips/{trip_id}/report")
async def report(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    expenses = await db.expenses.find({"trip_id": trip_id}, {"_id": 0}).to_list(5000)
    bal = await _compute_balances(trip_id)
    # category breakdown
    by_cat = {}
    by_date = {}
    total_expense = 0.0
    total_income = 0.0
    for e in expenses:
        if e["kind"] == "expense":
            by_cat[e["category"]] = by_cat.get(e["category"], 0) + e["amount"]
            by_date[e["date"]] = by_date.get(e["date"], 0) + e["amount"]
            total_expense += e["amount"]
        else:
            total_income += e["amount"]
    return {
        "trip": trip,
        "total_expense": round(total_expense, 2),
        "total_income": round(total_income, 2),
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
    members_by_id = {m["id"]: m for m in trip["members"]}

    wb = Workbook()

    # Sheet 1 – Summary
    s1 = wb.active
    s1.title = "Summary"
    s1["A1"] = f"Trip: {trip['name']}"
    s1["A1"].font = Font(bold=True, size=16)
    s1["A2"] = f"Date: {trip['travel_date']}   Currency: {trip.get('currency','INR')}"
    s1["A3"] = f"Budget: {trip.get('budget', 'N/A')}"
    total = sum(e["amount"] for e in expenses if e["kind"] == "expense")
    s1["A4"] = f"Total Spent: {round(total,2)}"

    # Sheet 2 – By Category
    s2 = wb.create_sheet("By Category")
    s2.append(["Category", "Amount"])
    by_cat = {}
    for e in expenses:
        if e["kind"] == "expense":
            by_cat[e["category"]] = by_cat.get(e["category"], 0) + e["amount"]
    for k, v in by_cat.items():
        s2.append([k, round(v, 2)])

    # Sheet 3 – Per Member
    s3 = wb.create_sheet("Per Member")
    s3.append(["Member", "Type", "People", "Net Balance", "Per-Person"])
    for pp in bal["per_person"]:
        s3.append([pp["member_name"], pp["kind"], pp["people_count"],
                   pp["net_total"], pp["net_per_person"]])

    # Sheet 3b – Family per-person breakdown
    s3b = wb.create_sheet("Per Family Person")
    s3b.append(["Family", "Person", "Share of Net Balance"])
    for pp in bal["per_person"]:
        if pp["kind"] == "family" and pp["family_members"]:
            for name in pp["family_members"]:
                s3b.append([pp["member_name"], name, pp["net_per_person"]])

    # Sheet 4 – Transactions (now carries the Split Mode of each line item)
    sorted_expenses = sorted(expenses, key=lambda x: x.get("date", ""))
    members = trip["members"]
    s4 = wb.create_sheet("Transactions")
    s4.append(["Date", "Kind", "Category", "Description", "Amount", "Paid By",
               "Split Among", "Split Mode"])
    for r in build_transaction_rows(sorted_expenses, members):
        s4.append([r["date"], r["kind"], r["category"], r["description"],
                   r["amount"], r["paid_by"], r["split_among"], r["split_mode"]])

    # Sheet 5 – Per-Capita Math (Section 5A: per-human division validation)
    s5 = wb.create_sheet("Per-Capita Math")
    s5.append(["Date", "Category", "Description", "Amount", "Total Humans",
               "Per-Person", "Member", "Weight", "Share"])
    for r in build_per_capita_rows(sorted_expenses, members):
        s5.append([r["date"], r["category"], r["description"], r["amount"],
                   r["total_humans"], r["per_human"], r["member_name"],
                   r["member_weight"], r["member_share"]])

    # Sheet 6 – Per-Family Math (Section 5B: flat per-entity division validation)
    s6 = wb.create_sheet("Per-Family Math")
    s6.append(["Date", "Category", "Description", "Amount", "Total Entities",
               "Per-Entity", "Member", "Share"])
    for r in build_per_family_rows(sorted_expenses, members):
        s6.append([r["date"], r["category"], r["description"], r["amount"],
                   r["total_entities"], r["per_entity"], r["member_name"],
                   r["member_share"]])

    # header styling
    header_fill = PatternFill("solid", fgColor="1C3F39")
    for sheet in [s2, s3, s3b, s4, s5, s6]:
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = header_fill

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f"{trip['name'].replace(' ','_')}_report.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )
