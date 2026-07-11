# Unit tests for utils/emailer.py::send_email + build_link + the html templates. Pure: the
# `resend` SDK is replaced with a spy and config flags (RESEND_API_KEY / SENDER_EMAIL / APP_URL)
# are monkeypatched, so no real network call and no real email ever leaves. This is the layer
# the mocked endpoint tests stub out — here we exercise the actual fallback + dispatch branches,
# including the "Resend unconfigured -> link only logged, no crash" config case.
import asyncio
import logging
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import utils.emailer as emailer  # noqa: E402

LOGGER_NAME = "trip-splitter"


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def mock_resend(monkeypatch):
    """Replace resend.Emails.send with a spy so a 'send' never touches the network."""
    send = MagicMock(return_value={"id": "email_123"})
    monkeypatch.setattr(emailer.resend.Emails, "send", send)
    return send


# --------------------------------------------------------------------------- #
# send_email — fallback (no key) branch: link logged, nothing sent, no crash
# --------------------------------------------------------------------------- #
def test_send_email_no_api_key_logs_link_and_skips_send(monkeypatch, mock_resend, caplog):
    monkeypatch.setattr(emailer, "RESEND_API_KEY", "")
    link = "https://app.example.com/verify-email?token=abc"
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        result = _run(emailer.send_email("u@gmail.com", "Subj", "<b>hi</b>", link_for_log=link))
    assert result is None                       # returns cleanly, never raises
    mock_resend.assert_not_called()             # no send attempted without a key
    assert any(f"link={link}" in r.message for r in caplog.records)  # link logged for offline flows


# --------------------------------------------------------------------------- #
# send_email — configured branch: dispatches via Resend with the right payload
# --------------------------------------------------------------------------- #
def test_send_email_with_key_dispatches_via_resend(monkeypatch, mock_resend):
    monkeypatch.setattr(emailer, "RESEND_API_KEY", "re_key")
    monkeypatch.setattr(emailer, "SENDER_EMAIL", "no-reply@tripsplitter.com")
    _run(emailer.send_email("u@gmail.com", "Verify", "<b>body</b>", link_for_log="lnk"))
    mock_resend.assert_called_once()
    payload = mock_resend.call_args.args[0]
    assert payload["from"] == "no-reply@tripsplitter.com"
    assert payload["to"] == ["u@gmail.com"]
    assert payload["subject"] == "Verify"
    assert payload["html"] == "<b>body</b>"


# --------------------------------------------------------------------------- #
# send_email — a Resend failure is swallowed (never surfaces to the caller)
# --------------------------------------------------------------------------- #
def test_send_email_swallows_send_failure(monkeypatch, mock_resend, caplog):
    monkeypatch.setattr(emailer, "RESEND_API_KEY", "re_key")
    mock_resend.side_effect = RuntimeError("resend down")
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        result = _run(emailer.send_email("u@gmail.com", "S", "<b>b</b>"))  # must NOT raise
    assert result is None
    assert any("Resend send failed" in r.message for r in caplog.records)


# --------------------------------------------------------------------------- #
# send_email — the link is logged even on the configured (dispatching) path
# --------------------------------------------------------------------------- #
def test_send_email_logs_link_even_when_dispatching(monkeypatch, mock_resend, caplog):
    monkeypatch.setattr(emailer, "RESEND_API_KEY", "re_key")
    link = "https://app.example.com/reset-password?token=t"
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        _run(emailer.send_email("u@gmail.com", "S", "<b>b</b>", link_for_log=link))
    assert any(f"link={link}" in r.message for r in caplog.records)
    mock_resend.assert_called_once()


# --------------------------------------------------------------------------- #
# build_link — deep link when APP_URL is set, bare token when it isn't
# --------------------------------------------------------------------------- #
def test_build_link_with_app_url(monkeypatch):
    monkeypatch.setattr(emailer, "APP_URL", "https://app.example.com")
    assert emailer.build_link("verify-email", "tok123") == \
        "https://app.example.com/verify-email?token=tok123"


def test_build_link_trims_trailing_slash(monkeypatch):
    monkeypatch.setattr(emailer, "APP_URL", "https://app.example.com/")
    assert emailer.build_link("reset-password", "tok") == \
        "https://app.example.com/reset-password?token=tok"


def test_build_link_without_app_url_returns_bare_token(monkeypatch):
    monkeypatch.setattr(emailer, "APP_URL", "")
    assert emailer.build_link("verify-email", "tok123") == "tok123"


# --------------------------------------------------------------------------- #
# html templates — each carries the link, the raw token, and the correct lifetime
# --------------------------------------------------------------------------- #
def test_verification_html_carries_token_link_and_24h():
    html = emailer.verification_html("Alice", "https://app/verify-email?token=abc", "abc")
    assert "https://app/verify-email?token=abc" in html
    assert "abc" in html
    assert "24 hours" in html
    assert "Alice" in html


def test_password_reset_html_carries_token_link_1h_and_pin_note():
    html = emailer.password_reset_html("Bob", "https://app/reset-password?token=xyz", "xyz")
    assert "https://app/reset-password?token=xyz" in html
    assert "xyz" in html
    assert "1 hour" in html
    assert "PIN is not affected" in html  # reset never touches the PIN
