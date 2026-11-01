"""Family expense edits across legacy routes and reviewed financial transactions."""
import asyncio

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from routes import expenses
from services import financial_corrections as corrections, receipt_versions
from services import settlement_intents as workflow
from services.settlement_engine import SCALE
from tests.test_coverage_journal_mongo import isolated
from tests.test_expense_coverage import share
from tests.test_financial_corrections_mongo import setup, preview, create_body, action
from tests.test_settlement_intents_mongo import reviewed, approval, snapshot
from utils import deps


async def setup_family(monkeypatch, database):
    await setup(monkeypatch, database)
    group = await database.trips.find_one({"id": "t"})
    members = [member for member in group["members"] if member["id"] not in {"c", "d"}]
    members.append({
        "id": "family", "name": "Creator's family", "kind": "family", "user_id": None,
        "family_members": ["Creator", "Relative"], "family_member_ids": ["c", "d"],
        "family_member_user_ids": ["u_c", "u_d"],
    })
    await database.trips.update_one({"id": "t"}, {"$set": {"members": members}})
    # The creator's family is deliberately different from the payer (u_a).
    await database.expenses.update_one({"id": "dinner"}, {"$set": {"created_by": "u_c"}})
    monkeypatch.setattr(deps, "db", database)
    monkeypatch.setattr(expenses, "db", database)


@pytest.mark.parametrize("guarded", [False, True])
def test_http_edits_allow_creator_family_and_admins_only(monkeypatch, guarded):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup_family(monkeypatch, database)
            if not guarded:
                await database.trips.update_one({"id": "t"}, {
                    "$unset": {"expense_settlement_activation_version": "",
                               "financial_write_guard_version": "", "expense_settlement_schema_version": ""}})
            app = FastAPI()
            app.include_router(expenses.router, prefix="/api")
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
                for account, expected in [("u_d", 200), ("u_a", 403), ("u_b", 403),
                                          ("u_c", 200), ("admin", 200), ("outsider", 403)]:
                    app.dependency_overrides[deps.get_current_user] = lambda: {"id": account}
                    before = await database.expenses.find_one({"id": "dinner"})
                    result = await http.patch("/api/trips/t/expenses/dinner", json={
                        "description": f"Updated by {account}"})
                    assert result.status_code == expected, result.text
                    saved = await database.expenses.find_one({"id": "dinner"})
                    if expected == 200:
                        assert saved["description"] == f"Updated by {account}"
                        assert saved["created_by"] == "u_c"
                    else:
                        assert saved == before
    asyncio.run(exercise())


def test_family_can_apply_uncovered_correction_and_version_receipts(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup_family(monkeypatch, database)
            for account in ("u_a", "u_b"):
                with pytest.raises(HTTPException) as denied:
                    await preview(database, actor=account)
                assert denied.value.status_code == 403
            review = await preview(database, actor="u_d")
            assert not review["requires_admin"]
            result = await corrections.create("t", create_body(review), {"id": "u_d"})
            assert result["status"] == "applied"
            saved = await database.expenses.find_one({"id": "dinner"})
            assert saved["amount"] == 120 and saved["created_by"] == "u_c"
            receipt = await receipt_versions.switch("t", "dinner", "family-receipt", {"id": "u_d"})
            assert receipt["receipt_id"] == "family-receipt"
            assert (await database.receipt_versions.find_one({"id": receipt["receipt_version_id"]}))["actor_user_id"] == "u_d"
            with pytest.raises(HTTPException) as denied:
                await receipt_versions.switch("t", "dinner", "unauthorized-receipt", {"id": "u_a"})
            assert denied.value.status_code == 403
            assert (await database.expenses.find_one({"id": "dinner"}))["receipt_id"] == "family-receipt"
    asyncio.run(exercise())


def test_family_correction_preserves_admin_review_for_covered_expenses(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (database, _, _):
            await setup_family(monkeypatch, database)
            _, request = await reviewed(database)
            intent = await workflow.create("t", request, {"id": "u_b"})
            await workflow.approve("t", intent["id"], approval(intent), {"id": "u_a"})
            payment = await database.payments.find_one({})
            review = await preview(database, actor="u_d")
            assert review["requires_admin"]
            proposal = await corrections.create("t", create_body(review), {"id": "u_d"})
            assert proposal["status"] == "awaiting_approval"
            with pytest.raises(HTTPException) as denied:
                await corrections.action("t", proposal["id"], action(proposal), {"id": "u_d"})
            assert denied.value.status_code == 403
            result = await corrections.action("t", proposal["id"], action(proposal), {"id": "admin"})
            assert result["status"] == "applied"
            current = await snapshot(database)
            assert current.remaining(share(current)["id"]) == 120 * SCALE
            assert await database.payments.find_one({}) == payment
    asyncio.run(exercise())
