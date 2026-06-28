# Phase 11, Step 43 — Pure unit tests for the identity-reconciliation helpers.
# No HTTP, no server, no conftest fixtures — operates only on plain dicts/lists.
from utils.members import (
    find_own_stubs,
    member_has_financial_history_in,
    is_stub_removable,
)


def _stub(mid, email, *, kind="individual", user_id=None):
    return {"id": mid, "name": mid, "kind": kind, "email": email, "user_id": user_id}


class TestFindOwnStubs:
    def test_single_individual_stub(self):
        members = [_stub("m1", "a@gmail.com")]
        assert find_own_stubs(members, "a@gmail.com") == members

    def test_single_family_stub(self):
        members = [_stub("f1", "a@gmail.com", kind="family")]
        out = find_own_stubs(members, "a@gmail.com")
        assert len(out) == 1 and out[0]["id"] == "f1"

    def test_claimed_member_excluded(self):
        members = [_stub("m1", "a@gmail.com", user_id="u1")]
        assert find_own_stubs(members, "a@gmail.com") == []

    def test_email_mismatch_excluded(self):
        members = [_stub("m1", "a@gmail.com")]
        assert find_own_stubs(members, "b@gmail.com") == []

    def test_case_insensitive_match(self):
        members = [_stub("m1", "Alice@Gmail.com")]
        assert len(find_own_stubs(members, "alice@gmail.com")) == 1

    def test_blank_caller_email_returns_empty(self):
        members = [_stub("m1", "a@gmail.com")]
        assert find_own_stubs(members, None) == []
        assert find_own_stubs(members, "") == []

    def test_member_without_email_ignored(self):
        members = [_stub("m1", None)]
        assert find_own_stubs(members, "a@gmail.com") == []

    def test_legacy_duplicate_emails_returns_multiple(self):
        members = [_stub("m1", "a@gmail.com"), _stub("m2", "a@gmail.com", kind="family")]
        assert len(find_own_stubs(members, "a@gmail.com")) == 2


class TestMemberHasFinancialHistoryIn:
    def test_paid_by_hit(self):
        exp = [{"paid_by_member_id": "m1", "split_member_ids": []}]
        assert member_has_financial_history_in("m1", exp, []) is True

    def test_split_member_hit(self):
        exp = [{"paid_by_member_id": "x", "split_member_ids": ["a", "m1"]}]
        assert member_has_financial_history_in("m1", exp, []) is True

    def test_family_participants_key_hit(self):
        exp = [{"paid_by_member_id": "x", "split_member_ids": [],
                "family_participants": {"m1": ["fm1"]}}]
        assert member_has_financial_history_in("m1", exp, []) is True

    def test_weight_snapshots_key_hit(self):
        exp = [{"paid_by_member_id": "x", "split_member_ids": [],
                "weight_snapshots": {"m1": 2}}]
        assert member_has_financial_history_in("m1", exp, []) is True

    def test_settlement_from_hit(self):
        setts = [{"from_member_id": "m1", "to_member_id": "x"}]
        assert member_has_financial_history_in("m1", [], setts) is True

    def test_settlement_to_hit_any_status(self):
        setts = [{"from_member_id": "x", "to_member_id": "m1", "status": "pending"}]
        assert member_has_financial_history_in("m1", [], setts) is True

    def test_no_reference_is_false(self):
        exp = [{"paid_by_member_id": "x", "split_member_ids": ["y"]}]
        setts = [{"from_member_id": "y", "to_member_id": "z"}]
        assert member_has_financial_history_in("m1", exp, setts) is False

    def test_empty_inputs_false(self):
        assert member_has_financial_history_in("m1", [], []) is False


class TestIsStubRemovable:
    def test_clean_own_email_no_history_removable(self):
        assert is_stub_removable(_stub("m1", "a@gmail.com"), "a@gmail.com", False) is True

    def test_has_history_blocks(self):
        assert is_stub_removable(_stub("m1", "a@gmail.com"), "a@gmail.com", True) is False

    def test_claimed_blocks(self):
        assert is_stub_removable(_stub("m1", "a@gmail.com", user_id="u1"), "a@gmail.com", False) is False

    def test_email_mismatch_blocks(self):
        assert is_stub_removable(_stub("m1", "a@gmail.com"), "b@gmail.com", False) is False

    def test_case_insensitive_email_removable(self):
        assert is_stub_removable(_stub("m1", "Alice@Gmail.com"), "alice@gmail.com", False) is True
