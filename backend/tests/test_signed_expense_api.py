# Live-server API tests for signed amounts (conftest requests/BASE_URL style, like test_expenses.py).
# End-to-end: a negative expense is stored signed and moves balances in the mirror direction; a zero
# amount is rejected by the model.
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


class TestSignedExpenseApi:
    def _trip_with_two_members(self, api_client, token):
        trip = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_Signed Trip", "start_date": "2026-01-10",
            "end_date": "2026-01-15", "currency": "INR",
        }, headers={"Authorization": f"Bearer {token}"}).json()
        m1 = trip["members"][0]["id"]
        m2 = api_client.post(f"{BASE_URL}/api/trips/{trip['id']}/members", json={
            "name": "TEST_Other", "kind": "individual",
        }, headers={"Authorization": f"Bearer {token}"}).json()["id"]
        return trip["id"], m1, m2

    def test_negative_expense_moves_balances_in_mirror_direction(self, api_client, test_user):
        token = test_user["token"]
        trip_id, m1, m2 = self._trip_with_two_members(api_client, token)
        # m1 receives a 100 refund and splits it across both -> per-person 50.
        r = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "amount": -100.0, "category": "Food", "description": "Refund",
            "date": "11-05-26", "paid_by_member_id": m1, "split_member_ids": [],
        }, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        assert r.json()["expense"]["amount"] == -100.0
        bal = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances",
                             headers={"Authorization": f"Bearer {token}"}).json()
        # Receiver m1 owes the group back (-50); m2 is credited (+50).
        assert bal["net"][m1] == -50.0
        assert bal["net"][m2] == 50.0

    def test_zero_amount_rejected(self, api_client, test_user):
        token = test_user["token"]
        trip_id, m1, _ = self._trip_with_two_members(api_client, token)
        r = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "amount": 0, "category": "Food", "description": "zero",
            "date": "11-05-26", "paid_by_member_id": m1, "split_member_ids": [],
        }, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 422
