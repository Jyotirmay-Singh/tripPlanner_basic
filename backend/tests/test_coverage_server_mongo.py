"""Actual app startup and HTTP reads against a disposable loopback database only."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
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


def test_actual_server_startup_snapshot_reads_and_existing_reports():
    mongo_url = os.environ.get("COVERAGE_TEST_MONGO_URL")
    if not mongo_url:
        pytest.skip("Set COVERAGE_TEST_MONGO_URL to a disposable loopback replica set")
    assert urlparse(mongo_url).hostname in {"localhost", "127.0.0.1"}
    mongo = MongoClient(mongo_url, serverSelectionTimeoutMS=1500)
    database = mongo[f"trip_splitter_coverage_smoke_{uuid4().hex}"]
    process = None
    http = requests.Session()
    http.trust_env = False
    try:
        assert mongo.admin.command("hello").get("setName")
        user_id, payer, debtor, trip_id, expense_id = (str(uuid4()) for _ in range(5))
        created = "2026-10-01T00:00:00+00:00"
        group = {"id": trip_id, "name": "Coverage smoke", "code": "SMK123", "currency": "INR", "version": 0,
                 "owner_id": user_id, "admin_ids": [user_id], "user_ids": [user_id], "created_at": created,
                 "start_date": "2026-10-01", "end_date": "2026-10-02",
                 "members": [{"id": payer, "kind": "individual", "name": "Payer", "user_id": user_id},
                             {"id": debtor, "kind": "individual", "name": "Participant"}]}
        bill = {"id": expense_id, "trip_id": trip_id, "amount": 100, "currency": "INR", "created_at": created,
                "paid_by_member_id": payer, "split_member_ids": [debtor], "split_mode": "PER_CAPITA",
                "category": "Food", "description": "Dinner", "date": "01-10-26"}
        database.users.insert_one({"id": user_id, "email": "coverage-smoke@gmail.com", "name": "Smoke"})
        database.trips.insert_one(deepcopy(group))
        database.expenses.insert_one(deepcopy(bill))
        # Only this generated fixture contains an activation marker; no public activation route
        # exists. This exercises retained history while new starts remain disabled.
        history_id = str(uuid4())
        history = {**deepcopy(group), "id": history_id, "code": "SMK124", "expense_settlement_activation_version": 1}
        historical_bill = {**deepcopy(bill), "trip_id": history_id, "id": str(uuid4())}
        database.trips.insert_one(history)
        database.expenses.insert_one(deepcopy(historical_bill))
        revision = make_share_revision(historical_bill, history["members"], history_id, recorded_at=created)
        database.expense_share_revisions.insert_one(revision)
        cash_id = str(uuid4())
        database.payments.insert_one({"id": cash_id, "trip_id": history_id, "amount": 40,
                                     "from_member_id": debtor, "to_member_id": payer,
                                     "created_at": "2026-10-02T00:00:00+00:00"})
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        environment = os.environ.copy()
        test_secret = "coverage-smoke-only-disposable-key-2026"
        environment.update(MONGO_URL=mongo_url, DB_NAME=database.name, JWT_SECRET=test_secret,
                           EXPENSE_SETTLEMENT_ENABLED="false", EMAIL_FEATURES_ENABLED="false",
                           PUSH_NOTIFICATIONS_ENABLED="false", MULTI_CURRENCY_EXPENSES_ENABLED="false",
                           INVITE_LINKS_ENABLED="false", RESEND_API_KEY="", GOOGLE_CLIENT_ID="",
                           EXPO_PUSH_ACCESS_TOKEN="", APP_URL="", ADMIN_PASSWORD="coverage-smoke-only")
        base_url = f"http://127.0.0.1:{port}"
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen([sys.executable, "-m", "uvicorn", "server:app", "--host", "127.0.0.1",
                                        "--port", str(port), "--log-level", "warning"],
                                       cwd=Path(__file__).resolve().parents[1], env=environment,
                                       stdout=log, stderr=log,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    config = http.get(f"{base_url}/api/meta/config", timeout=1)
                    if config.status_code == 200:
                        break
                except requests.ConnectionError:
                    pass
                time.sleep(0.1)
            else:
                pytest.fail("Isolated API failed startup; no shared database was used")
            assert config.json()["expense_settlement_enabled"] is False
            assert config.json()["expense_settlement_actions_ready"] is False
            token = jwt.encode({"sub": user_id, "type": "access", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
                               test_secret, algorithm="HS256")
            headers = {"Authorization": f"Bearer {token}"}
            disabled = http.get(f"{base_url}/api/trips/{trip_id}/expense-settlement", headers=headers, timeout=5)
            assert disabled.status_code == 200 and disabled.json()["availability"]["status"] == "disabled"
            url = f"{base_url}/api/trips/{history_id}"
            coverage = http.get(f"{url}/expense-settlement", headers=headers,
                                params={"detail_expense_id": historical_bill["id"]}, timeout=5)
            assert coverage.status_code == 200
            payload = coverage.json()
            assert payload["complete"] is True and payload["freshness"]["consistent"] is True
            assert payload["expenses"][0]["remaining_amount"] == "60"
            assert payload["expenses"][0]["coverage_quality"] == "historically_inferred"
            assert payload["availability"]["new_starts_available"] is False
            balances = http.get(f"{url}/balances", headers=headers, timeout=5)
            assert balances.status_code == 200
            assert balances.json()["net"] == {payer: 60, debtor: -60}
            for suffix in ("xlsx", "pdf"):
                report = http.get(f"{url}/report.{suffix}", params={"token": token}, timeout=10)
                assert report.status_code == 200 and len(report.content) > 100
            assert http.get(f"{url}/expense-settlement", timeout=5).status_code == 401
            assert database.payments.count_documents({"trip_id": history_id}) == 1
            assert database.expense_coverage_events.count_documents({}) == 0
            assert database.trips.find_one({"id": trip_id}).get("expense_settlement_activation_version") is None
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        http.close()
        mongo.drop_database(database.name)
        mongo.close()
