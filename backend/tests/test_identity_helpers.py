# Phase 11, Step 43 — Pure unit tests for the identity-reconciliation helpers.
# No HTTP, no server, no conftest fixtures — operates only on plain dicts/lists.
from utils.members import (
    family_member_has_financial_history_in,
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

    def test_family_entity_never_matched(self):
        # Phase 27: an email identifies a PERSON, never a family — a family entity carries no email,
        # so find_own_stubs (individuals only) never returns it. Family sub-members are matched by
        # find_own_sub_stub instead.
        members = [_stub("f1", "a@gmail.com", kind="family")]
        assert find_own_stubs(members, "a@gmail.com") == []

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

    def test_legacy_duplicate_emails_returns_only_individuals(self):
        # Phase 27: only INDIVIDUAL members carry an entity email, so a duplicate-email family entity
        # (legacy data) is ignored; two individual stubs still both surface.
        mixed = [_stub("m1", "a@gmail.com"), _stub("m2", "a@gmail.com", kind="family")]
        out = find_own_stubs(mixed, "a@gmail.com")
        assert [m["id"] for m in out] == ["m1"]
        both = [_stub("m1", "a@gmail.com"), _stub("m3", "a@gmail.com")]
        assert len(find_own_stubs(both, "a@gmail.com")) == 2


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

    def test_recorded_payment_hit(self):
        payments = [{"from_member_id": "m1", "to_member_id": "x"}]
        assert member_has_financial_history_in("m1", [], [], payments) is True

    def test_no_reference_is_false(self):
        exp = [{"paid_by_member_id": "x", "split_member_ids": ["y"]}]
        setts = [{"from_member_id": "y", "to_member_id": "z"}]
        assert member_has_financial_history_in("m1", exp, setts) is False

    def test_empty_inputs_false(self):
        assert member_has_financial_history_in("m1", [], []) is False


class TestFamilyMemberHasFinancialHistoryIn:
    family = {
        "id": "family-1",
        "kind": "family",
        "family_members": ["A", "B"],
        "family_member_ids": ["slot-a", "slot-b"],
    }

    def test_per_capita_participant_has_history(self):
        expense = [{
            "paid_by_member_id": "x",
            "split_member_ids": ["family-1"],
            "split_mode": "PER_CAPITA",
            "family_participants": {"family-1": ["slot-b"]},
        }]
        assert family_member_has_financial_history_in(
            self.family, "slot-b", expense, [], [],
        ) is True
        assert family_member_has_financial_history_in(
            self.family, "slot-a", expense, [], [],
        ) is False

    def test_exact_amount_is_attributed_to_only_that_person(self):
        expense = [{
            "paid_by_member_id": "x",
            "split_member_ids": ["family-1"],
            "split_mode": "EXACT",
            "custom_amounts": {"slot-a": 0, "slot-b": 12.5},
        }]
        assert family_member_has_financial_history_in(
            self.family, "slot-b", expense, [], [],
        ) is True
        assert family_member_has_financial_history_in(
            self.family, "slot-a", expense, [], [],
        ) is False

    def test_family_payment_conservatively_protects_every_person(self):
        payments = [{"from_member_id": "family-1", "to_member_id": "x"}]
        assert family_member_has_financial_history_in(
            self.family, "slot-a", [], [], payments,
        ) is True

    def test_unattributed_person_is_clean(self):
        assert family_member_has_financial_history_in(
            self.family, "slot-a", [], [], [],
        ) is False


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
