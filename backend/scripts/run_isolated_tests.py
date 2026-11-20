"""Run unit/disposable-Mongo tests without inheriting a deployed API or database.

Optionally set SPLITORA_TEST_MONGO_URL to a disposable loopback replica set. Tests
without their Mongo opt-in remain skipped. Live API fixtures are excluded explicitly.
"""
import os
from pathlib import Path
import sys
from urllib.parse import urlparse


def main():
    backend = Path(__file__).resolve().parents[1]
    os.chdir(backend)
    sys.path.insert(0, str(backend))
    mongo = os.environ.get("SPLITORA_TEST_MONGO_URL")
    if mongo:
        parsed = urlparse(mongo)
        if parsed.scheme != "mongodb" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise SystemExit("SPLITORA_TEST_MONGO_URL must select a disposable loopback MongoDB instance")
    os.environ["MONGO_URL"] = "mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=100"
    os.environ["DB_NAME"] = "splitora_isolated_runner_unused"
    os.environ["EXPO_PUBLIC_BACKEND_URL"] = "http://127.0.0.1:9"
    for prefix in ("SAFETY", "COVERAGE", "EXPENSE", "PAYMENT", "DEPARTURE", "CHAT", "EMAIL"):
        key = f"{prefix}_TEST_MONGO_URL"
        if mongo:
            os.environ[key] = mongo
        else:
            os.environ.pop(key, None)
    import pytest

    class IsolatedOnly:
        def pytest_collection_modifyitems(self, config, items):
            selected, deselected = [], []
            for item in items:
                if any(name in item.fixturenames for name in ("api_client", "test_user", "admin_token")):
                    deselected.append(item)
                else:
                    selected.append(item)
            if deselected:
                items[:] = selected
                config.hook.pytest_deselected(items=deselected)

    return pytest.main(sys.argv[1:] or ["tests", "-q"], plugins=[IsolatedOnly()])


if __name__ == "__main__":
    sys.exit(main())
