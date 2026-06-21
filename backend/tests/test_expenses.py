# Expense tests: add with categories, default/selected split, budget over-limit, update, delete
import pytest
import requests
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')

class TestExpenses:
    """Expense management endpoint tests"""

    def test_add_expense_with_category(self, api_client, test_user):
        """Test POST /trips/{id}/expenses with category=Food"""
        # Create trip
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Expense Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        # Add expense
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 500.0,
            "category": "Food",
            "description": "Dinner at restaurant",
            "date": "11-05-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        data = response.json()
        assert "expense" in data
        exp = data["expense"]
        assert exp["amount"] == 500.0
        assert exp["category"] == "Food"
        assert exp["description"] == "Dinner at restaurant"
        assert exp["paid_by_member_id"] == member_id

    def test_add_expense_default_split(self, api_client, test_user):
        """Test expense with empty split_member_ids splits among all members"""
        # Create trip with 2 members
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Split Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member1_id = trip_resp.json()["members"][0]["id"]

        # Add second member
        member2_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Member2",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member2_id = member2_resp.json()["id"]

        # Add expense with empty split (default to all)
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 200.0,
            "category": "Travel",
            "description": "Taxi",
            "date": "16-06-26",
            "paid_by_member_id": member1_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        exp = response.json()["expense"]
        # Should split among all members
        assert len(exp["split_member_ids"]) == 2
        assert member1_id in exp["split_member_ids"]
        assert member2_id in exp["split_member_ids"]

    def test_add_expense_selected_split(self, api_client, test_user):
        """Test expense with specific split_member_ids"""
        # Create trip with 3 members
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Selected Split Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "EUR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member1_id = trip_resp.json()["members"][0]["id"]

        member2_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Member2",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member2_id = member2_resp.json()["id"]

        member3_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Member3",
            "kind": "individual"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        member3_id = member3_resp.json()["id"]

        # Add expense split only between member1 and member2
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 300.0,
            "category": "Accommodation",
            "description": "Hotel room",
            "date": "21-07-26",
            "paid_by_member_id": member1_id,
            "split_member_ids": [member1_id, member2_id]
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        exp = response.json()["expense"]
        assert len(exp["split_member_ids"]) == 2
        assert member1_id in exp["split_member_ids"]
        assert member2_id in exp["split_member_ids"]
        assert member3_id not in exp["split_member_ids"]

    def test_budget_over_limit_requires_confirmation(self, api_client, test_user):
        """Test expense exceeding budget returns requires_confirmation=true"""
        # Create trip with budget
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Budget Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "budget": 1000.0,
            "currency": "GBP"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        # Add expense that exceeds budget
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 1500.0,
            "category": "Shopping",
            "description": "Over budget",
            "date": "26-08-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        data = response.json()
        assert data["requires_confirmation"] is True
        assert "warning" in data
        assert "over" in data["warning"].lower()

    def test_budget_over_limit_with_force(self, api_client, test_user):
        """Test expense with ?force=true bypasses budget check"""
        # Create trip with budget
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Force Budget Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "budget": 500.0,
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        # Add expense with force=true
        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses?force=true", json={
            "kind": "expense",
            "amount": 800.0,
            "category": "Other",
            "description": "Forced expense",
            "date": "01-10-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        data = response.json()
        assert "expense" in data
        assert data["expense"]["amount"] == 800.0

    def test_list_expenses(self, api_client, test_user):
        """Test GET /trips/{id}/expenses"""
        # Create trip and expense
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_List Expenses Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 100.0,
            "category": "Food",
            "description": "Lunch",
            "date": "06-10-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # List expenses
        response = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/expenses", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        assert any(e["description"] == "Lunch" for e in data)

    def test_update_expense(self, api_client, test_user):
        """Test PATCH /trips/{id}/expenses/{expense_id}"""
        # Create trip and expense
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Update Expense Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "EUR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        exp_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 50.0,
            "category": "Food",
            "description": "Old description",
            "date": "11-11-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        expense_id = exp_resp.json()["expense"]["id"]

        # Update expense
        response = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/expenses/{expense_id}", json={
            "amount": 75.0,
            "description": "New description"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        
        assert response.status_code == 200
        data = response.json()
        assert data["amount"] == 75.0
        assert data["description"] == "New description"

    def test_delete_expense(self, api_client, test_user):
        """Test DELETE /trips/{id}/expenses/{expense_id}"""
        # Create trip and expense
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Delete Expense Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "GBP"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        exp_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 25.0,
            "category": "Other",
            "description": "To delete",
            "date": "16-12-26",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        expense_id = exp_resp.json()["expense"]["id"]

        # Delete expense
        response = api_client.delete(f"{BASE_URL}/api/trips/{trip_id}/expenses/{expense_id}", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        assert response.status_code == 200

    def test_family_member_weight_split(self, api_client, test_user):
        """Test expense paid by family of 3 splits 3x vs 1 for individuals"""
        # Create trip
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Family Weight Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "INR"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        individual_id = trip_resp.json()["members"][0]["id"]

        # Add family member with 3 people
        family_resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Family of 3",
            "kind": "family",
            "family_members": ["Alice", "Bob", "Charlie"]
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        family_id = family_resp.json()["id"]

        # Add expense split between individual and family
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 400.0,
            "category": "Food",
            "description": "Group dinner",
            "date": "21-01-27",
            "paid_by_member_id": individual_id,
            "split_member_ids": [individual_id, family_id]
        }, headers={"Authorization": f"Bearer {test_user['token']}"})

        # Get balances
        balance_resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers={
            "Authorization": f"Bearer {test_user['token']}"
        })
        balances = balance_resp.json()
        
        # Individual paid 400, owes 100 (1/4 of 400), net = +300
        # Family owes 300 (3/4 of 400), net = -300
        individual_net = balances["net"][individual_id]
        family_net = balances["net"][family_id]
        
        assert abs(individual_net - 300.0) < 0.01, f"Individual net should be ~300, got {individual_net}"
        assert abs(family_net - (-300.0)) < 0.01, f"Family net should be ~-300, got {family_net}"

    def test_invalid_category(self, api_client, test_user):
        """Test expense with invalid category fails"""
        trip_resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Invalid Category Trip",
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "USD"
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        trip_id = trip_resp.json()["id"]
        member_id = trip_resp.json()["members"][0]["id"]

        response = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": 100.0,
            "category": "InvalidCategory",
            "description": "Test",
            "date": "26-02-27",
            "paid_by_member_id": member_id,
            "split_member_ids": []
        }, headers={"Authorization": f"Bearer {test_user['token']}"})
        assert response.status_code == 400
