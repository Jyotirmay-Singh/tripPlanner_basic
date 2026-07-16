# Phase 11 — Identity reconciliation (one gmail == at most one person per trip).
# Live-server integration tests (requests/BASE_URL style, like test_join.py). Cover the
# preview `match` extension (Step 44), claim/join_new actions + every-path enforcement
# (Step 45), and creation-time uniqueness hardening (Step 46).
import os
import uuid

import pytest

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8000').rstrip('/')


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


class _Base:
    def _register(self, api_client, name="Joiner"):
        email = f"test_recon_{uuid.uuid4().hex[:10]}@gmail.com"
        resp = api_client.post(f"{BASE_URL}/api/auth/register", json={
            "email": email, "password": "test12345", "pin": "4321", "name": name,
        })
        if resp.status_code != 200:
            pytest.skip(f"register failed: {resp.status_code} {resp.text}")
        d = resp.json()
        return {"email": email, "name": name, "token": d["access_token"], "id": d["user"]["id"]}

    def _create_trip(self, api_client, token, name="TEST_Recon Trip"):
        resp = api_client.post(f"{BASE_URL}/api/trips", json={
            "name": name, "start_date": "2026-01-10", "end_date": "2026-01-15", "currency": "INR",
        }, headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _add_member(self, api_client, token, trip_id, name, kind="individual",
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

    def _add_expense(self, api_client, token, trip_id, paid_by, split):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/expenses", json={
            "kind": "expense", "amount": 60.0, "category": "Food", "description": "TEST_recon",
            "date": "20-10-26", "paid_by_member_id": paid_by, "split_member_ids": split,
            "split_mode": "PER_CAPITA",
        }, headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()["expense"]

    def _add_settlement(self, api_client, token, trip_id, frm, to, amount=10.0):
        resp = api_client.post(f"{BASE_URL}/api/trips/{trip_id}/settlements", json={
            "from_member_id": frm, "to_member_id": to, "amount": amount,
        }, headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _preview(self, api_client, token, code):
        return api_client.post(f"{BASE_URL}/api/trips/join/preview", json={"code": code},
                               headers=_auth(token))

    def _join(self, api_client, token, payload):
        return api_client.post(f"{BASE_URL}/api/trips/join", json=payload, headers=_auth(token))

    def _get_trip(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}", headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()

    def _balances(self, api_client, token, trip_id):
        resp = api_client.get(f"{BASE_URL}/api/trips/{trip_id}/balances", headers=_auth(token))
        assert resp.status_code == 200, resp.text
        return resp.json()


# ============================ Step 44 — PREVIEW match ============================
class TestPreviewMatch(_Base):
    def test_match_individual_stub(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Stub Solo", kind="individual", email=joiner["email"])
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        assert data["match"] is not None
        m = data["match"]
        assert m["member_id"] == stub["id"]
        assert m["member_type"] == "individual"
        assert m["family_id"] is None
        assert m["has_financial_history"] is False
        # individual stub does NOT populate the legacy family-only field
        assert data["matched_family"] is None

    def test_match_family_member_stub(self, api_client, test_user):
        # Phase 26: a family carries no entity email; the joiner's Gmail matches a MEMBER's email, so
        # preview surfaces a per-member (claim-only) match. The legacy `matched_family` stays null.
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        fam = self._add_member(api_client, test_user["token"], trip["id"],
                               "TEST_Stub Fam", kind="family", family_members=["Kid"],
                               family_member_emails=[joiner["email"]])
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        m = data["match"]
        assert m["member_type"] == "family_member"
        assert m["member_id"] == fam["id"]
        assert m["family_id"] == fam["id"]
        assert m["family_name"] == "TEST_Stub Fam"
        assert m["family_member_id"] == fam["family_member_ids"][0]
        assert data["matched_family"] is None

    def test_match_history_via_expense(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Hist Solo", kind="individual", email=joiner["email"])
        owner_id = trip["members"][0]["id"]
        self._add_expense(api_client, test_user["token"], trip["id"],
                          paid_by=stub["id"], split=[owner_id, stub["id"]])
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        assert data["match"]["has_financial_history"] is True

    def test_match_history_via_settlement(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Hist Sett", kind="individual", email=joiner["email"])
        owner_id = trip["members"][0]["id"]
        # a PENDING settlement still counts as financial history
        self._add_settlement(api_client, test_user["token"], trip["id"],
                             frm=stub["id"], to=owner_id, amount=5.0)
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        assert data["match"]["has_financial_history"] is True

    def test_no_match_returns_null(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        data = self._preview(api_client, joiner["token"], trip["code"]).json()
        assert data["match"] is None
        assert data.get("match_conflicts") in (None, [])


def _financials(bal):
    """The money-bearing slice of a balances response (excludes member docs whose user_id
    flips on claim — claiming must not change any of these)."""
    return {"net": bal["net"], "transfers": bal["transfers"], "per_person": bal["per_person"]}


# ============================ Step 45 — CLAIM ============================
class TestClaim(_Base):
    def test_claim_individual_keeps_id(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Claim Solo", kind="individual", email=joiner["email"])
        before = len(self._get_trip(api_client, test_user["token"], trip["id"])["members"])
        resp = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "claim", "member_id": stub["id"]})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        claimed = next(m for m in data["members"] if m["id"] == stub["id"])
        assert claimed["user_id"] == joiner["id"]  # id unchanged, now linked
        assert joiner["id"] in data["user_ids"]
        assert len(data["members"]) == before  # no new member created

    def test_claim_family_member_size_and_balances_unchanged(self, api_client, test_user):
        # Phase 26: linking to a family goes through the per-member slot; the family's size and the
        # ledger stay byte-identical (the split engine never reads emails/user_ids).
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        owner_id = trip["members"][0]["id"]
        fam = self._add_member(api_client, test_user["token"], trip["id"],
                               "TEST_Claim Fam", kind="family",
                               family_members=["A", "B", "C"],
                               family_member_emails=[joiner["email"], None, None])
        # give the family a real balance so "no recalc" is meaningful
        self._add_expense(api_client, test_user["token"], trip["id"],
                          paid_by=owner_id, split=[owner_id, fam["id"]])
        before_bal = _financials(self._balances(api_client, test_user["token"], trip["id"]))
        resp = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "claim", "member_id": fam["id"],
                           "family_member_id": fam["family_member_ids"][0]})
        assert resp.status_code == 200, resp.text
        claimed = next(m for m in resp.json()["members"] if m["id"] == fam["id"])
        assert claimed["family_member_user_ids"][0] == joiner["id"]  # the member slot is linked
        assert claimed.get("user_id") in (None, "")  # entity itself never claimed
        assert claimed["family_members"] == ["A", "B", "C"]  # size unchanged
        after_bal = _financials(self._balances(api_client, test_user["token"], trip["id"]))
        assert after_bal == before_bal  # no retroactive recalculation

    def test_claim_history_stub_allowed(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        owner_id = trip["members"][0]["id"]
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Claim Hist", kind="individual", email=joiner["email"])
        exp = self._add_expense(api_client, test_user["token"], trip["id"],
                                paid_by=owner_id, split=[owner_id, stub["id"]])
        resp = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "claim", "member_id": stub["id"]})
        assert resp.status_code == 200, resp.text
        # the expense reference is preserved (id unchanged)
        listed = api_client.get(f"{BASE_URL}/api/trips/{trip['id']}/expenses",
                                headers=_auth(test_user["token"])).json()
        stored = next(e for e in listed if e["id"] == exp["id"])
        assert stub["id"] in stored["split_member_ids"]

    def test_claim_idempotent(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_Claim Idem", kind="individual", email=joiner["email"])
        first = self._join(api_client, joiner["token"],
                           {"code": trip["code"], "action": "claim", "member_id": stub["id"]})
        assert first.status_code == 200, first.text
        second = self._join(api_client, joiner["token"],
                            {"code": trip["code"], "action": "claim", "member_id": stub["id"]})
        assert second.status_code == 200, second.text
        assert second.json()["user_ids"].count(joiner["id"]) == 1

    def test_claim_other_persons_stub_403(self, api_client, test_user):
        # A joiner may only claim the stub carrying their OWN email.
        trip = self._create_trip(api_client, test_user["token"])
        other = self._register(api_client, name="Other")
        joiner = self._register(api_client, name="Me")
        others_stub = self._add_member(api_client, test_user["token"], trip["id"],
                                       "TEST_Not Mine", kind="individual", email=other["email"])
        resp = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "claim", "member_id": others_stub["id"]})
        assert resp.status_code == 403, resp.text

    def test_claim_unknown_member_404(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "claim",
                           "member_id": f"missing-{uuid.uuid4().hex}"})
        assert resp.status_code == 404, resp.text

    def test_claim_missing_member_id_400(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        resp = self._join(api_client, joiner["token"], {"code": trip["code"], "action": "claim"})
        assert resp.status_code == 400, resp.text


# ============================ Step 45 — JOIN_NEW ============================
class TestJoinNew(_Base):
    def test_removes_clean_individual_stub(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_JN Solo", kind="individual", email=joiner["email"])
        resp = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "join_new", "mode": "individual"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert stub["id"] not in {m["id"] for m in data["members"]}  # clean stub removed
        with_email = [m for m in data["members"]
                      if (m.get("email") or "").lower() == joiner["email"].lower()]
        assert len(with_email) == 1  # exactly one identity, no duplicate

    def test_new_family_removes_clean_stub(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_JN NF", kind="individual", email=joiner["email"])
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "action": "join_new", "mode": "new_family",
            "family_name": "TEST_JN The Group", "family_members": ["P", "Q"],
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert stub["id"] not in {m["id"] for m in data["members"]}
        fam = next(m for m in data["members"] if m.get("user_id") == joiner["id"])
        assert fam["kind"] == "family" and fam["family_members"] == ["P", "Q"]

    def test_existing_family_removes_clean_stub(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_JN EF", kind="individual", email=joiner["email"])
        openfam = self._add_member(api_client, test_user["token"], trip["id"],
                                   "TEST_JN OpenFam", kind="family", family_members=["Z"])
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "action": "join_new", "mode": "family",
            "family_id": openfam["id"],
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert stub["id"] not in {m["id"] for m in data["members"]}
        linked = next(m for m in data["members"] if m["id"] == openfam["id"])
        assert linked["user_id"] == joiner["id"]

    def test_history_stub_blocked_even_with_replace_hint(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        owner_id = trip["members"][0]["id"]
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_JN Hist", kind="individual", email=joiner["email"])
        self._add_expense(api_client, test_user["token"], trip["id"],
                          paid_by=owner_id, split=[owner_id, stub["id"]])
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "action": "join_new", "mode": "individual",
            "replace_member_id": stub["id"],
        })
        assert resp.status_code == 409, resp.text
        # the stub survives untouched
        members = self._get_trip(api_client, test_user["token"], trip["id"])["members"]
        assert stub["id"] in {m["id"] for m in members}

    def test_family_member_email_forces_claim(self, api_client, test_user):
        # Phase 26: a joiner whose Gmail sits on a family MEMBER's slot can't join as a new individual
        # (the one-email invariant blocks it) — they must claim that member instead.
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        owner_id = trip["members"][0]["id"]
        fam = self._add_member(api_client, test_user["token"], trip["id"],
                               "TEST_JN FamHist", kind="family", family_members=["A", "B"],
                               family_member_emails=[joiner["email"], None])
        self._add_expense(api_client, test_user["token"], trip["id"],
                          paid_by=owner_id, split=[owner_id, fam["id"]])
        resp = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "join_new", "mode": "individual"})
        assert resp.status_code == 400, resp.text

    def test_settlement_only_history_forces_claim(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        owner_id = trip["members"][0]["id"]
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_JN SettHist", kind="individual", email=joiner["email"])
        self._add_settlement(api_client, test_user["token"], trip["id"],
                             frm=stub["id"], to=owner_id, amount=7.0)
        resp = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "join_new", "mode": "individual"})
        assert resp.status_code == 409, resp.text

    def test_replace_non_own_stub_403(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        other = self._register(api_client, name="Other")
        joiner = self._register(api_client, name="Me")
        others_stub = self._add_member(api_client, test_user["token"], trip["id"],
                                       "TEST_JN NotMine", kind="individual", email=other["email"])
        resp = self._join(api_client, joiner["token"], {
            "code": trip["code"], "action": "join_new", "mode": "individual",
            "replace_member_id": others_stub["id"],
        })
        assert resp.status_code == 403, resp.text
        members = self._get_trip(api_client, test_user["token"], trip["id"])["members"]
        assert others_stub["id"] in {m["id"] for m in members}  # untouched

    def test_replace_hint_omitted_still_removes_clean_stub(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        stub = self._add_member(api_client, test_user["token"], trip["id"],
                                "TEST_JN NoHint", kind="individual", email=joiner["email"])
        resp = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "join_new", "mode": "individual"})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert stub["id"] not in {m["id"] for m in data["members"]}
        with_email = [m for m in data["members"]
                      if (m.get("email") or "").lower() == joiner["email"].lower()]
        assert len(with_email) == 1


