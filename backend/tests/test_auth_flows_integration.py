# End-to-end FLOW tests for the Phase 9 email-auth features, exercising the REAL token layer
# and REAL route logic (unlike the per-endpoint tests, which mock issue_token/consume_token).
#
# Everything runs in-process against a tiny in-memory fake Mongo, so:
#   * no real Mongo / Atlas is touched (deterministic + parallel-safe), and
#   * no real Resend email is sent — send_email is spied, and the raw token (which is NEVER
#     persisted, only its SHA-256 hash is) is captured by wrapping issue_token.
#
# These cover the full chains the mock-level tests deliberately skip:
#   A) Forgot-password:  register -> request-reset -> reset -> new pw logs in, old fails, PIN intact
#   B) Email verify:     register (unverified) -> login still works (soft gate) -> /me flips verified
#   + endpoint-level single-use + expiry for both token types, and malformed-email 422.
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app  # noqa: E402
import routes.auth as auth_module  # noqa: E402
import utils.auth_tokens as at  # noqa: E402
import utils.deps as deps_module  # noqa: E402
from utils.auth_tokens import VERIFY_EMAIL, RESET_PASSWORD, hash_token  # noqa: E402


# --------------------------------------------------------------------------- #
# Minimal async in-memory Mongo replacement (users + auth_tokens)
# --------------------------------------------------------------------------- #
class FakeCollection:
    def __init__(self):
        self.docs = []
        self._id = 0

    @staticmethod
    def _match(doc, flt):
        return all(doc.get(k) == v for k, v in flt.items())

    @staticmethod
    def _project(doc, projection):
        # Only exclusion projections are used by the app (e.g. {"_id":0,"password_hash":0}).
        out = dict(doc)
        if projection:
            for k, keep in projection.items():
                if not keep:
                    out.pop(k, None)
        return out

    async def insert_one(self, doc):
        self._id += 1
        stored = dict(doc)
        stored["_id"] = self._id
        self.docs.append(stored)

    async def update_one(self, flt, update):
        for d in self.docs:
            if self._match(d, flt):
                d.update(update["$set"])
                return

    async def update_many(self, flt, update):
        for d in self.docs:
            if self._match(d, flt):
                d.update(update["$set"])

    async def find_one(self, flt, projection=None, *, sort=None):
        matches = [d for d in self.docs if self._match(d, flt)]
        if sort:
            key, direction = sort[0]
            matches.sort(key=lambda d: d[key], reverse=(direction == -1))
        return self._project(matches[0], projection) if matches else None


class FakeDB:
    def __init__(self):
        self.users = FakeCollection()
        self._cols = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, FakeCollection())


# --------------------------------------------------------------------------- #
@pytest.fixture
def client():
    # Not entered as a context manager => lifespan (index creation + admin seed) never runs.
    return TestClient(app)


@pytest.fixture
def env(monkeypatch):
    """Wire a shared fake DB into every module that touches `db` in these flows, spy
    send_email, and capture the raw token issue_token hands back (it's never stored raw)."""
    fake = FakeDB()
    monkeypatch.setattr(auth_module, "db", fake)
    monkeypatch.setattr(at, "db", fake)
    monkeypatch.setattr(deps_module, "db", fake)

    send = AsyncMock(return_value=None)
    monkeypatch.setattr(auth_module, "send_email", send)

    captured = []  # list of (token_type, raw_token) in issue order
    real_issue = at.issue_token

    async def wrapped_issue(user_id, token_type, ttl):
        raw = await real_issue(user_id, token_type, ttl)  # real impl -> writes to fake store
        captured.append((token_type, raw))
        return raw

    monkeypatch.setattr(auth_module, "issue_token", wrapped_issue)
    return fake, send, captured


def _latest(captured, token_type):
    toks = [raw for (t, raw) in captured if t == token_type]
    assert toks, f"no {token_type} token was issued"
    return toks[-1]


def _register(client, email, password, pin, name="Flow"):
    return client.post("/api/auth/register", json={
        "email": email, "password": password, "pin": pin, "name": name,
    })


