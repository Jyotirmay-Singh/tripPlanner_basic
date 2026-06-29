# Live-server API test (requests/BASE_URL style; runs in the full gate) for intra-family
# member participation: family_participants round-trips and the /balances per-member breakdown
# shows the excluded member at 0 while the family total and the other entity stay unchanged.
import os
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


class TestFamilyParticipationAPI:

    def _h(self, token):
        return {"Authorization": f"Bearer {token}"}

    def test_excluded_member_zero_and_involved_count_weight(self, api_client, test_user):
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

        # PER_CAPITA $50, exclude the 4th family member (D) -> the family counts as its INVOLVED
        # count (3), not full size (CLAUDE.md §5-A): H = 3 + 1 = 4, per_human 12.5; family owes 37.5.
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense", "amount": 50.0, "category": "Food", "description": "Dinner",
            "date": "11-01-26", "paid_by_member_id": owner_id, "split_member_ids": [],
            "split_mode": "PER_CAPITA",
            "family_participants": {fam_id: fam_ids[:3]},
        }, headers=h)

        bal = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=h).json()

        # Involved-count weight: family owes 37.5 (3 * 12.5); owner is owed 37.5 (50 - its own 12.5).
        assert abs(bal["net"][fam_id] - (-37.5)) < 0.01
        assert abs(bal["net"][owner_id] - 37.5) < 0.01

        fam_pp = next(pp for pp in bal["per_person"] if pp["member_id"] == fam_id)
        members = {row["id"]: row["net"] for row in fam_pp["members"]}
        assert len(members) == 4
        assert members[fam_ids[3]] == 0.0                       # excluded member owes nothing
        assert round(sum(members.values()), 2) == -37.5         # sums EXACTLY to the family total
        for mid in fam_ids[:3]:
            assert abs(members[mid] - (-12.5)) < 0.01           # 37.5 / 3 each

        # Individuals carry an empty per-member breakdown.
        owner_pp = next(pp for pp in bal["per_person"] if pp["member_id"] == owner_id)
        assert owner_pp["members"] == []

    def test_breakdown_shows_remainder_after_paid_settlement_no_blowup(self, api_client, test_user):
        # BUG 1: a family fronts a large bill and consumes (restricted to one member), then is paid
        # back via a PAID settlement that nets it down to a small remainder. The per-member rows must
        # show that small remainder (no millions, no opposite-sign blow-ups) and sum EXACTLY to it.
        h = self._h(test_user["token"])
        trip = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_FamRemainder",
            "start_date": "2026-01-10", "end_date": "2026-01-15", "currency": "INR",
        }, headers=h).json()
        trip_id = trip["id"]
        owner_id = trip["members"][0]["id"]
        fam = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_FamR", "kind": "family", "family_members": ["A", "B"],
            "family_member_ids": [None, None],
        }, headers=h).json()
        fam_id, fam_ids = fam["id"], fam["family_member_ids"]

        # Family pays 90000, split PER_CAPITA with owner; only member A took part for the family.
        # F involved = 1 -> H = 2, per-human 45000: F owes 45000, owner owes 45000, F net = +45000.
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense", "amount": 90000.0, "category": "Accommodation", "description": "Villa",
            "date": "11-01-26", "paid_by_member_id": fam_id, "split_member_ids": [fam_id, owner_id],
            "split_mode": "PER_CAPITA", "family_participants": {fam_id: [fam_ids[0]]},
        }, headers=h)

        # Owner pays the family back 44990 (PAID) -> family net drops to +10.
        sid = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": owner_id, "to_member_id": fam_id, "amount": 44990.0,
        }, headers=h).json()["id"]
        mark = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/settlements/{sid}",
                                json={"status": "paid"}, headers=h)
        assert mark.status_code == 200, mark.text

        bal = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=h).json()
        assert abs(bal["net"][fam_id] - 10.0) < 0.01
        fam_pp = next(pp for pp in bal["per_person"] if pp["member_id"] == fam_id)
        rows = {row["id"]: row["net"] for row in fam_pp["members"]}
        assert round(sum(rows.values()), 2) == round(bal["net"][fam_id], 2)  # rows sum to family net
        assert all(abs(v) < 1000.0 for v in rows.values())                   # NO millions blow-up
        assert rows[fam_ids[1]] == 0.0                                       # B never took part -> 0

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

    def test_per_family_redistributes_within_each_family(self, api_client, test_user):
        # PER_FAMILY participation: the flat per-entity share (1000 / 2 = 500) is unchanged, but each
        # family's 500 is split only among its participants — the $1000 / 2-family worked example.
        h = self._h(test_user["token"])
        trip = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": "TEST_FamPerFamily",
            "start_date": "2026-01-10", "end_date": "2026-01-15", "currency": "INR",
        }, headers=h).json()
        trip_id = trip["id"]
        owner_id = trip["members"][0]["id"]  # individual payer (not in the split)

        f1 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Fam1", "kind": "family", "family_members": ["A", "B", "C", "D"],
            "family_member_ids": [None, None, None, None],
        }, headers=h).json()
        f2 = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
            "name": "TEST_Fam2", "kind": "family", "family_members": ["W", "X", "Y", "Z"],
            "family_member_ids": [None, None, None, None],
        }, headers=h).json()
        f1_id, f1_ids = f1["id"], f1["family_member_ids"]
        f2_id, f2_ids = f2["id"], f2["family_member_ids"]

        # PER_FAMILY $1000 across the 2 families only -> each owes a flat 500; owner pays 1000.
        # F1: A,B,C take part (D excluded); F2: W,X take part (Y,Z excluded).
        api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense", "amount": 1000.0, "category": "Accommodation", "description": "Hotel",
            "date": "11-01-26", "paid_by_member_id": owner_id,
            "split_member_ids": [f1_id, f2_id], "split_mode": "PER_FAMILY",
            "family_participants": {f1_id: f1_ids[:3], f2_id: f2_ids[:2]},
        }, headers=h)

        bal = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=h).json()
        # Entity totals unchanged: each family owes a flat 500, owner is owed 1000.
        assert abs(bal["net"][f1_id] - (-500.0)) < 0.01
        assert abs(bal["net"][f2_id] - (-500.0)) < 0.01
        assert abs(bal["net"][owner_id] - 1000.0) < 0.01

        f1_members = {row["id"]: row["net"]
                      for row in next(pp for pp in bal["per_person"] if pp["member_id"] == f1_id)["members"]}
        assert f1_members[f1_ids[3]] == 0.0                       # excluded D owes nothing
        assert round(sum(f1_members.values()), 2) == -500.0
        for mid in f1_ids[:3]:
            assert abs(f1_members[mid] - (-500.0 / 3)) < 0.01     # ~ -166.67 each

        f2_members = {row["id"]: row["net"]
                      for row in next(pp for pp in bal["per_person"] if pp["member_id"] == f2_id)["members"]}
        assert f2_members[f2_ids[2]] == 0.0 and f2_members[f2_ids[3]] == 0.0  # Y, Z excluded
        assert f2_members[f2_ids[0]] == -250.0 and f2_members[f2_ids[1]] == -250.0  # 500 / 2
        assert round(sum(f2_members.values()), 2) == -500.0
