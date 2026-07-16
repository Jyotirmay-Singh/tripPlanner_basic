# Step 12 — Complex Joining Context API.
# Integration tests for the contextual join payload (mode = individual / family /
# new_family / legacy None) plus the read-only /trips/join/preview endpoint.
import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


class TestJoin:
    """POST /api/trips/join and /api/trips/join/preview"""

    # ---------- helpers ----------
    def _register(self, api_client, name="Joiner"):
        email = f"test_join_{uuid.uuid4().hex[:10]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email, "password": "test12345", "pin": "4321", "name": name,
        })
        if resp.status_code != 200:
            pytest.skip(f"register failed: {resp.status_code} {resp.text}")
        data = resp.json()
        return {"email": email, "name": name,
                "token": data["access_token"], "id": data["user"]["id"]}

    def _create_trip(self, api_client, token, name="TEST_Join Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name, "start_date": "2026-01-10", "end_date": "2026-01-15", "currency": "INR",
        }, headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _add_member(self, api_client, token, trip_id, name, kind="family",
                    family_members=None, email=None, family_member_emails=None):
        body = {"name": name, "kind": kind, "family_members": family_members or []}
        if email is not None:
            body["email"] = email
        if family_member_emails is not None:
            body["family_member_emails"] = family_member_emails
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json=body,
                               headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _join(self, api_client, token, payload):
        return api_client.post(f"{BASE_URL}/api/trips/join", json=payload, headers=_auth(token))

    def _preview(self, api_client, token, code):
        return api_client.post(f"{BASE_URL}/api/trips/join/preview", json={"code": code},
                               headers=_auth(token))

    # ===================== PREVIEW =====================
    def test_preview_invalid_code_404(self, api_client, test_user):
        resp = self._preview(api_client, test_user["token"], "INVALID")
        assert resp.status_code == 404

    def test_preview_lists_families(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        self._add_member(api_client, test_user["token"], trip["id"],
                         "TEST_Fam Alpha", family_members=["Alice", "Bob"])
        joiner = self._register(api_client)
        resp = self._preview(api_client, joiner["token"], trip["code"])
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["already_member"] is False
        assert data["trip"]["member_count"] == 2  # owner + family
        assert data["trip"]["id"] == trip["id"]
        fam = next(f for f in data["families"] if f["name"] == "TEST_Fam Alpha")
        assert fam["size"] == 2
        assert fam["linked"] is False

    def test_preview_matched_family_member_by_email(self, api_client, test_user):
        # Phase 26: a family carries no entity email; a joiner whose Gmail matches a MEMBER's email
        # gets a per-member (claim-only) match. The legacy family-only `matched_family` stays null.
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        fam = self._add_member(api_client, test_user["token"], trip["id"],
                               "TEST_Fam Email", family_members=["Kid"],
                               family_member_emails=[joiner["email"]])
        resp = self._preview(api_client, joiner["token"], trip["code"])
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["matched_family"] is None
        m = data["match"]
        assert m is not None
        assert m["member_type"] == "family_member"
        assert m["member_id"] == fam["id"]
        assert m["family_id"] == fam["id"]
        assert m["family_member_id"] == fam["family_member_ids"][0]

    def test_preview_no_match_returns_null(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        self._add_member(api_client, test_user["token"], trip["id"],
                         "TEST_Fam NoMatch", family_members=["X"])
        joiner = self._register(api_client)
        resp = self._preview(api_client, joiner["token"], trip["code"])
        assert resp.status_code == 200, resp.text
        assert resp.json()["matched_family"] is None

    def test_preview_already_member_true(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        resp = self._preview(api_client, test_user["token"], trip["code"])
        assert resp.status_code == 200, resp.text
        assert resp.json()["already_member"] is True

    def test_preview_linked_flag(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        open_fam = self._add_member(api_client, test_user["token"], trip["id"],
                                    "TEST_Fam Open", family_members=["O"])
        joiner = self._register(api_client)
        claimed_fam = self._add_member(api_client, test_user["token"], trip["id"],
                                       "TEST_Fam Claimed", family_members=["C"],
                                       email=joiner["email"])
        # joiner claims the second family
        assert self._join(api_client, joiner["token"],
                          {"code": trip["code"], "mode": "family",
                           "family_id": claimed_fam["id"]}).status_code == 200
        # a third user previews and sees the linked flags
        observer = self._register(api_client)
        data = self._preview(api_client, observer["token"], trip["code"]).json()
        by_id = {f["id"]: f for f in data["families"]}
        assert by_id[open_fam["id"]]["linked"] is False
        assert by_id[claimed_fam["id"]]["linked"] is True

    # ===================== JOIN: individual =====================
    def test_join_individual_adds_member(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client, name="Solo Traveler")
        resp = self._join(api_client, joiner["token"], {"code": trip["code"], "mode": "individual"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert joiner["id"] in data["user_ids"]
        me = next(m for m in data["members"] if m.get("user_id") == joiner["id"])
        assert me["kind"] == "individual"
        assert me["name"] == "Solo Traveler"

    def test_join_individual_blocked_when_own_stub_exists(self, api_client, test_user):
        # Phase 11: the one-email invariant is enforced on every path. An explicit
        # mode=individual that would create a SECOND member with the joiner's own email is
        # rejected (409) and steered to claim / join-as-new — it no longer silently
        # produces a duplicate (the previous test_join_individual_does_not_autolink behavior).
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client, name="Independent")
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Solo Tempting", kind="individual", email=joiner["email"])
        resp = self._join(api_client, joiner["token"], {"code": trip["code"], "mode": "individual"})
        assert resp.status_code == 409, resp.text
        # Nothing changed: the stub is untouched and the joiner was not added.
        trip_now = api_client.get(f"{BASE_URL}/api/trips/{trip['id']}",
                                  headers=_auth(test_user["token"])).json()
        target = next(m for m in trip_now["members"] if m["id"] == stub["id"])
        assert target.get("user_id") is None
        assert joiner["id"] not in trip_now["user_ids"]
        # The joiner can then explicitly join as a new individual, which removes the clean stub.
        retry = self._join(api_client, joiner["token"],
                           {"code": trip["code"], "mode": "individual", "action": "join_new"})
        assert retry.status_code == 200, retry.text
        data = retry.json()
        me = next(m for m in data["members"] if m.get("user_id") == joiner["id"])
        assert me["kind"] == "individual"
        # exactly one member now carries the joiner's email (no duplicate)
        with_email = [m for m in data["members"]
                      if (m.get("email") or "").lower() == joiner["email"].lower()]
        assert len(with_email) == 1
        assert stub["id"] not in {m["id"] for m in data["members"]}

    def test_join_individual_duplicate_name_allowed(self, api_client, test_user):
        # Duplicate names are accepted; the joiner keeps their plain name (no stored mutation).
        # The two members share a name but have distinct ids — disambiguation is display-only.
        trip = self._create_trip(api_client, test_user["token"])
        owner_name = trip["members"][0]["name"]
        joiner = self._register(api_client, name=owner_name)  # collide with owner
        resp = self._join(api_client, joiner["token"], {"code": trip["code"], "mode": "individual"})
        assert resp.status_code == 200, resp.text
        members = resp.json()["members"]
        names = [m["name"] for m in members]
        assert names.count(owner_name) == 2  # both stored plain, identical
        me = next(m for m in members if m.get("user_id") == joiner["id"])
        assert me["name"] == owner_name

    # ===================== JOIN: new_family =====================
    def test_join_new_family_creates_family(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "mode": "new_family",
            "family_name": "TEST_The Smiths", "family_members": ["Pat", "Sam"],
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert joiner["id"] in data["user_ids"]
        # owner + new family only — no extra standalone individual
        assert len(data["members"]) == 2
        fam = next(m for m in data["members"] if m.get("user_id") == joiner["id"])
        assert fam["kind"] == "family"
        assert fam["name"] == "TEST_The Smiths"
        assert fam["family_members"] == ["Pat", "Sam"]

    def test_join_new_family_duplicate_name_allowed(self, api_client, test_user):
        # Duplicate family names are now accepted (disambiguated at display time); only linked-email
        # uniqueness is still enforced in the new_family path.
        trip = self._create_trip(api_client, test_user["token"])
        self._add_member(api_client, test_user["token"], trip["id"],
                         "TEST_Clan", family_members=["Z"])
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "mode": "new_family", "family_name": "TEST_Clan",
        })
        assert resp.status_code == 200, resp.text
        clans = [m for m in resp.json()["members"] if m["name"] == "TEST_Clan"]
        assert len(clans) == 2

    def test_join_new_family_missing_name_400(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {"code": trip["code"], "mode": "new_family"})
        assert resp.status_code == 400, resp.text

    # ===================== JOIN: family link =====================
    def test_join_family_link_open_slot(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        fam = self._add_member(api_client, test_user["token"], trip["id"],
                               "TEST_Linkers", family_members=["L1"], email=joiner["email"])
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "mode": "family", "family_id": fam["id"],
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert joiner["id"] in data["user_ids"]
        assert len(data["members"]) == 2  # owner + family, no new member
        linked = next(m for m in data["members"] if m["id"] == fam["id"])
        assert linked["user_id"] == joiner["id"]

    def test_join_family_link_stamps_empty_email(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        fam = self._add_member(api_client, test_user["token"], trip["id"],
                               "TEST_NoEmail Fam", family_members=["N1"])  # no email
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "mode": "family", "family_id": fam["id"],
        })
        assert resp.status_code == 200, resp.text
        linked = next(m for m in resp.json()["members"] if m["id"] == fam["id"])
        assert linked["user_id"] == joiner["id"]
        assert (linked.get("email") or "").lower() == joiner["email"].lower()

    def test_join_family_link_conflict_400(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        first = self._register(api_client)
        fam = self._add_member(api_client, test_user["token"], trip["id"],
                               "TEST_Claimed Fam", family_members=["C1"], email=first["email"])
        assert self._join(api_client, first["token"], {
            "code": trip["code"], "mode": "family", "family_id": fam["id"],
        }).status_code == 200
        # a different account cannot claim the now-occupied slot
        second = self._register(api_client)
        resp = self._join(api_client, second["token"], {
            "code": trip["code"], "mode": "family", "family_id": fam["id"],
        })
        assert resp.status_code == 400, resp.text

    def test_join_family_missing_family_id_400(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {"code": trip["code"], "mode": "family"})
        assert resp.status_code == 400, resp.text

    def test_join_family_unknown_id_404(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "mode": "family", "family_id": f"missing-{uuid.uuid4().hex}",
        })
        assert resp.status_code == 404, resp.text

    def test_join_family_target_is_individual_400(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        solo = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Solo Member", kind="individual")
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "mode": "family", "family_id": solo["id"],
        })
        assert resp.status_code == 400, resp.text

    # ===================== LEGACY / GENERAL =====================
    def test_join_legacy_autolinks_own_stub(self, api_client, test_user):
        # A legacy join (no mode) auto-claims the caller's own-email stub (Phase 26: entity emails
        # live on individuals; family sub-member linking goes through the explicit claim flow).
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Legacy Solo", kind="individual", email=joiner["email"])
        resp = self._join(api_client, joiner["token"], {"code": trip["code"]})  # no mode
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert len(data["members"]) == 2  # linked, no new member
        linked = next(m for m in data["members"] if m["id"] == stub["id"])
        assert linked["user_id"] == joiner["id"]

    def test_join_legacy_adds_individual(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client, name="Legacy Solo")
        resp = self._join(api_client, joiner["token"], {"code": trip["code"]})  # no mode
        assert resp.status_code == 200, resp.text
        data = resp.json()
        me = next(m for m in data["members"] if m.get("user_id") == joiner["id"])
        assert me["kind"] == "individual"

    def test_join_invalid_code_404(self, api_client, test_user):
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {"code": "INVALID", "mode": "individual"})
        assert resp.status_code == 404

    def test_join_idempotent_rejoin(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client, name="Repeat Joiner")
        first = self._join(api_client, joiner["token"], {"code": trip["code"], "mode": "individual"})
        assert first.status_code == 200, first.text
        count_after_first = len(first.json()["members"])
        # re-join with a DIFFERENT mode must be a no-op
        second = self._join(api_client, joiner["token"], {
            "code": trip["code"], "mode": "new_family", "family_name": "TEST_Should Not Create",
        })
        assert second.status_code == 200, second.text
        data = second.json()
        assert len(data["members"]) == count_after_first
        assert data["user_ids"].count(joiner["id"]) == 1

    def test_join_lowercase_code_normalized(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client, name="Lower Case")
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"].lower(), "mode": "individual",
        })
        assert resp.status_code == 200, resp.text
        assert joiner["id"] in resp.json()["user_ids"]

    def test_join_invalid_mode_422(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {"code": trip["code"], "mode": "bogus"})
        assert resp.status_code == 422

    # ===================== REALLOCATION SAFETY =====================
    def test_join_does_not_realloc_past_expenses(self, api_client, test_user):
        """A new joiner must not be retroactively folded into existing expenses."""
        trip = self._create_trip(api_client, test_user["token"])
        owner_member_id = trip["members"][0]["id"]
        exp_resp = api_client.post(f"{BASE_URL}/api/trips/{trip['id']}/expenses", json={
            "kind": "expense", "amount": 100.0, "category": "Food",
            "description": "TEST_Pre-join dinner", "date": "20-10-26",
            "paid_by_member_id": owner_member_id,
            "split_member_ids": [owner_member_id], "split_mode": "PER_CAPITA",
        }, headers=_auth(test_user["token"]))
        assert exp_resp.status_code == 200, exp_resp.text
        expense = exp_resp.json()["expense"]

        joiner = self._register(api_client)
        join_resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "mode": "new_family", "family_name": "TEST_Latecomers",
        })
        assert join_resp.status_code == 200, join_resp.text
        new_member_id = next(m["id"] for m in join_resp.json()["members"]
                             if m.get("user_id") == joiner["id"])

        listed = api_client.get(f"{BASE_URL}/api/trips/{trip['id']}/expenses",
                                headers=_auth(test_user["token"]))
        assert listed.status_code == 200, listed.text
        stored = next(e for e in listed.json() if e["id"] == expense["id"])
        assert stored["split_member_ids"] == [owner_member_id]
        assert new_member_id not in stored["split_member_ids"]
