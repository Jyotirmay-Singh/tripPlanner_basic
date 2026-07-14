# Phase 24 — Pure unit tests for the per-member (contact-only) email helpers.
# No HTTP, no server, no conftest fixtures — operates only on plain dicts/lists.
import pytest
from fastapi import HTTPException

from utils.members import (
    align_family_member_emails,
    email_exists,
    assert_unique_family_member_emails,
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
