# Balances, settle-up, and reports tests
import io
import pytest
import requests
import os
from openpyxl import load_workbook
from pypdf import PdfReader

from utils.ist_time import format_ist

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')

class TestBalances:
    """Balance calculation and settle-up tests"""

    def test_get_balances(self, api_client, test_user):
        """Test GET /trips/{id}/balances returns net + transfers + members"""
        # Create trip with 2 members
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Balance Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member1_id = trip_resp.json()["members"][0]["id"]

        member2_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Member2",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member2_id = member2_resp.json()["id"]

        # Add expense
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 200.0,
            "category": "Food",
            "description": "Lunch",
            "date": "11-03-27",
            "paid_by_member_id": member1_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # Get balances
        response = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200
        data = response.json()
        assert "net" in data
        assert "transfers" in data
        assert "members" in data
        assert "currency" in data
        
        # Member1 paid 200, owes 100, net = +100
        # Member2 paid 0, owes 100, net = -100
        assert abs(data["net"][member1_id] - 100.0) < 0.01
        assert abs(data["net"][member2_id] - (-100.0)) < 0.01
        
        # Should have 1 transfer suggestion
        assert len(data["transfers"]) == 1
        assert data["transfers"][0]["from_member_id"] == member2_id
        assert data["transfers"][0]["to_member_id"] == member1_id
        assert abs(data["transfers"][0]["amount"] - 100.0) < 0.01

    def test_settle_up(self, api_client, test_user):
        """Test POST /trips/{id}/settle decreases debtor's debt"""
        # Create trip with 2 members
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Settle Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member1_id = trip_resp.json()["members"][0]["id"]

        member2_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Member2",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member2_id = member2_resp.json()["id"]

        # Add expense
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 300.0,
            "category": "Travel",
            "description": "Taxi",
            "date": "16-04-27",
            "paid_by_member_id": member1_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # Settle up: member2 pays member1 150
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settle", json={
            "from_member_id": member2_id,
            "to_member_id": member1_id,
            "amount": 150.0
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 200
        data = response.json()
        assert data["amount"] == 150.0
        assert data["from_member_id"] == member2_id
        assert data["to_member_id"] == member1_id

        # Check balances after settlement
        balance_resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        balances = balance_resp.json()
        
        # After settlement: member1 net = 150 - 150 = 0, member2 net = -150 + 150 = 0
        # Wait, member1 paid 300, owes 150, net = +150
        # member2 paid 0, owes 150, net = -150
        # After settle: member2 pays 150 to member1
        # member1 net = 150 + 150 = 300, member2 net = -150 + 150 = 0
        # Actually: net[member1] = paid - owed = 300 - 150 = 150
        # After settlement: member2 pays 150, so member2 net = -150 + 150 = 0
        # member1 receives 150, so member1 net = 150 - 150 = 0
        assert abs(balances["net"][member1_id]) < 0.01
        assert abs(balances["net"][member2_id]) < 0.01


