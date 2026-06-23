# Unit tests for utils/emailer.py::sender_mode_summary — the secret-free, one-line description
# of the active email delivery mode used by the startup log. Pure: no Mongo, no network, no send.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import utils.emailer as emailer  # noqa: E402


def test_mode_no_api_key(monkeypatch):
    # No RESEND_API_KEY => nothing is sent; links are only logged.
    monkeypatch.setattr(emailer, "RESEND_API_KEY", "")
    monkeypatch.setattr(emailer, "SENDER_EMAIL", "onboarding@resend.dev")
    msg = emailer.sender_mode_summary()
    assert msg.startswith("EMAIL:")
    assert "no RESEND_API_KEY" in msg
    assert "LOGGED" in msg


def test_mode_test_sender(monkeypatch):
    # Key set but still the resend.dev test sender => owner-only delivery, others fall back to logs.
    monkeypatch.setattr(emailer, "RESEND_API_KEY", "re_secret_key_value")
    monkeypatch.setattr(emailer, "SENDER_EMAIL", "onboarding@resend.dev")
    msg = emailer.sender_mode_summary()
    assert "test sender" in msg
    assert "onboarding@resend.dev" in msg


def test_mode_test_sender_is_case_and_space_insensitive(monkeypatch):
    monkeypatch.setattr(emailer, "RESEND_API_KEY", "re_secret_key_value")
    monkeypatch.setattr(emailer, "SENDER_EMAIL", "  Onboarding@Resend.Dev  ")
    assert "test sender" in emailer.sender_mode_summary()


def test_mode_live_sender(monkeypatch):
    # Key set + a custom domain sender => live delivery to all recipients.
    monkeypatch.setattr(emailer, "RESEND_API_KEY", "re_secret_key_value")
    monkeypatch.setattr(emailer, "SENDER_EMAIL", "no-reply@tripsplitter.com")
    msg = emailer.sender_mode_summary()
    assert "live sender" in msg
    assert "no-reply@tripsplitter.com" in msg


def test_summary_never_leaks_the_api_key(monkeypatch):
    secret = "re_super_secret_DO_NOT_LEAK"
    monkeypatch.setattr(emailer, "RESEND_API_KEY", secret)
    for sender in ("onboarding@resend.dev", "no-reply@tripsplitter.com"):
        monkeypatch.setattr(emailer, "SENDER_EMAIL", sender)
        assert secret not in emailer.sender_mode_summary()
