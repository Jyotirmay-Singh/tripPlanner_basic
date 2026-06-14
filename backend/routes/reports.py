import io

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

from database import db
from utils.deps import get_current_user, _trip_or_404
from utils.balances import _compute_balances
from utils.security import decode_token

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

    # Sheet 4 – Transactions
    s4 = wb.create_sheet("Transactions")
    s4.append(["Date", "Kind", "Category", "Description", "Amount", "Paid By", "Split Among"])
    for e in sorted(expenses, key=lambda x: x.get("date", "")):
        paid = members_by_id.get(e["paid_by_member_id"], {}).get("name", "?")
        split = ", ".join(members_by_id.get(sid, {}).get("name", "?") for sid in e["split_member_ids"])
        s4.append([e["date"], e["kind"], e["category"], e.get("description", ""),
                   e["amount"], paid, split])

    # header styling
    header_fill = PatternFill("solid", fgColor="1C3F39")
    for sheet in [s2, s3, s3b, s4]:
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
