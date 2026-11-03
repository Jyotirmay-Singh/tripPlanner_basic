from unittest.mock import AsyncMock

from utils.auth_tokens import AuthTokenError
from utils.emailer import EmailDeliveryError


def test_invalid_and_missing_token(email_env, monkeypatch):
    env = email_env
    assert env.client.post('/api/auth/verify-email', json={}).status_code == 422
    result = env.client.post('/api/auth/verify-email', json={'token': 'unknown'})
    assert result.status_code == 400
    assert result.json()['detail']['code'] == 'email_link_invalid'
    assert env.client.post('/api/auth/resend-verification').status_code == 401


def test_registration_survives_provider_failure(email_env):
    env = email_env
    env.send.side_effect = EmailDeliveryError('provider_rejected')
    response = env.client.post('/api/auth/register', json={
        'email': 'created@gmail.com', 'name': 'Created', 'password': 'validpassword'})
    assert response.status_code == 200
    assert response.json()['verification_delivery'] == 'unavailable'
    assert response.json()['user']['email_verified'] is False
    assert len(env.db.users.docs) == 1


def test_resend_failure_has_retry_guidance(email_env):
    env = email_env
    env.db.users.docs.append({'_id': 1, 'id': 'u1', 'email': 'one@gmail.com', 'name': 'One',
                              'session_version': 0, 'email_verified': False})
    from utils.security import create_token
    env.send.side_effect = EmailDeliveryError('network')
    response = env.client.post('/api/auth/resend-verification', headers={
        'Authorization': 'Bearer ' + create_token('u1', 'one@gmail.com')})
    assert response.status_code == 503
    assert response.headers['retry-after'] == '60'
    assert response.json()['detail']['code'] == 'email_unavailable'
