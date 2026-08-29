import pytest

from scripts import verify_chat_deployment as verifier


def test_current_app_exposes_the_required_chat_openapi_surface():
    from server import app

    paths = app.openapi()["paths"]
    for path, required_methods in verifier.REQUIRED_CHAT_OPERATIONS.items():
        assert path in paths
        assert required_methods.issubset(method.lower() for method in paths[path])


def test_normalizes_safe_origins_and_builds_websocket_url():
    base = verifier.normalized_base_url(" https://api.example.test/prefix/ ")
    assert base == "https://api.example.test/prefix"
    assert verifier.websocket_url(base, "/api/trips/t1/chat/ws") == (
        "wss://api.example.test/prefix/api/trips/t1/chat/ws"
    )


@pytest.mark.parametrize("value", [
    "api.example.test",
    "ftp://api.example.test",
    "https://user:password@api.example.test",
    "https://api.example.test?token=secret",
    "https://api.example.test/#fragment",
])
def test_rejects_unsafe_or_ambiguous_base_urls(value):
    with pytest.raises(verifier.VerificationError):
        verifier.normalized_base_url(value)


def test_openapi_gate_requires_every_chat_method(monkeypatch):
    paths = {
        path: {method: {} for method in methods}
        for path, methods in verifier.REQUIRED_CHAT_OPERATIONS.items()
    }
    monkeypatch.setattr(
        verifier,
        "request_json",
        lambda *_args, **_kwargs: verifier.HttpResult(200, {"paths": paths}),
    )
    verifier.verify_openapi("https://api.example.test", 1)

    del paths["/api/trips/{trip_id}/chat/messages"]["post"]
    with pytest.raises(verifier.VerificationError, match="post"):
        verifier.verify_openapi("https://api.example.test", 1)


def test_health_gate_requires_protocol_and_redacted_revision(monkeypatch):
    monkeypatch.setattr(
        verifier,
        "request_json",
        lambda *_args, **_kwargs: verifier.HttpResult(200, {
            "status": "ok",
            "revision": "1234567890ab",
            "chat_protocol_version": 1,
        }),
    )
    verifier.verify_health("https://api.example.test", 1)

    monkeypatch.setattr(
        verifier,
        "request_json",
        lambda *_args, **_kwargs: verifier.HttpResult(200, {
            "status": "ok",
            "revision": "1234567890abcdef",
            "chat_protocol_version": 1,
        }),
    )
    with pytest.raises(verifier.VerificationError, match="revision"):
        verifier.verify_health("https://api.example.test", 1)
