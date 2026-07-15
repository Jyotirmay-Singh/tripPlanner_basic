# Phase 24 — Pure unit tests for the per-member (contact-only) email helpers.
# No HTTP, no server, no conftest fixtures — operates only on plain dicts/lists.
import pytest
from fastapi import HTTPException

from utils.members import (
    align_family_member_emails,
    align_family_member_user_ids,
    email_exists,
    assert_unique_family_member_emails,
    find_own_sub_stub,
)


class TestAlignFamilyMemberEmails:
    def test_client_sent_normalized_and_padded(self):
        # Trusted per row; normalized (lower/trim); short list padded with None to len(names).
        out = align_family_member_emails(
            ["A", "B", "C"], provided=[" Alice@Gmail.com ", "", None]
        )
        assert out == ["alice@gmail.com", None, None]

    def test_provided_longer_than_names_truncated(self):
        out = align_family_member_emails(["A"], provided=["a@gmail.com", "b@gmail.com"])
        assert out == ["a@gmail.com"]

    def test_none_provided_reuses_existing_positionally(self):
        # Name/id-only edit (provided is None) preserves existing emails, aligned to names.
        out = align_family_member_emails(
            ["A", "B"], provided=None, existing=["a@gmail.com", "b@gmail.com"]
        )
        assert out == ["a@gmail.com", "b@gmail.com"]

    def test_none_provided_no_existing_all_none(self):
        assert align_family_member_emails(["A", "B"]) == [None, None]

    def test_empty_names(self):
        assert align_family_member_emails([], provided=["a@gmail.com"]) == []
        assert align_family_member_emails(None) == []

    def test_explicit_empty_list_clears(self):
        # An explicit [] (client_sent) does NOT fall back to existing — it clears to all-None.
        out = align_family_member_emails(["A"], provided=[], existing=["a@gmail.com"])
        assert out == [None]


class TestEmailExists:
    def test_entity_only_behavior_unchanged(self):
        members = [{"id": "m1", "email": "a@gmail.com"}]
        assert email_exists(members, "A@GMAIL.COM") is True
        assert email_exists(members, "b@gmail.com") is False
        assert email_exists(members, None) is False

    def test_exclude_id_skips_whole_entity(self):
        members = [{"id": "m1", "email": "a@gmail.com"}]
        assert email_exists(members, "a@gmail.com", exclude_id="m1") is False

    def test_finds_sub_member_email(self):
        members = [
            {"id": "f1", "kind": "family", "email": None,
             "family_members": ["Bob"], "family_member_emails": ["bob@gmail.com"]},
        ]
        assert email_exists(members, "BOB@gmail.com") is True

    def test_sub_member_email_respects_exclude_id(self):
        members = [
            {"id": "f1", "kind": "family",
             "family_member_emails": ["bob@gmail.com"]},
        ]
        assert email_exists(members, "bob@gmail.com", exclude_id="f1") is False

    def test_sub_vs_other_family_entity(self):
        members = [
            {"id": "f1", "email": "fam@gmail.com"},
            {"id": "f2", "kind": "family", "family_member_emails": ["fam@gmail.com"]},
        ]
        # A sub-email colliding with another family's ENTITY email is caught (symmetric).
        assert email_exists(members, "fam@gmail.com", exclude_id="f2") is True

    def test_legacy_family_without_emails(self):
        members = [{"id": "f1", "kind": "family", "family_members": ["Bob"]}]  # no emails key
        assert email_exists(members, "bob@gmail.com") is False


class TestAssertUniqueFamilyMemberEmails:
    def test_internal_duplicate_rejected(self):
        with pytest.raises(HTTPException) as ei:
            assert_unique_family_member_emails(["a@gmail.com", "A@Gmail.com"])
        assert ei.value.status_code == 400

    def test_blanks_ignored(self):
        # Multiple None/blank entries are fine (unset members).
        assert_unique_family_member_emails([None, "", "a@gmail.com", None]) is None

    def test_all_distinct_ok(self):
        assert_unique_family_member_emails(["a@gmail.com", "b@gmail.com"]) is None

    def test_empty_ok(self):
        assert_unique_family_member_emails(None) is None
        assert_unique_family_member_emails([]) is None


# ------------------------- Phase 25: per-member account linking -------------------------

class TestAlignFamilyMemberUserIds:
    """Server-managed per-member linked user-ids carry forward by stable id across roster edits."""

    def test_missing_all_none(self):
        aligned, vanished = align_family_member_user_ids(["a", "b"], None, None)
        assert aligned == [None, None]
        assert vanished == set()

    def test_carries_forward_by_id(self):
        # Old roster [a,b,c] with b linked to u2; edit keeps [a,b,c] -> u2 stays on b.
        aligned, vanished = align_family_member_user_ids(
            ["a", "b", "c"], ["a", "b", "c"], [None, "u2", None]
        )
        assert aligned == [None, "u2", None]
        assert vanished == set()

    def test_reorder_keeps_link_with_id(self):
        aligned, vanished = align_family_member_user_ids(
            ["c", "a", "b"], ["a", "b", "c"], [None, "u2", "u3"]
        )
        assert aligned == ["u3", None, "u2"]
        assert vanished == set()

    def test_new_row_is_unclaimed(self):
        aligned, vanished = align_family_member_user_ids(
            ["a", "b", "new"], ["a", "b"], ["u1", "u2"]
        )
        assert aligned == ["u1", "u2", None]
        assert vanished == set()

    def test_dropped_member_uid_vanishes(self):
        # b (linked to u2) removed -> u2 must be reported vanished so the caller revokes access.
        aligned, vanished = align_family_member_user_ids(
            ["a", "c"], ["a", "b", "c"], ["u1", "u2", "u3"]
        )
        assert aligned == ["u1", "u3"]
        assert vanished == {"u2"}


class TestFindOwnSubStub:
    def _family(self, **over):
        base = {
            "id": "F", "name": "Sharma", "kind": "family",
            "family_members": ["Arjun", "Priya", "Rohan"],
            "family_member_ids": ["a1", "a2", "a3"],
            "family_member_emails": ["arjun@gmail.com", "priya@gmail.com", None],
            "family_member_user_ids": [None, None, None],
        }
        base.update(over)
        return base

    def test_matches_own_unclaimed_sub(self):
        m = find_own_sub_stub([self._family()], "Priya@Gmail.com")
        assert m == {
            "family_id": "F", "family_name": "Sharma",
            "member_id": "a2", "member_index": 1, "member_name": "Priya",
        }

    def test_no_match_when_email_absent(self):
        assert find_own_sub_stub([self._family()], "nobody@gmail.com") is None

    def test_skips_already_claimed_slot(self):
        fam = self._family(family_member_user_ids=[None, "u2", None])
        assert find_own_sub_stub([fam], "priya@gmail.com") is None

    def test_ignores_individuals_and_entity_email(self):
        indiv = {"id": "I", "kind": "individual", "email": "solo@gmail.com", "family_members": []}
        fam = self._family(email="fam@gmail.com")
        assert find_own_sub_stub([indiv, fam], "solo@gmail.com") is None
        assert find_own_sub_stub([indiv, fam], "fam@gmail.com") is None

    def test_legacy_family_without_arrays(self):
        legacy = {
            "id": "L", "name": "Old", "kind": "family",
            "family_members": ["X", "Y"],
        }
        assert find_own_sub_stub([legacy], "x@gmail.com") is None

    def test_blank_email_returns_none(self):
        assert find_own_sub_stub([self._family()], "") is None
        assert find_own_sub_stub([self._family()], None) is None
