import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

import utils.emailer as emailer


@pytest.fixture
def configured(monkeypatch):
    for name in ['EMAILJS_SERVICE_ID', 'EMAILJS_PUBLIC_KEY', 'EMAILJS_PRIVATE_KEY',
                 'EMAILJS_VERIFICATION_TEMPLATE_ID', 'EMAILJS_RESET_TEMPLATE_ID']:
        monkeypatch.setattr(emailer, name, name.lower())
    monkeypatch.setattr(emailer, 'APP_URL', 'https://app.example.com')
    monkeypatch.setattr(emailer, '_send_lock', asyncio.Lock())
    monkeypatch.setattr(emailer, '_last_send', 0.0)
    post = AsyncMock(return_value=SimpleNamespace(status_code=200, text='DO-NOT-LOG-RAW-TOKEN'))
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=SimpleNamespace(post=post))
    client.__aexit__ = AsyncMock(return_value=False)
    constructor = MagicMock(return_value=client)
    monkeypatch.setattr(emailer.httpx, 'AsyncClient', constructor)
    return post, constructor


@pytest.mark.parametrize('purpose,path,key,template', [
    ('verify_email', 'verify-email', 'verification_url', 'emailjs_verification_template_id'),
    ('reset_password', 'reset-password', 'reset_url', 'emailjs_reset_template_id'),
])
def test_private_authorization_and_backend_selected_recipient(configured, purpose, path, key, template, caplog):
    post, constructor = configured
    link = emailer.build_link(path, 'RAW-TOKEN')
    assert link == 'https://app.example.com/' + path + '#token=RAW-TOKEN'
    asyncio.run(emailer.send_auth_email('account@gmail.com', purpose, link))
    url = post.call_args.args[0]
    payload = post.call_args.kwargs['json']
    assert url == emailer.EMAILJS_URL
    assert payload['accessToken'] == 'emailjs_private_key'
    assert payload['template_id'] == template
    assert payload['template_params'] == {'to_email': 'account@gmail.com', 'app_name': 'Splitora', key: link}
    assert constructor.call_args.kwargs == {'timeout': 10.0, 'follow_redirects': False}
    assert 'RAW-TOKEN' not in caplog.text
    assert 'emailjs_private_key' not in caplog.text


@pytest.mark.parametrize('url', ['', 'http://app.example.com', 'https://user:secret@app.example.com',
                                 'https://app.example.com/elsewhere', 'https://app.example.com?evil=1'])
def test_untrusted_or_missing_application_url_fails_closed(monkeypatch, url):
    monkeypatch.setattr(emailer, 'APP_URL', url)
    with pytest.raises(emailer.EmailDeliveryError): emailer.build_link('verify-email', 'RAW')


def test_unconfigured_never_sends_or_logs_link(configured, monkeypatch, caplog):
    monkeypatch.setattr(emailer, 'EMAILJS_PRIVATE_KEY', '')
    with pytest.raises(emailer.EmailDeliveryError):
        asyncio.run(emailer.send_auth_email('account@gmail.com', 'verify_email', emailer.build_link('verify-email', 'RAW')))
    configured[0].assert_not_awaited()
    assert 'RAW' not in caplog.text


@pytest.mark.parametrize('status', [401, 403, 412, 429, 500])
def test_provider_rejections_do_not_log_response_content(configured, caplog, status):
    post, _ = configured
    post.return_value.status_code = status
    with pytest.raises(emailer.EmailDeliveryError):
        asyncio.run(emailer.send_auth_email('account@gmail.com', 'verify_email', emailer.build_link('verify-email', 'RAW')))
    assert str(status) in caplog.text
    assert 'DO-NOT-LOG' not in caplog.text
    assert 'RAW' not in caplog.text


def test_network_errors_are_sanitized(configured, caplog):
    configured[0].side_effect = httpx.ReadTimeout('secret=RAW-TOKEN')
    with pytest.raises(emailer.EmailDeliveryError):
        asyncio.run(emailer.send_auth_email('account@gmail.com', 'verify_email', emailer.build_link('verify-email', 'RAW')))
    assert 'RAW' not in caplog.text


def test_sends_are_serialized_and_paced(configured, monkeypatch):
    sleeps = []
    async def sleep(delay): sleeps.append(delay)
    monkeypatch.setattr(emailer.asyncio, 'sleep', sleep)
    monkeypatch.setattr(emailer.time, 'monotonic', lambda: 100.0)
    async def scenario():
        link = emailer.build_link('verify-email', 'RAW')
        await asyncio.gather(*[emailer.send_auth_email('account@gmail.com', 'verify_email', link) for _ in range(3)])
    asyncio.run(scenario())
    assert sleeps == [0, 1.05, 1.05]
