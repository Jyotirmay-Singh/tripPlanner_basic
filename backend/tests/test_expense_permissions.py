"""Expense modification follows the creator's current, trip-local family links."""
import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from utils import deps
from utils.permissions import can_modify_expense


@pytest.fixture
def family_trip():
    return {
        "id": "trip", "owner_id": "owner", "admin_ids": ["admin"],
        "user_ids": ["owner", "admin", "creator", "relative", "other-creator", "other-relative"],
        "members": [
            {"id": "family", "kind": "family", "user_id": None,
             "family_member_user_ids": ["creator", None, "relative"]},
            {"id": "other-family", "kind": "family",
             "family_member_user_ids": ["other-creator", "other-relative"]},
            {"id": "unlinked-family", "kind": "family", "family_member_user_ids": None},
        ],
    }


@pytest.mark.parametrize("viewer,allowed", [
    ("creator", True), ("relative", True), ({"id": "relative"}, True),
    ("owner", True), ("admin", True), ("other-creator", False),
    ("other-relative", False), ("outsider", False), (None, False), ("", False),
])
def test_creator_family_or_admin_can_modify(family_trip, viewer, allowed):
    # Payer and split membership must not confer the creator's authority.
    expense = {"created_by": "creator", "paid_by_member_id": "other-family",
               "split_member_ids": ["family", "other-family"]}
    assert can_modify_expense(family_trip, expense, viewer) is allowed


@pytest.mark.parametrize("creator", [None, "", "unknown"])
def test_unknown_creator_does_not_grant_family_access(family_trip, creator):
    expense = {"created_by": creator, "paid_by_member_id": "family"}
    assert not can_modify_expense(family_trip, expense, "relative")
    assert not can_modify_expense(family_trip, expense, None)
    assert can_modify_expense(family_trip, expense, "admin")
    assert can_modify_expense(family_trip, expense, "owner")


def test_family_access_uses_current_links_only(family_trip):
    expense = {"created_by": "creator"}
    assert can_modify_expense(family_trip, {"created_by": "relative"}, "creator")
    family_trip["members"][0]["family_member_user_ids"] = ["relative"]
    assert not can_modify_expense(family_trip, expense, "relative")
    family_trip["members"][0]["family_member_user_ids"] = ["creator"]
    assert not can_modify_expense(family_trip, expense, "relative")


@pytest.mark.parametrize("members", [None, [], [{"kind": "family"}],
    [{"kind": "individual", "family_member_user_ids": ["creator", "relative"]}]])
def test_missing_or_nonfamily_links_never_grant_access(family_trip, members):
    family_trip["members"] = members
    assert not can_modify_expense(family_trip, {"created_by": "creator"}, "relative")


@pytest.mark.parametrize("viewer,status", [
    ("relative", 200), ("creator", 200), ("admin", 200),
    ("other-relative", 403), ("outsider", 403),
])
def test_expense_guard_enforces_family_and_group_membership(monkeypatch, family_trip, viewer, status):
    expense = {"id": "expense", "trip_id": "trip", "created_by": "creator"}
    # A stale family link must not give a removed account access to the group.
    family_trip["members"][0]["family_member_user_ids"].append("outsider")
    database = SimpleNamespace(
        trips=SimpleNamespace(find_one=AsyncMock(return_value=deepcopy(family_trip))),
        expenses=SimpleNamespace(find_one=AsyncMock(return_value=expense)),
    )
    monkeypatch.setattr(deps, "db", database)
    if status == 403:
        with pytest.raises(HTTPException) as denied:
            asyncio.run(deps._expense_modify_or_403("trip", "expense", {"id": viewer}))
        assert denied.value.status_code == 403
    else:
        _, result = asyncio.run(deps._expense_modify_or_403("trip", "expense", {"id": viewer}))
        assert result == expense
        database.expenses.find_one.assert_awaited_once_with(
            {"id": "expense", "trip_id": "trip"}, {"_id": 0})
