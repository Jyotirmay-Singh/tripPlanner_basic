# Integration tests for Step 8 retroactive family re-allocation (live server).
# Skip-safe: the `test_user` fixture skips the whole module if the backend is unavailable.
# Uses explicit split_member_ids=[fam, ind] so the trip's auto-created owner member (net 0) does
# not skew the math, letting us assert exact per-member nets.
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _setup(api_client, token, name, fam_size=2):
    """Create a trip with a family (fam_size members) + an individual. Returns ids."""
    trip = api_client.post(f"{BASE_URL}/api/trips", json={
        "name": name, "travel_date": "10-05-26", "currency": "INR",
    }, headers=_h(token)).json()
    trip_id = trip["id"]
    fam = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
        "name": "TEST_Fam", "kind": "family",
        "family_members": [f"m{i}" for i in range(fam_size)],
    }, headers=_h(token)).json()
    ind = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json={
        "name": "TEST_Ind", "kind": "individual",
    }, headers=_h(token)).json()
    return trip_id, fam["id"], ind["id"]


def _add_expense(api_client, token, trip_id, amount, paid_by, split_ids, snaps=None):
    body = {
        "kind": "expense", "amount": amount, "category": "Food",
        "description": "x", "date": "11-05-26", "paid_by_member_id": paid_by,
        "split_member_ids": split_ids, "split_mode": "PER_CAPITA",
    }
    if snaps is not None:
        body["weight_snapshots"] = snaps
    return api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json=body, headers=_h(token))


def _net(api_client, token, trip_id):
    r = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=_h(token))
    assert r.status_code == 200, r.text
    return r.json()["net"]


class TestReallocationApi:

    def test_retroactive_recalculates_past(self, api_client, test_user):
        """reweight_past=True: growing the family re-splits the past expense at the new size."""
        token = test_user["token"]
        trip_id, fam, ind = _setup(api_client, token, "TEST_Realloc Retro", fam_size=2)

        # PER_CAPITA 120 split [fam(2), ind(1)] => H=3, per-human 40: fam -80, ind +80.
        _add_expense(api_client, token, trip_id, 120.0, ind, [fam, ind])
        net0 = _net(api_client, token, trip_id)
        assert abs(net0[fam] - (-80.0)) < 0.01
        assert abs(net0[ind] - 80.0) < 0.01

        # Grow family 2 -> 4, recalc the past (default True, sent explicitly).
        r = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{fam}", json={
            "family_members": ["m0", "m1", "m2", "m3"], "reweight_past": True,
        }, headers=_h(token))
        assert r.status_code == 200, r.text

        # Now H=5, per-human 24: fam -96, ind +96.
        net1 = _net(api_client, token, trip_id)
        assert abs(net1[fam] - (-96.0)) < 0.01
        assert abs(net1[ind] - 96.0) < 0.01
        assert abs(sum(net1.values())) < 0.01  # ledger stays balanced

    def test_future_only_freezes_past_and_new_uses_new_size(self, api_client, test_user):
        """reweight_past=False: past expense frozen at old size; a later expense uses the new size."""
        token = test_user["token"]
        trip_id, fam, ind = _setup(api_client, token, "TEST_Realloc Future", fam_size=2)

        # Expense 1: PER_CAPITA 120 split [fam(2), ind(1)] => fam -80.
        _add_expense(api_client, token, trip_id, 120.0, ind, [fam, ind])

        # Grow family 2 -> 4 but freeze the past.
        r = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{fam}", json={
            "family_members": ["m0", "m1", "m2", "m3"], "reweight_past": False,
        }, headers=_h(token))
        assert r.status_code == 200, r.text

        net_after_freeze = _net(api_client, token, trip_id)
        assert abs(net_after_freeze[fam] - (-80.0)) < 0.01  # past unchanged

        # Expense 2 (created after resize): uses live size 4 => H=5, fam owes 96.
        _add_expense(api_client, token, trip_id, 120.0, ind, [fam, ind])
        net2 = _net(api_client, token, trip_id)
        # fam = -(80 + 96) = -176  (uniquely: retroactive would be -192, all-old -160).
        assert abs(net2[fam] - (-176.0)) < 0.01
        assert abs(net2[ind] - 176.0) < 0.01
        assert abs(sum(net2.values())) < 0.01

    def test_retroactive_preserves_partial_family_override(self, api_client, test_user):
        """A partial-family override (set at creation) must survive a retroactive recalc."""
        token = test_user["token"]
        trip_id, fam, ind = _setup(api_client, token, "TEST_Realloc Override", fam_size=2)

        # fam attends this expense as 1 person via weight_snapshots override.
        # H = 1 (override) + 1 (ind) = 2, per-human 60: fam -60, ind +60.
        _add_expense(api_client, token, trip_id, 120.0, ind, [fam, ind], snaps={fam: 1})
        net0 = _net(api_client, token, trip_id)
        assert abs(net0[fam] - (-60.0)) < 0.01

        # Grow family 2 -> 4 with retroactive recalc. The override is NOT a size-freeze,
        # so it must be preserved -> fam still owes 60 (not 96).
        r = api_client.patch(f"{BASE_URL}/api/trips/{trip_id}/members/{fam}", json={
            "family_members": ["m0", "m1", "m2", "m3"], "reweight_past": True,
        }, headers=_h(token))
        assert r.status_code == 200, r.text

        net1 = _net(api_client, token, trip_id)
        assert abs(net1[fam] - (-60.0)) < 0.01  # override preserved (would be -96 if wiped)
        assert abs(sum(net1.values())) < 0.01
