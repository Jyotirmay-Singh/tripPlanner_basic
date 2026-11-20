"""Authenticated safety journeys on an explicitly selected disposable loopback database."""
import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import timedelta
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from motor.motor_asyncio import AsyncIOMotorClient
import pytest
from fastapi import HTTPException

from server import app
import database as storage
from routes import chat, community, payment_attempts, payments, receipts
from services import community_safety as safety, chat_realtime, mobile_claims, push_notifications
from services.chat_realtime import ChatConnectionManager
from utils.common import now_utc
from utils.security import create_token, hash_secret
from config import SUPER_ADMIN_EMAIL


def adult(user_id, **fields):
    return {"id": user_id, "email": f"{user_id}@gmail.com", "name": user_id.title(),
            "community_age_band": "18_plus", "community_terms_version": safety.TERMS_VERSION,
            "email_verified": True, "email_verified_for": f"{user_id}@gmail.com",
            "email_verified_at": now_utc(), "email_verification_method": "email_link", **fields}


def bearer(user_id):
    return {"Authorization": "Bearer " + create_token(user_id, f"{user_id}@gmail.com")}


@asynccontextmanager
async def isolated(monkeypatch):
    url = os.environ.get("SAFETY_TEST_MONGO_URL")
    if not url:
        pytest.skip("Set SAFETY_TEST_MONGO_URL to a disposable loopback replica set")
    assert urlparse(url).hostname in {"localhost", "127.0.0.1"}
    client = AsyncIOMotorClient(url, serverSelectionTimeoutMS=2000, tz_aware=True)
    db = client[f"splitora_safety_test_{uuid4().hex}"]
    original_db, original_client = storage.db, storage.client
    for module in list(sys.modules.values()):
        if module and getattr(module, "__file__", "") and str(getattr(module, "__file__", "")).startswith(str(os.path.dirname(storage.__file__))):
            if getattr(module, "db", None) is original_db:
                monkeypatch.setattr(module, "db", db)
            if getattr(module, "client", None) is original_client:
                monkeypatch.setattr(module, "client", client)
    manager = ChatConnectionManager()
    monkeypatch.setattr(community, "chat_connections", manager)
    monkeypatch.setattr(chat, "chat_connections", manager)
    monkeypatch.setattr(chat, "enqueue_notification_event", AsyncMock())
    await db.community_reports.create_index([("reporter_user_id", 1), ("client_report_id", 1)], unique=True)
    await db.community_blocks.create_index([("user_id", 1), ("blocked_user_id", 1)], unique=True)
    await db.community_hidden_receipts.create_index([("trip_id", 1), ("expense_id", 1), ("revision", 1)], unique=True)
    await db.users.insert_many([
        adult("alice"), adult("bob"), adult("guardian"), adult("stranger"),
        adult("operator", role="super_admin", email=SUPER_ADMIN_EMAIL, email_verified_for=SUPER_ADMIN_EMAIL),
        {"id": "teen", "name": "Teen", "email": "teen@gmail.com"},
        {"id": "legacy", "name": "Legacy", "email": "legacy@gmail.com"},
    ])
    await db.trips.insert_one({"id": "group", "name": "Synthetic Goa trip", "owner_id": "alice",
                              "user_ids": ["alice", "bob", "teen"], "admin_ids": ["alice"],
                              "members": [{"id": key, "name": key.title(), "kind": "individual", "user_id": key}
                                          for key in ("alice", "bob", "teen")]})
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
            yield db, http, manager
    finally:
        await client.drop_database(db.name)
        client.close()


async def terms(http, user_id, band):
    return await http.post("/api/auth/me/safety/terms", headers=bearer(user_id),
                           json={"version": safety.TERMS_VERSION, "age_band": band})


async def consent_request(http):
    assert (await terms(http, "teen", "13_17")).status_code == 200
    result = await http.post("/api/auth/me/safety/guardian-request", headers=bearer("teen"),
                             json={"email": "guardian@gmail.com"})
    assert result.status_code == 200, result.text
    return result.json()["code"]


