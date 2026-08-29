#!/usr/bin/env python3
"""Credential-free deployment gate for the Trip Chat protocol surface."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed


CHAT_PROTOCOL_VERSION = 1
REQUIRED_CHAT_OPERATIONS = {
    "/api/trips/{trip_id}/chat/messages": {"get", "post"},
    "/api/trips/{trip_id}/chat/messages/{message_id}": {"patch", "delete"},
    "/api/trips/{trip_id}/chat/unread": {"get"},
    "/api/trips/{trip_id}/chat/read": {"put"},
    "/api/trips/{trip_id}/chat/history": {"delete"},
}


class VerificationError(RuntimeError):
    """A safe, non-secret deployment verification failure."""


@dataclass(frozen=True)
class HttpResult:
    status: int
    data: Any


def normalized_base_url(value: str) -> str:
    candidate = value.strip().rstrip("/")
    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise VerificationError("base URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise VerificationError("base URL must not contain credentials, query parameters, or fragments")
    return candidate


def websocket_url(base_url: str, path: str) -> str:
    parsed = urlsplit(f"{base_url}{path}")
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunsplit((scheme, parsed.netloc, parsed.path, "", ""))


def request_json(base_url: str, path: str, *, method: str = "GET", body: dict | None = None,
                 timeout: float = 20) -> HttpResult:
    encoded = json.dumps(body).encode("utf-8") if body is not None else None
    request = Request(
        f"{base_url}{path}",
        data=encoded,
        method=method,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        response = urlopen(request, timeout=timeout)
        status = response.status
        raw = response.read()
    except HTTPError as error:
        status = error.code
        raw = error.read()
    except (URLError, TimeoutError, OSError) as error:
        raise VerificationError(f"HTTP check could not reach the deployment ({type(error).__name__})") from None

    try:
        data = json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        data = None
    return HttpResult(status=status, data=data)


def require_status(result: HttpResult, expected: int, check: str) -> None:
    if result.status != expected:
        raise VerificationError(f"{check} returned HTTP {result.status}; expected {expected}")


def verify_health(base_url: str, timeout: float) -> None:
    result = request_json(base_url, "/api/health", timeout=timeout)
    require_status(result, 200, "health check")
    if not isinstance(result.data, dict) or result.data.get("status") != "ok":
        raise VerificationError("health check did not report status=ok")
    if result.data.get("chat_protocol_version") != CHAT_PROTOCOL_VERSION:
        raise VerificationError(
            f"health check does not expose chat protocol version {CHAT_PROTOCOL_VERSION}"
        )
    revision = result.data.get("revision")
    if not isinstance(revision, str) or not revision or len(revision) > 12:
        raise VerificationError("health check deployment revision is missing or not redacted")
    print(f"PASS health revision={revision} chat_protocol_version={CHAT_PROTOCOL_VERSION}")


def verify_openapi(base_url: str, timeout: float) -> None:
    result = request_json(base_url, "/openapi.json", timeout=timeout)
    require_status(result, 200, "OpenAPI check")
    paths = result.data.get("paths") if isinstance(result.data, dict) else None
    if not isinstance(paths, dict):
        raise VerificationError("OpenAPI response has no paths object")

    missing: list[str] = []
    for path, methods in REQUIRED_CHAT_OPERATIONS.items():
        operations = paths.get(path)
        if not isinstance(operations, dict):
            missing.append(path)
            continue
        absent_methods = methods.difference(key.lower() for key in operations)
        if absent_methods:
            missing.append(f"{path} ({','.join(sorted(absent_methods))})")
    if missing:
        raise VerificationError(f"OpenAPI is missing required chat operations: {'; '.join(missing)}")
    print(f"PASS OpenAPI exposes {len(REQUIRED_CHAT_OPERATIONS)} required chat paths")


def verify_rest_authentication(base_url: str, timeout: float) -> None:
    result = request_json(
        base_url,
        "/api/trips/deployment-verifier/chat/messages",
        method="POST",
        body={
            "client_message_id": "00000000-0000-4000-8000-000000000001",
            "text": "deployment verification",
        },
        timeout=timeout,
    )
    require_status(result, 401, "unauthenticated chat send")
    print("PASS unauthenticated chat send is rejected with HTTP 401")


async def verify_websocket_authentication(base_url: str, timeout: float) -> None:
    url = websocket_url(base_url, "/api/trips/deployment-verifier/chat/ws")
    try:
        async with connect(url, open_timeout=timeout, close_timeout=timeout) as websocket:
            await websocket.send(json.dumps({"type": "auth", "token": "invalid-deployment-verifier"}))
            try:
                frame = await asyncio.wait_for(websocket.recv(), timeout=timeout)
            except ConnectionClosed as error:
                if error.code != 4401:
                    raise VerificationError(
                        f"invalid WebSocket authentication closed with {error.code}; expected 4401"
                    ) from None
                print("PASS invalid WebSocket authentication is rejected with close code 4401")
                return
            raise VerificationError(
                f"invalid WebSocket authentication unexpectedly received a {type(frame).__name__} frame"
            )
    except VerificationError:
        raise
    except Exception as error:
        status = getattr(getattr(error, "response", None), "status_code", None)
        detail = f"HTTP {status}" if status is not None else type(error).__name__
        raise VerificationError(f"WebSocket authentication check failed during handshake ({detail})") from None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify that a deployed backend exposes the complete Trip Chat protocol.",
    )
    parser.add_argument(
        "base_url",
        nargs="?",
        default=os.environ.get("BACKEND_BASE_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL"),
        help="Backend origin, or set BACKEND_BASE_URL/EXPO_PUBLIC_BACKEND_URL.",
    )
    parser.add_argument("--timeout", type=float, default=20, help="Per-check timeout in seconds.")
    args = parser.parse_args()
    if not args.base_url:
        parser.error("base_url is required when no backend URL environment variable is set")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    return args


def main() -> int:
    args = parse_args()
    try:
        base_url = normalized_base_url(args.base_url)
        verify_health(base_url, args.timeout)
        verify_openapi(base_url, args.timeout)
        verify_rest_authentication(base_url, args.timeout)
        asyncio.run(verify_websocket_authentication(base_url, args.timeout))
    except VerificationError as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1
    print("Trip Chat deployment verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