class TestReports:
    """Report generation tests"""

    def test_get_report_json(self, api_client, test_user):
        """Test GET /trips/{id}/report returns JSON summary"""
        # Create trip with expenses
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Report Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "budget": 2000.0,
            "currency": "EUR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        # Add expenses in different categories
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 500.0,
            "category": "Food",
            "description": "Meals",
            "date": "21-05-27",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 800.0,
            "category": "Accommodation",
            "description": "Hotel",
            "date": "22-05-27",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # Get report
        response = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/report", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200
        data = response.json()
        assert "trip" in data
        assert "total_expense" in data
        assert "total_income" not in data  # income concept removed (signed-amount model)
        assert "budget" in data
        assert "by_category" in data
        assert "by_date" in data
        assert "balances" in data
        
        assert data["total_expense"] == 1300.0
        assert data["budget"] == 2000.0
        assert len(data["by_category"]) == 2
        assert any(c["category"] == "Food" and c["amount"] == 500.0 for c in data["by_category"])
        assert any(c["category"] == "Accommodation" and c["amount"] == 800.0 for c in data["by_category"])

    def test_get_report_xlsx(self, api_client, test_user):
        """Test GET /trips/{id}/report.xlsx?token=... returns XLSX binary"""
        # Create trip with expenses
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_XLSX Report Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "GBP"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        # A family member so the PER_FAMILY math tab has a multi-entity line item.
        fam_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Fam", "kind": "family", "family_members": ["a", "b"]
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        fam_id = fam_resp.json()["id"]

        # PER_CAPITA line item -> feeds the Per-Capita Math tab.
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 150.0,
            "category": "Shopping",
            "description": "Souvenirs",
            "date": "26-06-27",
            "paid_by_member_id": member_id,
            "split_member_ids": [],
            "split_mode": "PER_CAPITA"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # PER_FAMILY line item -> feeds the Per-Family Math tab.
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 120.0,
            "category": "Travel",
            "description": "Taxi",
            "date": "27-06-27",
            "paid_by_member_id": member_id,
            "split_member_ids": [member_id, fam_id],
            "split_mode": "PER_FAMILY"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # A signed money-back row must remain separate in both Summary reconciliations.
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": -20.0,
            "category": "Travel",
            "description": "Rail refund",
            "date": "28-06-27",
            "paid_by_member_id": member_id,
            "split_member_ids": [member_id, fam_id],
            "split_mode": "PER_FAMILY"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # Get XLSX report
        response = api_client.get(
            f"{BASE_URL}/api/trips/{trip_id}/report.xlsx?token={test_user['token']}"
        )
        assert response.status_code == 200
        assert "spreadsheet" in response.headers.get("Content-Type", "")
        assert len(response.content) > 0
        # Verify it's a valid XLSX file (starts with PK zip signature)
        assert response.content[:2] == b'PK'

        wb = load_workbook(io.BytesIO(response.content))
        assert wb.sheetnames == ["Summary", "Members & Families", "Transactions", "Payments"]
        summary = wb["Summary"]
        assert (summary["A8"].value, summary["D8"].value, summary["G8"].value) == (270, 20, 250)
        assert len(summary._pivots) == len(summary._charts) == 1
        assert summary._pivots[0].cache.cacheSource.worksheetSource.name == "ReportAllocations"
        mf = wb["Members & Families"]
        headers = [c.value for c in mf[4]]
        assert headers[0] == "Name" and headers[1].startswith("Expense share")
        assert headers[4].startswith("Settlements paid") and headers[5].startswith("Settlements received")
        account_rows = [r for r in mf.iter_rows(min_row=5, values_only=True)
                        if isinstance(r[2], (int, float))]
        assert len(account_rows) >= 3
        for row in account_rows:
            assert row[6] == row[2] - row[1] + row[4] - row[5]
        transactions = wb["Transactions"]
        allocations = [r for r in transactions.iter_rows(min_row=5, values_only=True) if isinstance(r[0], int)]
        assert sum(row[10] for row in allocations) == 250
        for expense_id in {r[11] for r in allocations}:
            expense_rows = [r for r in allocations if r[11] == expense_id]
            assert sum(r[10] for r in expense_rows) == expense_rows[0][9]
        assert {r[8] for r in allocations} <= {"Per-Person", "Per-Family"}

    def test_report_settlements_column_includes_partial_payments(self, api_client, test_user):
        """Phase 23 (BUG): the Members & Families 'Settlements' column must reflect BOTH the legacy
        non-pending settlements AND Phase-20 partial payments (the SAME overlay the ledger applies),
        or it understates reality. Pre-fix this cell read the settlement only. Also verifies the
        Payments header renamed to 'Receiver' and the full PDF renders."""
        h = {"Authorization": f"Bearer {test_user['token']}"}
        token = test_user["token"]

        trip = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Phase23 Settle+Pay", "start_date": "2026-01-10",
            "end_date": "2026-01-15", "currency": "INR"}, headers=h).json()
        trip_id = trip["id"]
        m1 = trip["members"][0]["id"]  # creator's member (payer / receiver of the settlement)
        m2 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members",
                             json={"name": "TEST_Debtor", "kind": "individual"},
                             headers=h).json()["id"]

        # m1 fronts 200 split between the two -> m2 owes m1 100 (suggested transfer m2 -> m1).
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense", "amount": 200.0, "category": "Food", "description": "Dinner",
            "date": "11-03-27", "paid_by_member_id": m1, "split_member_ids": []}, headers=h)

        # Legacy settlement 30 (stamped paid) THEN a partial payment 15, both m2 -> m1.
        r_settle = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settle", json={
            "from_member_id": m2, "to_member_id": m1, "amount": 30.0}, headers=h)
        assert r_settle.status_code == 200
        r_pay = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/payments", json={
            "from_member_id": m2, "to_member_id": m1, "amount": 15.0}, headers=h)
        assert r_pay.status_code == 200, r_pay.text

        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/report.xlsx?token={token}")
        assert resp.status_code == 200
        wb = load_workbook(io.BytesIO(resp.content))
        rows = [r for r in wb["Members & Families"].iter_rows(min_row=5, values_only=True)
                if isinstance(r[2], (int, float)) and r[0] != "Total"]
        payer = next(r for r in rows if r[2] == 200)
        debtor = next(r for r in rows if r[2] == 0)
        assert debtor[4:6] == (45, 0)
        assert payer[4:6] == (0, 45)
        assert payer[1] == debtor[1] == 100
        assert payer[6] == 55 and debtor[6] == -55
        for row in rows:
            assert row[6] == row[2] - row[1] + row[4] - row[5]
        payment_rows = list(wb["Payments"].values)
        history = [row for row in payment_rows if row[4] in ("Recorded payment", "Legacy settlement")]
        assert sum(row[2] for row in history) == 45
        assert next(r[2] for r in payment_rows if r[0] == "Recorded payments total") == 15
        assert next(r[2] for r in payment_rows if r[0] == "Legacy settlements total") == 30
        recorded = next(row for row in history if row[4] == "Recorded payment")
        from services.report_model import ist_datetime
        assert recorded[3] == ist_datetime(r_pay.json()["created_at"])
        assert recorded[5] == "Recorded"

        # ----- PDF: full report renders (same builders -> same values) -----
        pdf = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/report.pdf?token={token}")
        assert pdf.status_code == 200
        assert "application/pdf" in pdf.headers.get("Content-Type", "")
        assert pdf.content[:4] == b"%PDF"
        assert len(pdf.content) > 0
        pdf_text = "\n".join(
            page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf.content)).pages
        )
        assert "Funding by account" in pdf_text
        assert "Net spending by category" in pdf_text
        assert "Recorded settlement history" in pdf_text
        assert "Expense shares by family and person" in pdf_text
        assert "Split Math" not in pdf_text