async def approve(http, code):
    response = await http.post("/api/safety/guardian/consent", headers=bearer("guardian"), json={
        "code": code, "is_parent_or_guardian": True,
        "chat_enabled": True, "receipts_enabled": True, "contacts_enabled": True,
    })
    assert response.status_code == 200, response.text
    result = await http.post("/api/admin/safety/guardians/teen/verify", headers=bearer("operator"),
                             json={"verification_reference": "synthetic-verified-case-001"})
    assert result.status_code == 200, result.text


def test_new_existing_underage_and_terms_renewal(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, _):
            assert (await http.get("/api/trips", headers=bearer("legacy"))).status_code == 403
            stale = await http.post("/api/auth/me/safety/terms", headers=bearer("legacy"),
                                    json={"version": "old", "age_band": "18_plus"})
            assert stale.status_code == 409
            assert (await terms(http, "legacy", "18_plus")).json()["permissions"]["account"] is True
            assert (await terms(http, "legacy", "13_17")).status_code == 409
            assert (await terms(http, "teen", "under_13")).status_code == 200
            assert (await http.get("/api/trips", headers=bearer("teen"))).status_code == 403
            assert (await http.get("/api/auth/me", headers=bearer("teen"))).status_code == 200
            assert (await http.get("/api/auth/me/safety", headers=bearer("teen"))).status_code == 200
            await db.users.update_one({"id": "legacy"}, {"$set": {"community_terms_version": "old"}})
            assert (await http.get("/api/trips", headers=bearer("legacy"))).status_code == 403
    asyncio.run(exercise())


def test_auth_and_profile_replacements_keep_current_offline_permissions(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, _):
            password = "Synthetic-account-password-42"
            await db.users.update_many({"id": {"$in": ["alice", "teen"]}},
                                       {"$set": {"password_hash": hash_secret(password)}})

            async def login(user_id):
                response = await http.post("/api/auth/login", json={
                    "email": f"{user_id}@gmail.com", "password": password,
                })
                assert response.status_code == 200, response.text
                profile = response.json()["user"]
                assert "password_hash" not in profile and "guardian_consent" not in profile
                return profile

            profile = await login("alice")
            assert profile["community_age_band"] == "18_plus"
            assert profile["community_terms_version"] == safety.TERMS_VERSION
            assert all(profile["community_permissions"].values())
            for path, payload in [
                ("/api/auth/me", {"upi_id": None}),
                ("/api/auth/me/mobile", {"mobile_number": None, "mobile_country_code": None}),
            ]:
                response = await http.patch(path, headers=bearer("alice"), json=payload)
                assert response.status_code == 200, response.text
                assert response.json()["community_permissions"] == profile["community_permissions"]
                assert response.json()["community_terms_version"] == safety.TERMS_VERSION
            credentials = await http.post("/api/auth/set-credentials", headers=bearer("alice"),
                                          json={"password": password})
            assert credentials.status_code == 200
            assert credentials.json()["user"]["community_permissions"] == profile["community_permissions"]

            code = await consent_request(http)
            await approve(http, code)
            assert all((await login("teen"))["community_permissions"].values())
            await db.users.update_one({"id": "guardian"}, {"$set": {"community_terms_version": "old"}})
            assert not any((await login("teen"))["community_permissions"].values())
    asyncio.run(exercise())