# ==================== Step 46 — creation-time uniqueness ====================
class TestCreationUniqueness(_Base):
    def _add_member_raw(self, api_client, token, trip_id, name, kind="individual",
                        family_members=None, email=None):
        body = {"name": name, "kind": kind, "family_members": family_members or []}
        if email is not None:
            body["email"] = email
        return api_client.post(f"{BASE_URL}/api/trips/{trip_id}/members", json=body,
                               headers=_auth(token))

    def test_duplicate_individual_email_400(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        email = f"dup_{uuid.uuid4().hex[:8]}@gmail.com"
        self._add_member(api_client, test_user["token"], trip["id"], "TEST_A",
                         kind="individual", email=email)
        resp = self._add_member_raw(api_client, test_user["token"], trip["id"], "TEST_B",
                                    kind="individual", email=email)
        assert resp.status_code == 400, resp.text

    def test_individual_vs_family_member_email_400(self, api_client, test_user):
        # Phase 26: a family's emails live on its MEMBERS; a member email still occupies the
        # trip-wide one-email space, so an individual can't reuse it.
        trip = self._create_trip(api_client, test_user["token"])
        email = f"dup_{uuid.uuid4().hex[:8]}@gmail.com"
        self._add_member(api_client, test_user["token"], trip["id"], "TEST_Fam",
                         kind="family", family_members=["K"], family_member_emails=[email])
        resp = self._add_member_raw(api_client, test_user["token"], trip["id"], "TEST_Solo",
                                    kind="individual", email=email)
        assert resp.status_code == 400, resp.text

    def test_rejects_reuse_of_a_claimed_members_email(self, api_client, test_user):
        # The one-email invariant holds across a CLAIMED account: once a joiner has linked to a
        # family member via their Gmail (Phase 25 per-member claim), an admin can't create another
        # member reusing that email. (Phase 26: the family carries no entity email — the joiner's
        # email lives on the member slot, and the guard covers the whole family's uid set.)
        trip = self._create_trip(api_client, test_user["token"])
        joiner = self._register(api_client)
        fam = self._add_member(api_client, test_user["token"], trip["id"], "TEST_Ghost Fam",
                               kind="family", family_members=["G"],
                               family_member_emails=[joiner["email"]])
        link = self._join(api_client, joiner["token"],
                          {"code": trip["code"], "action": "claim", "member_id": fam["id"],
                           "family_member_id": fam["family_member_ids"][0]})
        assert link.status_code == 200, link.text
        # the claimed account's email cannot be reused for a new individual member
        resp = self._add_member_raw(api_client, test_user["token"], trip["id"], "TEST_Clash",
                                    kind="individual", email=joiner["email"])
        assert resp.status_code == 400, resp.text

    def test_update_member_duplicate_email_400_but_self_ok(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        email = f"dup_{uuid.uuid4().hex[:8]}@gmail.com"
        a = self._add_member(api_client, test_user["token"], trip["id"], "TEST_HasEmail",
                             kind="individual", email=email)
        b = self._add_member(api_client, test_user["token"], trip["id"], "TEST_NoEmail",
                             kind="individual")
        # B cannot take A's email
        clash = api_client.patch(f"{BASE_URL}/api/trips/{trip['id']}/members/{b['id']}",
                                 json={"email": email}, headers=_auth(test_user["token"]))
        assert clash.status_code == 400, clash.text
        # A can re-save its own email (self-exclusion)
        same = api_client.patch(f"{BASE_URL}/api/trips/{trip['id']}/members/{a['id']}",
                                json={"email": email}, headers=_auth(test_user["token"]))
        assert same.status_code == 200, same.text

    def test_non_gmail_rejected_before_uniqueness(self, api_client, test_user):
        trip = self._create_trip(api_client, test_user["token"])
        resp = self._add_member_raw(api_client, test_user["token"], trip["id"], "TEST_NonGmail",
                                    kind="individual", email="someone@yahoo.com")
        assert resp.status_code == 400, resp.text
