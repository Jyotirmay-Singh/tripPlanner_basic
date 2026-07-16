# Phase 26 — Live-API tests for creator identity + families never carrying an entity email.
# Requires a running server + Mongo (same convention as the other *_api.py suites).
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


class _Helpers:
    def _create(self, api_client, token, **body):
        base = {"name": "TEST_P26 Trip", "start_date": "2026-03-01", "end_date": "2026-03-05", "currency": "INR"}
        return api_client.post(f"{BASE_URL}/api/trips", json={**base, **body}, headers=_auth(token))

    def _get_trip(self, api_client, token, trip_id):
        return api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=_auth(token)).json()

    def _add_family(self, api_client, token, trip_id, **body):
        return api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members",
                               json={"kind": "family", **body}, headers=_auth(token))


class TestCreateIdentity(_Helpers):
    def test_create_as_family_attaches_owner_to_member_slot(self, api_client, test_user):
        r = self._create(api_client, test_user["token"], self_kind="family",
                         family_name="Sharma Family", family_members=["Arjun", "Priya"], self_index=1)
        assert r.status_code == 200, r.text
        trip = r.json()
        assert len(trip["members"]) == 1
        fam = trip["members"][0]
        assert fam["kind"] == "family"
        assert fam["name"] == "Sharma Family"
        assert fam["family_members"] == ["Arjun", "Priya"]
        # The login email + account land on the chosen slot (index 1); the entity carries neither.
        assert fam["family_member_emails"] == [None, test_user["email"]]
        assert fam["family_member_user_ids"] == [None, test_user["user"]["id"]]
        assert fam.get("email") in (None, "")
        assert fam.get("user_id") in (None, "")
        # Owner wiring unchanged: creator is owner + admin + member.
        assert trip["owner_id"] == test_user["user"]["id"]
        assert test_user["user"]["id"] in trip["user_ids"]
        assert test_user["user"]["id"] in trip["admin_ids"]
        # Balances still compute.
        b = api_client.get(f"{BASE_URL}/api/trips/{trip['id']}/balances", headers=_auth(test_user["token"]))
        assert b.status_code == 200, b.text

    def test_create_as_individual_is_legacy_shape(self, api_client, test_user):
        # No identity fields -> byte-identical to the pre-Phase-26 default.
        r = self._create(api_client, test_user["token"])
        assert r.status_code == 200, r.text
        trip = r.json()
        assert len(trip["members"]) == 1
        m = trip["members"][0]
        assert m["kind"] == "individual"
        assert m["name"] == test_user["name"]
        assert m["email"] == test_user["email"]
        assert m["user_id"] == test_user["user"]["id"]

    def test_self_index_defaults_to_zero(self, api_client, test_user):
        r = self._create(api_client, test_user["token"], self_kind="family",
                         family_name="Fam", family_members=["Me", "Other"])
        assert r.status_code == 200, r.text
        fam = r.json()["members"][0]
        assert fam["family_member_emails"] == [test_user["email"], None]
        assert fam["family_member_user_ids"] == [test_user["user"]["id"], None]

    def test_create_as_family_validation(self, api_client, test_user):
        # Missing family name.
        assert self._create(api_client, test_user["token"], self_kind="family",
                            family_members=["A"]).status_code == 400
        # No members.
        assert self._create(api_client, test_user["token"], self_kind="family",
                            family_name="Fam", family_members=[]).status_code == 400
        # self_index out of range.
        assert self._create(api_client, test_user["token"], self_kind="family",
                            family_name="Fam", family_members=["A", "B"], self_index=5).status_code == 400


class TestFamilyNeverCarriesEntityEmail(_Helpers):
    def test_add_family_ignores_entity_email(self, api_client, test_user):
        trip = self._create(api_client, test_user["token"]).json()
        # A crafted body supplies an entity email; the server must drop it.
        fam = self._add_family(api_client, test_user["token"], trip["id"],
                               name="TEST_Fam", family_members=["A", "B"],
                               email="crafted@gmail.com").json()
        assert fam.get("email") in (None, "")

    def test_update_family_ignores_entity_email(self, api_client, test_user):
        trip = self._create(api_client, test_user["token"]).json()
        fam = self._add_family(api_client, test_user["token"], trip["id"],
                               name="TEST_Fam", family_members=["A", "B"]).json()
        patch = api_client.patch(f"{BASE_URL}/api/trips/{trip['id']}/members/{fam['id']}", json={
            "name": "TEST_Fam", "kind": "family", "family_members": ["A", "B"],
            "family_member_ids": fam["family_member_ids"], "email": "crafted@gmail.com",
        }, headers=_auth(test_user["token"]))
        assert patch.status_code == 200, patch.text
        assert patch.json().get("email") in (None, "")

    def test_individual_to_family_edit_nulls_entity_email(self, api_client, test_user):
        # An individual carrying an email, converted to a family, must lose the entity email.
        trip = self._create(api_client, test_user["token"]).json()
        indiv = api_client.post(f"{BASE_URL}/api/trips/{trip['id']}/members", json={
            "kind": "individual", "name": "Solo", "email": "solo_p26@gmail.com",
        }, headers=_auth(test_user["token"])).json()
        assert indiv["email"] == "solo_p26@gmail.com"
        patch = api_client.patch(f"{BASE_URL}/api/trips/{trip['id']}/members/{indiv['id']}", json={
            "kind": "family", "name": "Solo Family", "family_members": ["Solo", "Kid"],
        }, headers=_auth(test_user["token"]))
        assert patch.status_code == 200, patch.text
        assert patch.json().get("email") in (None, "")


class TestOwnerAsFamilyMemberProtected(_Helpers):
    def test_owner_family_member_cannot_be_removed(self, api_client, test_user):
        trip = self._create(api_client, test_user["token"], self_kind="family",
                           family_name="Sharma", family_members=["Arjun", "Priya"], self_index=0).json()
        fam = trip["members"][0]
        owner_slot_id = fam["family_member_ids"][0]
        # Removing the owner's own sub-member slot -> 403.
        d1 = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/members/{fam['id']}/family-members/{owner_slot_id}",
            headers=_auth(test_user["token"]))
        assert d1.status_code == 403, d1.text
        # Removing the WHOLE family (which contains the owner) -> 403.
        d2 = api_client.delete(f"{BASE_URL}/api/trips/{trip['id']}/members/{fam['id']}",
                               headers=_auth(test_user["token"]))
        assert d2.status_code == 403, d2.text
        # A non-owner slot in the same family can still be removed.
        other_slot_id = fam["family_member_ids"][1]
        d3 = api_client.delete(
            f"{BASE_URL}/api/trips/{trip['id']}/members/{fam['id']}/family-members/{other_slot_id}",
            headers=_auth(test_user["token"]))
        assert d3.status_code == 200, d3.text