def test_guardian_identity_verification_revocation_and_renewal(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, manager):
            code = await consent_request(http)
            assert len(code) == 32
            stored = await db.users.find_one({"id": "teen"})
            assert code not in repr(stored)
            assert (await http.post("/api/safety/guardian/preview", headers=bearer("stranger"), json={"code": code})).status_code == 404
            assert (await http.post("/api/admin/safety/guardians/teen/verify", headers=bearer("guardian"),
                                    json={"verification_reference": "fake-case"})).status_code == 403
            await approve(http, code)
            state = (await http.get("/api/auth/me/safety", headers=bearer("teen"))).json()
            assert all(state["permissions"].values())
            me = (await http.get("/api/auth/me", headers=bearer("teen"))).json()
            assert "guardian_consent" not in me and me["community_permissions"]["chat"]
            # Socket keys must be hashable, as real Starlette WebSockets are.
            class Socket:
                close = AsyncMock()
            socket = Socket()
            await manager.connect("group", "teen", socket)
            disabled = {"chat_enabled": False, "receipts_enabled": False, "contacts_enabled": False}
            assert (await http.patch("/api/safety/children/teen", headers=bearer("guardian"), json=disabled)).status_code == 200
            socket.close.assert_awaited_once_with(code=4403)
            state = (await http.get("/api/auth/me/safety", headers=bearer("teen"))).json()
            assert state["permissions"] == {"account": True, "chat": False, "receipts": False, "contacts": False}
            await db.users.update_one({"id": "guardian"}, {"$set": {"email": "changed@gmail.com"}})
            assert not (await safety.community_permissions(db, await db.users.find_one({"id": "teen"})))["permissions"]["account"]
            await db.users.update_one({"id": "guardian"}, {"$set": {"email": "guardian@gmail.com"}})
            await db.users.update_one({"id": "teen"}, {"$set": {"guardian_consent.terms_version": "old"}})
            assert (await http.get("/api/auth/me/safety", headers=bearer("teen"))).json()["guardian_status"] == "renewal_required"
            assert (await http.patch("/api/safety/children/teen", headers=bearer("guardian"), json=disabled)).status_code == 404
            assert (await http.delete("/api/safety/children/teen/consent", headers=bearer("guardian"))).status_code == 200
            assert not (await http.get("/api/auth/me/safety", headers=bearer("teen"))).json()["permissions"]["account"]
    asyncio.run(exercise())


def test_guardian_expiry_unverified_and_stale_consent(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, _):
            code = await consent_request(http)
            await db.users.update_one({"id": "guardian"}, {"$set": {"email_verified": False}})
            assert (await http.post("/api/safety/guardian/preview", headers=bearer("guardian"), json={"code": code})).status_code == 403
            await db.users.update_one({"id": "guardian"}, {"$set": {"email_verified": True}})
            await db.users.update_one({"id": "teen"}, {"$set": {"guardian_consent.expires_at": now_utc() - timedelta(seconds=1)}})
            assert (await http.post("/api/safety/guardian/preview", headers=bearer("guardian"), json={"code": code})).status_code == 404
    asyncio.run(exercise())


def test_bidirectional_block_filters_rest_unread_and_socket_fanout(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, manager):
            class Socket:
                def __init__(self):
                    self.send_json, self.close = AsyncMock(), AsyncMock()
            alice, bob = Socket(), Socket()
            await manager.connect("group", "alice", alice)
            await manager.connect("group", "bob", bob)
            for user_id in ("alice", "bob"):
                sent = await http.post("/api/trips/group/chat/messages", headers=bearer(user_id),
                                       json={"text": f"Message from {user_id}", "client_message_id": str(uuid4())})
                assert sent.status_code == 200, sent.text
            assert (await http.put("/api/trips/group/safety/blocks/bob", headers=bearer("alice"))).status_code == 200
            for user_id, blocked in (("alice", "bob"), ("bob", "alice")):
                page = (await http.get("/api/trips/group/chat/messages", headers=bearer(user_id))).json()
                assert page["blocked_user_ids"] == [blocked]
                assert all(message["sender_user_id"] == user_id for message in page["items"])
                unread = await http.get("/api/trips/group/chat/unread", headers=bearer(user_id))
                assert unread.status_code == 200 and unread.json()["count"] == 0
            alice.send_json.reset_mock()
            bob.send_json.reset_mock()
            await http.post("/api/trips/group/chat/messages", headers=bearer("alice"),
                            json={"text": "Blocked delivery", "client_message_id": str(uuid4())})
            alice.send_json.assert_awaited_once()
            bob.send_json.assert_not_awaited()
            assert not await safety.chat_recipient_allowed(db, "bob", "alice")
    asyncio.run(exercise())


