r"""Run backend tests against a disposable local API, never the shared QA service.

From backend: .\.venv\Scripts\python.exe scripts/run_isolated_tests.py [pytest args]
Each invocation uses a fresh database and stops its own API in finally.
"""
import os
from pathlib import Path
import socket
import re
import subprocess
import sys
import time
import uuid

from dotenv import dotenv_values
from pymongo import MongoClient
import requests


def main():
    root = Path(__file__).resolve().parents[1]
    evidence = root.parent / ".release-tmp" / "codefix-verification"
    evidence.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex[:12]
    mongo_url = "mongodb://127.0.0.1:27018/?replicaSet=qa0"
    with MongoClient(mongo_url, serverSelectionTimeoutMS=3000) as client:
        assert client.admin.command("hello")["setName"] == "qa0"
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 18081))  # Refuse to replace any existing service.
    env = {**os.environ, **{k: v for k, v in dotenv_values(root / ".env").items() if v is not None}}
    env.update(MONGO_URL=mongo_url, DB_NAME=f"trip_splitter_codefix_{run_id}",
               EMAIL_FEATURES_ENABLED="true", RESEND_API_KEY="",
               PUSH_NOTIFICATIONS_ENABLED="false", EXPO_PUSH_ACCESS_TOKEN="",
               MULTI_CURRENCY_EXPENSES_ENABLED="true", GOOGLE_CLIENT_ID="")
    args = sys.argv[1:] or ["-q", "-ra", "tests"]
    with (evidence / f"{run_id}-api.log").open("w", encoding="utf-8") as api_log:
        api = subprocess.Popen([sys.executable, "-m", "uvicorn", "server:app", "--host",
                                "127.0.0.1", "--port", "18081", "--no-access-log"], cwd=root, env=env,
                               stdout=api_log, stderr=subprocess.STDOUT)
        try:
            base = "http://127.0.0.1:18081"
            for _ in range(80):
                if api.poll() is not None:
                    raise RuntimeError("Isolated API stopped during startup; inspect its local log")
                try:
                    health = requests.get(base + "/api/health", timeout=1)
                    config = requests.get(base + "/api/meta/config", timeout=1)
                    config.raise_for_status()
                    protocols = config.json()
                    if health.ok and protocols.get("expense_create_protocol_version") == 1 \
                            and protocols.get("payment_create_protocol_version") == 1:
                        break
                except requests.RequestException:
                    pass
                time.sleep(0.5)
            else:
                raise RuntimeError("Isolated API protocols did not become ready")
            runner = {**env, "EXPO_PUBLIC_BACKEND_URL": base,
                      "MONGO_URL": "mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=250",
                      "DB_NAME": f"trip_splitter_runner_{run_id}",
                      "EXPENSE_TEST_MONGO_URL": mongo_url, "PAYMENT_TEST_MONGO_URL": mongo_url}
            header = f"API database: {env['DB_NAME']}\nRunner database: {runner['DB_NAME']}\n" \
                     f"API: {base}; qa0: 127.0.0.1:27018; protocols: 1/1\n" \
                     f"Command: python -m pytest {' '.join(args)}\n"
            print(header, flush=True)
            result = subprocess.run([sys.executable, "-m", "pytest", *args], cwd=root,
                                    env=runner, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace")
            output = result.stdout
            # Avoid retaining configured credentials if a failure happens to echo one.
            for key, value in env.items():
                if value and len(value) >= 8 and any(word in key for word in ("PASSWORD", "SECRET", "TOKEN", "API_KEY")):
                    output = output.replace(value, "[redacted]")
            output = re.sub(r"eyJ[A-Za-z0-9_.-]+", "[redacted token]", output)
            # Retain summaries rather than fixture dumps or request bodies on failures.
            summary = '\n'.join(line for line in output.splitlines() if
                                re.search(r"(FAILED |ERROR |\d+ passed|\d+ failed|\d+ skipped|Warning:|import python_multipart)", line))
            (evidence / f"{run_id}-pytest.log").write_text(
                header + summary + f"\nExit code: {result.returncode}\n", encoding="utf-8")
            print(output, flush=True)
            return result.returncode
        finally:
            api.terminate()
            try:
                api.wait(timeout=10)
            except subprocess.TimeoutExpired:
                api.kill()
                api.wait()


if __name__ == "__main__":
    sys.exit(main())
