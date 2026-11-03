from datetime import timedelta

from services.email_security_migration import migrate_email_security
from utils.auth_tokens import VERIFY_EMAIL, RESET_PASSWORD
from utils.security import verify_secret


def register(env, email='flow@gmail.com'):
    response = env.client.post('/api/auth/register', json={'email': email, 'name': 'Flow', 'password': 'originalpass'})
    assert response.status_code == 200, response.text
    return response.json()


def latest(env, purpose):
    return [raw for kind, raw in env.issued if kind == purpose][-1]


def bearer(token):
    return {'Authorization': 'Bearer ' + token}


def test_verification_journey_keeps_access_and_requires_post(email_env):
    env = email_env
    created = register(env)
    assert created['user']['email_verified'] is False
    assert env.client.get('/api/auth/me', headers=bearer(created['access_token'])).status_code == 200
    raw = latest(env, VERIFY_EMAIL)
    assert env.client.get('/api/auth/verify-email').status_code == 405
    assert not env.db.users.docs[0]['email_verified']
    response = env.client.post('/api/auth/verify-email', json={'token': raw})
    assert response.status_code == 200
    me = env.client.get('/api/auth/me', headers=bearer(created['access_token'])).json()
    assert me['email_verified'] is True
    assert me['email_verified_for'] == 'flow@gmail.com'
    assert me['email_verified_at']
    reused = env.client.post('/api/auth/verify-email', json={'token': raw})
    assert reused.status_code == 400
    assert reused.json()['detail']['code'] == 'email_link_used'


def test_reset_changes_password_and_revokes_old_sessions(email_env):
    env = email_env
    created = register(env)
    response = env.client.post('/api/auth/request-password-reset', json={'email': 'flow@gmail.com'})
    assert response.status_code == 200
    raw = latest(env, RESET_PASSWORD)
    env.client.post('/api/auth/reset-password', json={'token': raw, 'new_password': 'short'})
    assert not env.db.auth_tokens.docs[-1]['used']
    changed = env.client.post('/api/auth/reset-password', json={'token': raw, 'new_password': 'newpassword123'})
    assert changed.status_code == 200
    env.auth.chat_connections.revoke_user.assert_awaited_once_with(created['user']['id'])
    assert env.client.get('/api/auth/me', headers=bearer(created['access_token'])).status_code == 401
    assert env.client.post('/api/auth/login', json={'email': 'flow@gmail.com', 'password': 'originalpass'}).status_code == 401
    login = env.client.post('/api/auth/login', json={'email': 'flow@gmail.com', 'password': 'newpassword123'})
    assert login.status_code == 200
    assert env.client.get('/api/auth/me', headers=bearer(login.json()['access_token'])).status_code == 200
    reused = env.client.post('/api/auth/reset-password', json={'token': raw, 'new_password': 'anotherpassword'})
    assert reused.status_code == 400
    assert env.db.users.docs[0]['session_version'] == 1
    assert verify_secret('newpassword123', env.db.users.docs[0]['password_hash'])
    assert not env.db.users.docs[0]['email_verified']  # Resetting does not verify an address.


def test_expired_and_wrong_purpose_links(email_env):
    env = email_env
    register(env)
    raw = latest(env, VERIFY_EMAIL)
    wrong = env.client.post('/api/auth/reset-password', json={'token': raw, 'new_password': 'validpassword'})
    assert wrong.status_code == 400
    assert not env.db.auth_tokens.docs[0]['used']
    env.db.auth_tokens.docs[0]['expires_at'] -= timedelta(hours=1)
    expired = env.client.post('/api/auth/verify-email', json={'token': raw})
    assert expired.json()['detail']['code'] == 'email_link_expired'


def test_resend_cooldown_and_previous_link_replacement(email_env, monkeypatch):
    import utils.email_limits as limits
    env = email_env
    created = register(env)
    old = latest(env, VERIFY_EMAIL)
    blocked = env.client.post('/api/auth/resend-verification', headers=bearer(created['access_token']))
    assert blocked.status_code == 429
    assert 1 <= int(blocked.headers['retry-after']) <= 60
    later = limits._now() + timedelta(seconds=61)
    monkeypatch.setattr(limits, '_now', lambda: later)
    resent = env.client.post('/api/auth/resend-verification', headers=bearer(created['access_token']))
    assert resent.status_code == 200
    assert env.send.await_count == 2
    assert env.client.post('/api/auth/verify-email', json={'token': old}).status_code == 400
    assert env.client.post('/api/auth/verify-email', json={'token': latest(env, VERIFY_EMAIL)}).status_code == 200


def test_legacy_migration_is_idempotent_and_preserves_access(email_env):
    import asyncio
    from datetime import datetime, timezone
    env = email_env
    env.db.users.docs.extend([
        {'_id': 1, 'id': 'legacy', 'email': 'legacy@gmail.com', 'email_verified': True, 'password_hash': 'existing'},
        {'_id': 2, 'id': 'proved', 'email': 'proof@gmail.com', 'email_verified': True,
         'email_verified_for': 'proof@gmail.com', 'email_verified_at': datetime.now(timezone.utc),
         'email_verification_method': 'email_link'},
        {'_id': 3, 'id': 'changed', 'email': 'changed@gmail.com', 'email_verified': True,
         'email_verified_for': 'old@gmail.com', 'email_verified_at': datetime.now(timezone.utc),
         'email_verification_method': 'email_link'},
    ])
    env.db.auth_tokens.docs.append({'_id': 1, 'used': False, 'type': VERIFY_EMAIL})
    asyncio.run(migrate_email_security(env.db))
    asyncio.run(migrate_email_security(env.db))
    assert [u['email_verified'] for u in env.db.users.docs] == [False, True, False]
    assert env.db.users.docs[0]['password_hash'] == 'existing'
    assert env.db.users.docs[0]['session_version'] == 0
    assert env.db.auth_tokens.docs[0]['used'] is True