def test_reporting_idempotency_moderation_retry_and_receipt_revision(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, _):
            message = await http.post("/api/trips/group/chat/messages", headers=bearer("bob"),
                                      json={"text": "Reported text", "client_message_id": str(uuid4())})
            payload = {"client_report_id": str(uuid4()), "target_type": "message", "target_id": message.json()["id"],
                       "reason": "harassment", "details": "Synthetic safety report"}
            one, two = await asyncio.gather(*[http.post("/api/trips/group/safety/reports", headers=bearer("alice"), json=payload) for _ in range(2)])
            assert one.status_code == two.status_code == 200 and one.json()["id"] == two.json()["id"]
            assert await db.community_reports.count_documents({}) == 1
            assert (await http.post("/api/trips/group/safety/reports", headers=bearer("alice"), json={**payload, "reason": "spam"})).status_code == 409
            case_id = one.json()["id"]
            original_delete = chat.delete_chat_message
            monkeypatch.setattr(chat, "delete_chat_message", AsyncMock(side_effect=RuntimeError("synthetic transient failure")))
            resolution = {"action": "remove_content", "note": "Confirmed synthetic report"}
            with pytest.raises(RuntimeError):
                await http.post(f"/api/admin/safety/reports/{case_id}/resolve", headers=bearer("operator"), json=resolution)
            assert (await db.community_reports.find_one({"id": case_id}))["status"] == "action_pending"
            monkeypatch.setattr(chat, "delete_chat_message", original_delete)
            result = await http.post(f"/api/admin/safety/reports/{case_id}/resolve", headers=bearer("operator"), json=resolution)
            assert result.status_code == 200, result.text
            assert not (await db.chat_messages.find_one({"id": payload["target_id"]})).get("text")
            await db.expenses.insert_one({"id": "receipt-expense", "trip_id": "group", "created_by": "bob", "receipt_id": "old-revision"})
            report = await http.post("/api/trips/group/safety/reports", headers=bearer("alice"), json={**payload,
                "client_report_id": str(uuid4()), "target_type": "receipt", "target_id": "receipt-expense"})
            await db.expenses.update_one({"id": "receipt-expense"}, {"$set": {"receipt_id": "new-revision"}})
            assert (await http.post(f"/api/admin/safety/reports/{report.json()['id']}/resolve", headers=bearer("operator"), json=resolution)).status_code == 200
            assert await db.community_hidden_receipts.find_one({"revision": "old-revision"})
            assert not (await db.expenses.find_one({"id": "receipt-expense"})).get("receipt_hidden_at")
    asyncio.run(exercise())


def test_moderator_receipt_preview_never_substitutes_replacement_content(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, _):
            await db.expenses.insert_one({"id": "receipt-preview", "trip_id": "group", "created_by": "bob",
                                          "receipt_id": "reported-revision"})
            report = await http.post("/api/trips/group/safety/reports", headers=bearer("alice"), json={
                "client_report_id": str(uuid4()), "target_type": "receipt", "target_id": "receipt-preview",
                "reason": "inappropriate", "details": "Reported receipt needs review",
            })
            assert report.status_code == 200, report.text
            preview = f"/api/admin/safety/reports/{report.json()['id']}/receipt"
            read = AsyncMock(return_value=(b"reported image", "image/png"))
            monkeypatch.setattr(receipts, "read_receipt", read)
            assert (await http.get(preview)).status_code == 401
            assert (await http.get(preview, headers=bearer("alice"))).status_code == 403
            await db.expenses.update_one({"id": "receipt-preview"}, {"$set": {"receipt_id": "replacement"}})
            response = await http.get(preview, headers=bearer("operator"))
            assert response.status_code == 200 and response.content == b"reported image"
            assert "no-store" in response.headers["cache-control"]
            read.assert_awaited_once_with("reported-revision")
            read.return_value = None
            assert (await http.get(preview, headers=bearer("operator"))).status_code == 404
            await db.expenses.update_one({"id": "receipt-preview"}, {
                "$unset": {"receipt_id": ""}, "$set": {"receipt_base64": "data:image/png;base64,b2xk"},
            })
            legacy = await http.post("/api/trips/group/safety/reports", headers=bearer("alice"), json={
                "client_report_id": str(uuid4()), "target_type": "receipt", "target_id": "receipt-preview",
                "reason": "inappropriate", "details": "Legacy receipt needs review",
            })
            legacy_preview = f"/api/admin/safety/reports/{legacy.json()['id']}/receipt"
            assert (await http.get(legacy_preview, headers=bearer("operator"))).content == b"old"
            await db.expenses.update_one({"id": "receipt-preview"}, {
                "$set": {"receipt_base64": "data:image/png;base64,bmV3"},
            })
            assert (await http.get(legacy_preview, headers=bearer("operator"))).status_code == 404
    asyncio.run(exercise())


