# Balances, settle-up, and reports tests
import io
import pytest
import requests
import os
from openpyxl import load_workbook

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://split-trips-1.preview.emergentagent.com').rstrip('/')

class TestBalances:
    """Balance calculation and settle-up tests"""

    def test_get_balances(self, api_client, test_user):
        """Test GET /trips/{id}/balances returns net + transfers + members"""
        # Create trip with 2 members
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Balance Trip",
            "travel_date": "10-03-27",
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
            "travel_date": "15-04-27",
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
            "travel_date": "20-05-27",
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
        assert "total_income" in data
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
            "travel_date": "25-06-27",
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

        # Get XLSX report
        response = api_client.get(
            f"{BASE_URL}/api/trips/{trip_id}/report.xlsx?token={test_user['token']}"
        )
        assert response.status_code == 200
        assert "spreadsheet" in response.headers.get("Content-Type", "")
        assert len(response.content) > 0
        # Verify it's a valid XLSX file (starts with PK zip signature)
        assert response.content[:2] == b'PK'

        # Step 9: the workbook now carries split-mode validation tabs and a Split Mode column.
        wb = load_workbook(io.BytesIO(response.content))
        assert "Per-Capita Math" in wb.sheetnames
        assert "Per-Family Math" in wb.sheetnames
        tx_header = [c.value for c in wb["Transactions"][1]]
        assert "Split Mode" in tx_header
        # Each math tab has its header row plus at least one data row.
        assert wb["Per-Capita Math"].max_row >= 2
        assert wb["Per-Family Math"].max_row >= 2