# --------------------------------------------------------------------------- #
# A) Forgot-password full chain
# --------------------------------------------------------------------------- #
def test_forgot_password_full_chain_new_pw_works_old_fails_pin_intact(client, env):
    fake, send, captured = env
    assert _register(client, "flow@gmail.com", "origpass123", "1357").status_code == 200

    r = client.post("/api/auth/request-password-reset", json={"email": "flow@gmail.com"})
    assert r.status_code == 200
    assert r.json()["message"] == "If this email exists, a reset link has been sent."
    token = _latest(captured, RESET_PASSWORD)
    send.assert_awaited()  # an email (reset link) was "sent"

    r = client.post("/api/auth/reset-password", json={"token": token, "new_password": "brandnewpw1"})
    assert r.status_code == 200, r.text

    # New password logs in; old password is rejected; the PIN is untouched and still works.
    assert client.post("/api/auth/login", json={"email": "flow@gmail.com", "password": "brandnewpw1"}).status_code == 200
    assert client.post("/api/auth/login", json={"email": "flow@gmail.com", "password": "origpass123"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "flow@gmail.com", "pin": "1357"}).status_code == 200


# --------------------------------------------------------------------------- #
# B) Email-verification full chain + soft gate
# --------------------------------------------------------------------------- #
def test_verify_email_full_chain_and_soft_gate(client, env):
    fake, send, captured = env
    reg = _register(client, "verify@gmail.com", "verifypass1", "2468", name="Verify")
    assert reg.status_code == 200, reg.text
    jwt_token = reg.json()["access_token"]
    assert reg.json()["user"]["email_verified"] is False  # new email/password user starts unverified

    # Soft gate: an unverified user can still log in (and the payload reflects unverified).
    login = client.post("/api/auth/login", json={"email": "verify@gmail.com", "pin": "2468"})
    assert login.status_code == 200
    assert login.json()["user"]["email_verified"] is False

    auth_header = {"Authorization": f"Bearer {jwt_token}"}
    me = client.get("/api/auth/me", headers=auth_header)
    assert me.status_code == 200 and me.json()["email_verified"] is False

    token = _latest(captured, VERIFY_EMAIL)
    assert client.post("/api/auth/verify-email", json={"token": token}).status_code == 200

    me2 = client.get("/api/auth/me", headers=auth_header)
    assert me2.status_code == 200 and me2.json()["email_verified"] is True


# --------------------------------------------------------------------------- #
# Single-use (reuse rejected) at the endpoint level
# --------------------------------------------------------------------------- #
def test_reset_token_is_single_use(client, env):
    fake, send, captured = env
    assert _register(client, "reuse@gmail.com", "origpass123", "1111").status_code == 200
    assert client.post("/api/auth/request-password-reset", json={"email": "reuse@gmail.com"}).status_code == 200
    token = _latest(captured, RESET_PASSWORD)
    assert client.post("/api/auth/reset-password", json={"token": token, "new_password": "firstnewpw1"}).status_code == 200
    # second use of the same token is rejected
    assert client.post("/api/auth/reset-password", json={"token": token, "new_password": "secondnewpw2"}).status_code == 400


def test_verify_token_is_single_use(client, env):
    fake, send, captured = env
    assert _register(client, "vreuse@gmail.com", "verifypass1", "2222", name="VReuse").status_code == 200
    token = _latest(captured, VERIFY_EMAIL)
    assert client.post("/api/auth/verify-email", json={"token": token}).status_code == 200
    assert client.post("/api/auth/verify-email", json={"token": token}).status_code == 400


# --------------------------------------------------------------------------- #
# Expiry rejected at the endpoint level
# --------------------------------------------------------------------------- #
def _expire(fake, raw):
    th = hash_token(raw)
    for d in fake["auth_tokens"].docs:
        if d["token_hash"] == th:
            d["expires_at"] = datetime.now(timezone.utc) - timedelta(hours=2)


def test_expired_reset_token_rejected(client, env):
    fake, send, captured = env
    assert _register(client, "rexp@gmail.com", "origpass123", "3333").status_code == 200
    assert client.post("/api/auth/request-password-reset", json={"email": "rexp@gmail.com"}).status_code == 200
    token = _latest(captured, RESET_PASSWORD)
    _expire(fake, token)
    assert client.post("/api/auth/reset-password", json={"token": token, "new_password": "brandnewpw1"}).status_code == 400


def test_expired_verify_token_rejected(client, env):
    fake, send, captured = env
    assert _register(client, "vexp@gmail.com", "verifypass1", "4444", name="VExp").status_code == 200
    token = _latest(captured, VERIFY_EMAIL)
    _expire(fake, token)
    assert client.post("/api/auth/verify-email", json={"token": token}).status_code == 400


