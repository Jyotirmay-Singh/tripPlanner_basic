# Step 10: Expense Modification Protection
# Only the expense creator OR a trip admin may PATCH/DELETE an expense.
# Missing expense -> 404; non-creator non-admin member / non-member -> 403.
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


class TestExpenseRBAC:
    """PATCH/DELETE expense access control: creator-or-admin only."""

    # ---------- helpers ----------
    def _auth(self, token):
        return {"Authorization": f"Bearer {token}"}

    def _create_trip(self, api_client, token, name="TEST_ExpRBAC Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name,
            "start_date": "2026-01-10", "end_date": "2026-01-15",
            "currency": "USD",
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _register_user(self, api_client, name="Second User"):
        email = f"TEST_exprbac_{uuid.uuid4().hex[:8]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email,
            "password": "test12345",
            "pin": "5678",
            "name": name,
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        return data["access_token"], data["user"]["id"]

    def _join_trip(self, api_client, token, code):
        resp = api_client.post(f"{BASE_URL}/api/trips/join", json={
            "code": code,
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _promote_admin(self, api_client, token, trip_id, user_id):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/admins", json={
            "user_id": user_id,
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _add_expense(self, api_client, token, trip_id, paid_by_member_id, amount=100.0):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense",
            "amount": amount,
            "category": "Food",
            "description": "RBAC fixture expense",
            "date": "16-05-26",
            "paid_by_member_id": paid_by_member_id,
            "split_member_ids": [],
        }, headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["expense"]

    def _list_expenses(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/expenses",
                              headers=self._auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    # ---------- creator can modify ----------
    def test_creator_can_update_own_expense(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        resp = api_client.patch(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            json={"amount": 250.0, "description": "edited by creator"},
            headers=self._auth(test_user["token"]),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["amount"] == 250.0

    def test_creator_can_delete_own_expense(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        resp = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            headers=self._auth(test_user["token"]),
        )
        assert resp.status_code == 200, resp.text
        remaining = self._list_expenses(api_client, test_user["token"], trip["id"])
        assert all(e["id"] != exp["id"] for e in remaining)

    # ---------- admin (non-creator) can modify ----------
    def test_admin_can_update_others_expense(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        member_token, _ = self._register_user(api_client, "Member Two")
        self._join_trip(api_client, member_token, trip["code"])

        # expense created by member2 ...
        exp = self._add_expense(api_client, member_token, trip["id"], member_id)
        # ... edited by owner (admin, not the creator)
        resp = api_client.patch(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            json={"amount": 333.0},
            headers=self._auth(test_user["token"]),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["amount"] == 333.0

    def test_admin_can_delete_others_expense(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        member_token, _ = self._register_user(api_client, "Member Two")
        self._join_trip(api_client, member_token, trip["code"])
        exp = self._add_expense(api_client, member_token, trip["id"], member_id)

        resp = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            headers=self._auth(test_user["token"]),
        )
        assert resp.status_code == 200, resp.text

    def test_promoted_admin_can_modify_others_expense(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        # expense created by the owner
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        member_token, member_id_user = self._register_user(api_client, "Promotable")
        self._join_trip(api_client, member_token, trip["code"])
        self._promote_admin(api_client, test_user["token"], trip["id"], member_id_user)

        # now-an-admin member2 edits the owner's expense
        resp = api_client.patch(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            json={"description": "edited by promoted admin"},
            headers=self._auth(member_token),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["description"] == "edited by promoted admin"

    # ---------- non-creator non-admin member is blocked ----------
    def test_non_creator_non_admin_update_forbidden(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id, amount=100.0)

        member_token, _ = self._register_user(api_client, "Plain Member")
        self._join_trip(api_client, member_token, trip["code"])

        resp = api_client.patch(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            json={"amount": 999.0},
            headers=self._auth(member_token),
        )
        assert resp.status_code == 403, resp.text

        # expense must be untouched
        expenses = self._list_expenses(api_client, test_user["token"], trip["id"])
        target = next(e for e in expenses if e["id"] == exp["id"])
        assert target["amount"] == 100.0

    def test_non_creator_non_admin_delete_forbidden(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        member_token, _ = self._register_user(api_client, "Plain Member")
        self._join_trip(api_client, member_token, trip["code"])

        resp = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            headers=self._auth(member_token),
        )
        assert resp.status_code == 403, resp.text

        # expense must still be present
        expenses = self._list_expenses(api_client, test_user["token"], trip["id"])
        assert any(e["id"] == exp["id"] for e in expenses)

    # ---------- non-member is blocked ----------
    def test_non_member_forbidden(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        member_id = trip["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip["id"], member_id)

        outsider_token, _ = self._register_user(api_client, "Outsider")  # never joins

        patch_resp = api_client.patch(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            json={"amount": 1.0},
            headers=self._auth(outsider_token),
        )
        assert patch_resp.status_code == 403, patch_resp.text

        del_resp = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{exp['id']}",
            headers=self._auth(outsider_token),
        )
        assert del_resp.status_code == 403, del_resp.text

    # ---------- missing / mis-scoped expense -> 404 ----------
    def test_missing_expense_returns_404(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        bogus_id = str(uuid.uuid4())

        patch_resp = api_client.patch(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{bogus_id}",
            json={"amount": 5.0},
            headers=self._auth(test_user["token"]),
        )
        assert patch_resp.status_code == 404, patch_resp.text

        del_resp = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/expenses/{bogus_id}",
            headers=self._auth(test_user["token"]),
        )
        assert del_resp.status_code == 404, del_resp.text

    def test_expense_addressed_via_wrong_trip_returns_404(self, api_client, test_user):
        trip_a = self._create_trip(api_client, test_user["token"], name="TEST_ExpRBAC A")
        trip_b = self._create_trip(api_client, test_user["token"], name="TEST_ExpRBAC B")
        member_id = trip_a["members"][0]["id"]
        exp = self._add_expense(api_client, test_user["token"], trip_a["id"], member_id)

        # the expense exists, but not under trip_b -> trip-scoped lookup returns 404
        resp = api_client.patch(
            f"{BASE_URL}/api/trips/{trip_b['id']}/expenses/{exp['id']}",
            json={"amount": 7.0},
            headers=self._auth(test_user["token"]),
        )
        assert resp.status_code == 404, resp.text
