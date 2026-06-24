# Live-server API test (requests/BASE_URL style; runs in the full gate) for intra-family
# member participation: family_participants round-trips and the /balances per-member breakdown
# shows the excluded member at 0 while the family total and the other entity stay unchanged.
import os
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


class TestFamilyParticipationAPI:

    def _h(self, token):
        return {"Authorization": f"Bearer {token}"}

    def test_excluded_member_zero_family_total_and_individual_unchanged(self, api_client, test_user):
        h = self._h(test_user["token"])

        trip = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_FamParticipation",
            "start_date": "2026-01-10", "end_date": "2026-01-15", "currency": "INR",
        }, headers=h).json()
        trip_id = trip["id"]
        owner_id = trip["members"][0]["id"]  # individual (weight 1)

        # Mimic the structured editor: new rows send null ids -> the server mints them.
        fam = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Fam", "kind": "family", "family_members": ["A", "B", "C", "D"],
            "family_member_ids": [None, None, None, None],
        }, headers=h).json()
        fam_id = fam["id"]
        fam_ids = fam["family_member_ids"]
        assert len(fam_ids) == 4 and len(set(fam_ids)) == 4  # stable ids minted, parallel + unique
        assert all(isinstance(x, str) and x for x in fam_ids)

        # PER_CAPITA $50 across 5 humans (owner=1, family=4) -> per_human 10; family owes 40.
        # Exclude the 4th family member (D).
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense", "amount": 50.0, "category": "Food", "description": "Dinner",
            "date": "11-01-26", "paid_by_member_id": owner_id, "split_member_ids": [],
            "split_mode": "PER_CAPITA",
            "family_participants": {fam_id: fam_ids[:3]},
        }, headers=h)

        bal = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=h).json()

        # Model A: family total unchanged (counts as 4 -> owes 40), individual unaffected (+40).
        assert abs(bal["net"][fam_id] - (-40.0)) < 0.01
        assert abs(bal["net"][owner_id] - 40.0) < 0.01

        fam_pp = next(pp for pp in bal["per_person"] if pp["member_id"] == fam_id)
        members = {row["id"]: row["net"] for row in fam_pp["members"]}
        assert len(members) == 4
        assert members[fam_ids[3]] == 0.0                       # excluded member owes nothing
        assert round(sum(members.values()), 2) == -40.0         # sums EXACTLY to the family total
        for mid in fam_ids[:3]:
            assert abs(members[mid] - (-40.0 / 3)) < 0.01       # ~ -13.33 each

        # Individuals carry an empty per-member breakdown.
        owner_pp = next(pp for pp in bal["per_person"] if pp["member_id"] == owner_id)
        assert owner_pp["members"] == []

    def test_no_participation_is_uniform(self, api_client, test_user):
        h = self._h(test_user["token"])
        trip = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_FamUniform",
            "start_date": "2026-01-10", "end_date": "2026-01-15", "currency": "INR",
        }, headers=h).json()
        trip_id = trip["id"]
        owner_id = trip["members"][0]["id"]
        fam = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Fam2", "kind": "family", "family_members": ["A", "B"],
        }, headers=h).json()
        fam_id = fam["id"]

        # No family_participants -> every family member shows the uniform net_per_person.
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense", "amount": 30.0, "category": "Food", "description": "Lunch",
            "date": "11-01-26", "paid_by_member_id": owner_id, "split_member_ids": [],
            "split_mode": "PER_CAPITA",
        }, headers=h)

        bal = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=h).json()
        fam_pp = next(pp for pp in bal["per_person"] if pp["member_id"] == fam_id)
        assert all(row["net"] == fam_pp["net_per_person"] for row in fam_pp["members"])