# --------------------------------------------------------------------------- #
# Malformed email is rejected by Pydantic (422) before the route/assert_gmail runs.
# --------------------------------------------------------------------------- #
def test_request_password_reset_malformed_email_422(client, env):
    fake, send, captured = env
    r = client.post("/api/auth/request-password-reset", json={"email": "not-an-email"})
    assert r.status_code == 422
    send.assert_not_awaited()


# --------------------------------------------------------------------------- #
# Empty / unknown token is rejected at the endpoint level (real consume_token,
# not mocked) with a clean 400 — never a 500/crash — and nothing is mutated.
# --------------------------------------------------------------------------- #
def _find_user(fake, email):
    return next(d for d in fake.users.docs if d["email"] == email)


def test_verify_email_empty_and_unknown_token_rejected_no_crash(client, env):
    fake, send, captured = env
    assert _register(client, "vbad@gmail.com", "verifypass1", "5551", name="VBad").status_code == 200
    assert client.post("/api/auth/verify-email", json={"token": ""}).status_code == 400
    assert client.post("/api/auth/verify-email", json={"token": "never-issued-xyz"}).status_code == 400
    # the account is untouched — still unverified
    assert _find_user(fake, "vbad@gmail.com")["email_verified"] is False


def test_reset_password_empty_and_unknown_token_rejected_no_crash(client, env):
    fake, send, captured = env
    assert _register(client, "rbad@gmail.com", "origpass123", "6661").status_code == 200
    # valid-length password so we clear the pw check and reach the token check (isolates the token 400)
    assert client.post("/api/auth/reset-password",
                       json={"token": "", "new_password": "brandnewpw1"}).status_code == 400
    assert client.post("/api/auth/reset-password",
                       json={"token": "never-issued", "new_password": "brandnewpw1"}).status_code == 400
    # the original password still works — nothing was changed
    assert client.post("/api/auth/login",
                       json={"email": "rbad@gmail.com", "password": "origpass123"}).status_code == 200


# --------------------------------------------------------------------------- #
# Re-verifying an already-verified account is idempotent (stays verified, no error).
# --------------------------------------------------------------------------- #
def test_verify_already_verified_is_idempotent(client, env):
    fake, send, captured = env
    assert _register(client, "videm@gmail.com", "verifypass1", "7771", name="VIdem").status_code == 200
    token1 = _latest(captured, VERIFY_EMAIL)
    assert client.post("/api/auth/verify-email", json={"token": token1}).status_code == 200
    user = _find_user(fake, "videm@gmail.com")
    assert user["email_verified"] is True
    # a second, fresh, valid token consumed again just re-affirms verified — no crash, still True
    fresh = asyncio.run(at.issue_token(user["id"], VERIFY_EMAIL, timedelta(hours=24)))
    assert client.post("/api/auth/verify-email", json={"token": fresh}).status_code == 200
    assert _find_user(fake, "videm@gmail.com")["email_verified"] is True


# --------------------------------------------------------------------------- #
# Resend cooldown clears once >60s have elapsed since the last verify token
# (drives the REAL seconds_since_last against a back-dated stored token).
# --------------------------------------------------------------------------- #
def _backdate_verify_tokens(fake, seconds):
    for d in fake["auth_tokens"].docs:
        if d["type"] == VERIFY_EMAIL:
            d["created_at"] = datetime.now(timezone.utc) - timedelta(seconds=seconds)


def test_resend_after_cooldown_elapsed_issues_new_token(client, env):
    fake, send, captured = env
    reg = _register(client, "rcool@gmail.com", "verifypass1", "8881", name="RCool")
    assert reg.status_code == 200
    jwt_token = reg.json()["access_token"]
    before = sum(1 for (t, _) in captured if t == VERIFY_EMAIL)  # register issued one

    _backdate_verify_tokens(fake, 120)  # pretend 2 min elapsed since that email
    r = client.post("/api/auth/resend-verification", headers={"Authorization": f"Bearer {jwt_token}"})
    assert r.status_code == 200, r.text

    after = sum(1 for (t, _) in captured if t == VERIFY_EMAIL)
    assert after == before + 1  # cooldown cleared -> a fresh verify token was issued & emailed
    send.assert_awaited()
