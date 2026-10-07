"""Real primary-app components -> HTTP -> full API -> disposable replica-set ledger.

Only native presentation/launch seams are stubbed by the client test. No API response is mocked.
"""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse
from uuid import uuid4

import jwt
from pymongo import MongoClient
import pytest
import requests

from services.expense_coverage import make_share_revision


def test_real_primary_client_multi_account_payment_journeys():
    mongo_url = os.environ.get("COVERAGE_TEST_MONGO_URL")
    if not mongo_url:
        pytest.skip("Set COVERAGE_TEST_MONGO_URL to a disposable loopback replica set")
    assert urlparse(mongo_url).hostname in {"localhost", "127.0.0.1"}
    mongo = MongoClient(mongo_url, serverSelectionTimeoutMS=3000)
    database = mongo[f"trip_splitter_payment_client_{uuid4().hex}"]
    root = Path(__file__).resolve().parents[2]
    api_process = None
    http = requests.Session()
    http.trust_env = False
    try:
        assert mongo.admin.command("hello").get("setName")
        secret = "disposable-payment-client-fixture-key-2026"
        users = {key: {"id": str(uuid4()), "email": f"journey-{key}@gmail.com", "name": key.title(),
                       "email_verified": True, "credentials_set": True, "upi_id": f"journey-{key}@upi",
                       "upi_updated_at": "fixture-v1"} for key in ("payer", "receiver", "admin", "outsider", "secondPayer", "secondReceiver")}
        database.users.insert_many(list(users.values()))
        fixtures = {"users": {key: {"id": user["id"], "token": jwt.encode({"sub": user["id"], "type": "access",
            "exp": datetime.now(timezone.utc) + timedelta(minutes=15)}, secret, algorithm="HS256")}
            for key, user in users.items()}, "cases": {}}
        created = "2026-10-01T00:00:00+00:00"
        for name, reverse in (("upi", 0), ("happyUpi", 0), ("cash", 0), ("bank", 0), ("receiverReport", 0),
                              ("group", 80), ("offset", 100), ("decline", 100), ("dispute", 0),
                              ("restart", 0), ("concurrent", 80), ("changed", 0), ("refresh", 0), ("dependent", 0),
                              ("family", 0), ("unavailable", 100), ("stale", 100), ("late", 0), ("oldReport", 0)):
            trip_id, a, b, expense_id = (str(uuid4()) for _ in range(4))
            trip = {"id": trip_id, "name": f"Journey {name}", "code": uuid4().hex[:6].upper(),
                    "currency": "INR", "version": 0, "created_at": created, "start_date": "2026-10-01", "end_date": "2026-10-02",
                    "owner_id": users["admin"]["id"], "admin_ids": [users["admin"]["id"]],
                    "user_ids": [users[key]["id"] for key in ("payer", "receiver", "admin")],
                    "expense_settlement_activation_version": 1, "financial_write_guard_version": 1,
                    "members": [{"id": a, "kind": "individual", "name": "Receiver", "user_id": users["receiver"]["id"]},
                                {"id": b, "kind": "individual", "name": "Payer", "user_id": users["payer"]["id"]}]}
            expenses = [{"id": expense_id, "trip_id": trip_id, "amount": 100, "currency": "INR", "created_at": created,
                         "date": "01-10-26", "category": "Food", "description": "Dinner",
                         "paid_by_member_id": a, "split_member_ids": [b], "split_mode": "PER_CAPITA"}]
            if reverse:
                expenses.append({**expenses[0], "id": str(uuid4()), "amount": reverse, "description": "Taxi",
                                 "paid_by_member_id": b, "split_member_ids": [a]})
            outgoing, incoming = b, a
            if name == "dependent":
                aa, bb, cc, dd = sorted(str(uuid4()) for _ in range(4))
                trip["members"] = [{"id": wallet, "kind": "individual", "name": key,
                                    "user_id": users[key]["id"]} for wallet, key in
                                   ((aa, "payer"), (bb, "secondPayer"), (cc, "receiver"), (dd, "secondReceiver"))]
                trip["user_ids"] += [users[key]["id"] for key in ("secondPayer", "secondReceiver")]
                expenses = [{**expenses[0], "paid_by_member_id": dd, "split_member_ids": [aa]},
                            {**expenses[0], "id": str(uuid4()), "description": "Taxi", "paid_by_member_id": cc, "split_member_ids": [bb]}]
                outgoing, incoming = aa, cc
            if name == "family":
                family, sibling = str(uuid4()), str(uuid4())
                trip["members"][1] = {"id": family, "kind": "family", "name": "Family",
                    "family_members": ["Payer", "Sibling"], "family_member_ids": [b, sibling],
                    "family_member_user_ids": [users["payer"]["id"], users["secondPayer"]["id"]]}
                trip["user_ids"].append(users["secondPayer"]["id"])
                expenses = [{**expenses[0], "amount": 201, "split_member_ids": [a, family]},
                            {**expenses[0], "id": str(uuid4()), "amount": 1, "description": "Rounding", "split_member_ids": [a, family]},
                            {**expenses[0], "id": str(uuid4()), "amount": -100, "description": "Refund", "split_member_ids": [family]}]
                outgoing = family
            if name == "unavailable":
                trip["members"][0].pop("user_id")
            if name == "changed":
                # Isolate the profile mutation from the pre-seeded aged report/late fixtures.
                trip["members"][0]["user_id"] = users["secondReceiver"]["id"]
                trip["user_ids"] = [users[key]["id"] for key in ("payer", "secondReceiver", "admin")]
            if name == "stale":
                trip.update(expense_settlement_schema_version=2, financial_write_guard_version=2)
            database.trips.insert_one(trip.copy())
            database.expenses.insert_many([row.copy() for row in expenses])
            revisions = [make_share_revision(row, trip["members"], trip_id, recorded_at=created) for row in expenses]
            database.expense_share_revisions.insert_many(revisions)
            if name == "stale":
                for revision in revisions:
                    database.expenses.update_one({"id": revision["expense_id"]}, {"$set": {
                        "active_revision_id": revision["id"], "created_by": users["receiver"]["id"]}})
            fixtures["cases"][name] = {"trip": trip, "expenseId": expense_id, "payerWallet": outgoing, "receiverWallet": incoming}
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        environment = os.environ.copy()
        environment.update(MONGO_URL=mongo_url, DB_NAME=database.name, JWT_SECRET=secret,
            EXPENSE_SETTLEMENT_ENABLED="true", PUSH_NOTIFICATIONS_ENABLED="true", EMAIL_FEATURES_ENABLED="false",
            MULTI_CURRENCY_EXPENSES_ENABLED="false", INVITE_LINKS_ENABLED="false", RESEND_API_KEY="", GOOGLE_CLIENT_ID="",
            EXPO_PUSH_ACCESS_TOKEN="", APP_URL="", ADMIN_PASSWORD="disposable-journey-only")
        with tempfile.TemporaryDirectory(prefix="payment-client-", dir=root / ".release-tmp") as temp, tempfile.TemporaryFile() as log:
            api_process = subprocess.Popen([sys.executable, "-m", "uvicorn", "server:app", "--host", "127.0.0.1",
                "--port", str(port), "--log-level", "warning"], cwd=root / "backend", env=environment,
                stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            base_url = f"http://127.0.0.1:{port}"
            for _ in range(250):
                if api_process.poll() is not None:
                    pytest.fail("Disposable API exited during startup")
                try:
                    if http.get(f"{base_url}/api/meta/config", timeout=1).status_code == 200:
                        break
                except requests.ConnectionError:
                    pass
                time.sleep(.1)
            else:
                pytest.fail("Disposable API did not become ready")
            # V2 correction prerequisites are installed explicitly in this generated namespace;
            # app startup deliberately does not install/upgrade production migration indexes.
            indexed = subprocess.run([sys.executable, "-c", "import asyncio; from services.financial_corrections import ensure_indexes; from database import db; asyncio.run(ensure_indexes(db))"],
                cwd=root / "backend", env=environment, stdout=log, stderr=log, timeout=20,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            assert indexed.returncode == 0, "Disposable correction index fixture failed"
            # Age genuine API-created work, then use the real sweeper. Only fixture timestamps
            # change; the client later performs the late/report-review journeys through HTTP.
            for name in ("late", "oldReport"):
                data = fixtures["cases"][name]
                headers = {"Authorization": f"Bearer {fixtures['users']['payer']['token']}"}
                url = f"{base_url}/api/trips/{data['trip']['id']}"
                current = http.get(f"{url}/expense-settlement", params={"detail_expense_id": data["expenseId"]}, headers=headers).json()
                quote = http.post(f"{url}/settlement-quotes", headers=headers, json={"mode": "direct",
                    "method": "upi" if name == "late" else "cash", "expected_snapshot_id": current["snapshot_id"],
                    "shares": [{"share_id": current["details"][data["expenseId"]]["participants"][0]["id"], "amount": "100"}],
                    "parties": [{"from_member_id": data["payerWallet"], "to_member_id": data["receiverWallet"],
                                 "payer_person_id": data["payerWallet"], "recipient_person_id": data["receiverWallet"]}]}).json()
                report = http.post(f"{url}/settlement-intents", headers=headers, json={"quote_id": quote["id"], "quote_hash": quote["quote_hash"],
                    "submission_action": "propose" if name == "late" else "report_paid", "client_mutation_id": str(uuid4())}).json()
                data["seededIntentId"] = report["id"]
                past = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
                if name == "late":
                    database.settlement_intents.update_one({"id": report["id"]}, {"$set": {"expires_at": past}})
                else:
                    database.payment_attempts.update_one({"settlement_intent_id": report["id"]}, {"$set": {"awaiting_confirmation_at": past}})
            swept = subprocess.run([sys.executable, "-c", "import asyncio; from services.payment_attempts import expire_settlement_intents; asyncio.run(expire_settlement_intents())"],
                cwd=root / "backend", env=environment, stdout=log, stderr=log, timeout=20,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            assert swept.returncode == 0, "Disposable sweeper failed"
            fixture_path = Path(temp) / "fixture.json"
            fixture_path.write_text(json.dumps(fixtures), encoding="utf-8")
            environment.update(EXPO_PUBLIC_BACKEND_URL=base_url, PAYMENT_JOURNEY_FIXTURE=str(fixture_path))
            command = ["node", "node_modules/jest/bin/jest.js", "--runInBand", "--cacheDirectory",
                       str(root / ".release-tmp/payment-journey-20261007/jest-cache"),
                       "src/__tests__/paymentJourney.integration.test.tsx"]
            client = subprocess.run(command, cwd=root / "frontend", env=environment, capture_output=True, text=True, encoding="utf-8", timeout=180,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            # Client output contains assertions only; fixture tokens and API logs are never printed.
            assert client.returncode == 0, client.stdout + client.stderr
            print((client.stdout + client.stderr).encode("ascii", "backslashreplace").decode("ascii"))
        for name, cash_count, event_count in (("upi", 1, 1), ("happyUpi", 1, 1), ("cash", 1, 1), ("bank", 1, 1), ("receiverReport", 1, 1),
                                              ("group", 1, 1), ("offset", 0, 1), ("decline", 0, 0), ("dispute", 0, 0),
                                              ("restart", 1, 1), ("concurrent", 1, 1), ("changed", 1, 0), ("refresh", 1, 1), ("dependent", 2, 1),
                                              ("family", 2, 2), ("unavailable", 0, 1), ("stale", 0, 0), ("late", 1, 0), ("oldReport", 1, 1)):
            trip_id = fixtures["cases"][name]["trip"]["id"]
            assert database.payments.count_documents({"trip_id": trip_id}) == cash_count, name
            assert database.expense_coverage_events.count_documents({"trip_id": trip_id, "kind": "allocation"}) == event_count, name
        events = list(database.notification_outbox.find({}, {"_id": 0}))
        assert len({row["event_key"] for row in events}) == len(events)
        assert all("journey-" not in json.dumps(row.get("data", {})) for row in events)
        assert database.notification_outbox.count_documents({"event_type": "settlement.allocation_applied"}) == 15
    finally:
        if api_process and api_process.poll() is None:
            api_process.terminate()
            try:
                api_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                api_process.kill(); api_process.wait(timeout=5)
        http.close()
        mongo.drop_database(database.name)
        mongo.close()