def test_revoked_contacts_hidden_and_account_cleanup(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, _):
            await approve(http, await consent_request(http))
            await db.users.update_one({"id": "teen"}, {"$set": {"upi_id": "synthetic@upi"}})
            trip = await db.trips.find_one({"id": "group"})
            await db.trip_mobile_claims.insert_one({"trip_id": "group", "user_id": "teen", "member_id": "teen", "mobile_number": "+919999999999"})
            assert (await mobile_claims.enrich_trip_mobile_numbers(trip))["members"][2]["mobile_number"]
            assert (await payments._recipient_candidates(trip["members"][2]))[0]["upi_id"] == "synthetic@upi"
            await http.delete("/api/safety/children/teen/consent", headers=bearer("guardian"))
            assert (await mobile_claims.enrich_trip_mobile_numbers(trip))["members"][2]["mobile_number"] is None
            assert (await payments._recipient_candidates(trip["members"][2]))[0]["upi_id"] is None
            with pytest.raises(HTTPException) as denied:
                await payment_attempts._selected_recipient(trip["members"][2], "teen")
            assert denied.value.detail["code"] == "recipient_upi_unavailable"
            await db.community_reports.insert_one({"id": "case", "target_type": "user", "target_id": "teen", "target_user_id": "teen",
                "reporter_user_id": "teen", "request": {"target_id": "teen", "details": "private"}, "snapshot": "private", "details": "private"})
            await safety.cleanup_community_account(db, "teen")
            case = await db.community_reports.find_one({"id": "case"})
            assert "teen" not in repr(case) and "private" not in repr(case)
            await safety.cleanup_community_account(db, "guardian")
            assert "guardian_consent" not in await db.users.find_one({"id": "teen"})
    asyncio.run(exercise())


def test_blocked_push_and_websocket_session_or_permission_failures(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, _):
            await http.put("/api/trips/group/safety/blocks/bob", headers=bearer("alice"))
            post = AsyncMock()
            monkeypatch.setattr(push_notifications, "_expo_post", post)
            event = {"event_key": "blocked-chat", "event_type": "chat.message.created", "actor_user_id": "bob",
                     "trip_id": "group", "deliveries": [{"user_id": "alice", "status": "pending"}]}
            await push_notifications._send_due_deliveries(event, now_utc())
            assert event["deliveries"][0]["status"] == "dead"
            post.assert_not_awaited()
            from starlette.websockets import WebSocketDisconnect
            class Socket:
                def __init__(self, user_id, version=0):
                    self.accept, self.send_json, self.close = AsyncMock(), AsyncMock(), AsyncMock()
                    self.receive_json = AsyncMock(side_effect=[{
                        "type": "auth", "token": create_token(user_id, f"{user_id}@gmail.com", version),
                    }, WebSocketDisconnect()])
            for user_id, version, code in [("teen", 0, 4403), ("alice", 1, 4401)]:
                socket = Socket(user_id, version)
                await chat.chat_websocket(socket, "group")
                socket.close.assert_awaited_once_with(code=code)
                socket.send_json.assert_not_awaited()
    asyncio.run(exercise())


def test_age_correction_and_ineligible_account_deletion(monkeypatch):
    async def exercise():
        async with isolated(monkeypatch) as (db, http, _):
            response = await http.post("/api/admin/safety/age-corrections/teen", headers=bearer("operator"),
                json={"age_band": "under_13", "verification_reference": "synthetic-correction-001"})
            assert response.status_code == 200, response.text
            assert (await terms(http, "teen", "under_13")).status_code == 200
            deleted = await http.request("DELETE", "/api/auth/me", headers=bearer("teen"),
                json={"confirmation": "DELETE", "acknowledge_unsettled": True, "trip_actions": []})
            assert deleted.status_code == 200, deleted.text
            assert await db.users.find_one({"id": "teen"}) is None
            assert (await http.get("/api/auth/me", headers=bearer("teen"))).status_code == 401
    asyncio.run(exercise())
