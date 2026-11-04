from datetime import datetime, timezone

import pytest

from utils.auth_tokens import RESET_PASSWORD, VERIFY_EMAIL, issue_token
from utils.security import hash_secret

GENERIC = {'ok': True, 'message': 'If this email exists, recovery instructions have been sent.'}


def seed(env, *, verified=False, method='email_link'):
    user = {'_id': 1, 'id': 'recovery', 'name': 'Recovery', 'email': 'recovery@gmail.com',
            'password_hash': hash_secret('originalpass123'), 'session_version': 0,
            'credentials_set': True, 'email_verified': verified}
    if verified:
        user.update(email_verified_for=user['email'], email_verified_at=datetime.now(timezone.utc),
                    email_verification_method=method)
    env.db.users.docs.append(user)
    return user


def request(env, email='recovery@gmail.com'):
    response = env.client.post('/api/auth/request-password-reset', json={'email': email})
    assert response.status_code == 200
    assert response.json() == GENERIC
    return response


def latest(env, purpose):
    return [raw for kind, raw in env.issued if kind == purpose][-1]


def test_signed_out_unverified_recovery_verifies_before_reset(email_env):
    env = email_env
    seed(env)
    login = env.client.post('/api/auth/login', json={'email': 'recovery@gmail.com', 'password': 'originalpass123'}).json()
    request(env)
    assert [kind for kind, _ in env.issued] == [VERIFY_EMAIL]
    assert env.send.await_args.args[1] == VERIFY_EMAIL
    verification = latest(env, VERIFY_EMAIL)
    wrong_purpose = env.client.post('/api/auth/reset-password', json={'token': verification, 'new_password': 'changedpass123'})
    assert wrong_purpose.status_code == 400
    assert not env.db.users.docs[0]['email_verified']
    verified = env.client.post('/api/auth/verify-email', json={'token': verification})
    assert verified.json() == {'ok': True, 'password_reset_email': 'recovery@gmail.com'}
    assert env.db.users.docs[0]['email_verified'] is True
    # The first request did not exhaust the reset-email cooldown.
    request(env)
    assert [kind for kind, _ in env.issued] == [VERIFY_EMAIL, RESET_PASSWORD]
    reset = latest(env, RESET_PASSWORD)
    assert env.client.post('/api/auth/reset-password', json={'token': reset, 'new_password': 'changedpass123'}).status_code == 200
    assert env.client.get('/api/auth/me', headers={'Authorization': 'Bearer ' + login['access_token']}).status_code == 401
    assert env.client.post('/api/auth/login', json={'email': 'recovery@gmail.com', 'password': 'originalpass123'}).status_code == 401
    assert env.client.post('/api/auth/login', json={'email': 'recovery@gmail.com', 'password': 'changedpass123'}).status_code == 200
    assert env.client.post('/api/auth/reset-password', json={'token': reset, 'new_password': 'anotherpass123'}).status_code == 400


@pytest.mark.parametrize('method', ['google', 'email_link'])
def test_verified_accounts_receive_reset_without_another_verification(email_env, method):
    env = email_env
    seed(env, verified=True, method=method)
    request(env)
    assert [kind for kind, _ in env.issued] == [RESET_PASSWORD]
    assert env.send.await_args.args[1] == RESET_PASSWORD


def test_existing_registration_link_continues_recovery_during_cooldown(email_env):
    env = email_env
    created = env.client.post('/api/auth/register', json={
        'email': 'recovery@gmail.com', 'name': 'Recovery', 'password': 'originalpass123',
    })
    assert created.status_code == 200
    original_verification = latest(env, VERIFY_EMAIL)
    request(env)
    assert env.send.await_count == 1
    assert [kind for kind, _ in env.issued] == [VERIFY_EMAIL]
    response = env.client.post('/api/auth/verify-email', json={'token': original_verification})
    assert response.json() == {'ok': True, 'password_reset_email': 'recovery@gmail.com'}
    request(env)
    assert env.send.await_count == 2
    assert env.issued[-1][0] == RESET_PASSWORD


def test_legacy_reset_link_cannot_bypass_verification_or_burn_token(email_env):
    import asyncio
    env = email_env
    seed(env)
    raw = asyncio.run(issue_token('recovery', RESET_PASSWORD))
    before = env.db.users.docs[0]['password_hash']
    response = env.client.post('/api/auth/reset-password', json={'token': raw, 'new_password': 'changedpass123'})
    assert response.status_code == 400
    assert response.json()['detail']['code'] == 'email_link_verification_required'
    assert not env.db.auth_tokens.docs[0]['used']
    assert env.db.users.docs[0]['password_hash'] == before
    assert env.db.users.docs[0]['session_version'] == 0


def test_verification_is_checked_again_when_reset_link_is_consumed(email_env):
    env = email_env
    seed(env, verified=True)
    request(env)
    env.db.users.docs[0]['email_verified_for'] = 'different@gmail.com'
    response = env.client.post('/api/auth/reset-password', json={
        'token': latest(env, RESET_PASSWORD), 'new_password': 'changedpass123',
    })
    assert response.json()['detail']['code'] == 'email_link_verification_required'
    assert not env.db.auth_tokens.docs[0]['used']
    assert env.db.users.docs[0]['session_version'] == 0


def test_generic_request_does_not_reveal_existence_or_verification(email_env):
    env = email_env
    seed(env)
    unverified = request(env).content
    unknown = request(env, 'unknown@gmail.com').content
    env.db.users.docs[0].update(email_verified=True, email_verified_for='recovery@gmail.com',
                              email_verified_at=datetime.now(timezone.utc), email_verification_method='google')
    verified = request(env).content
    assert unverified == unknown == verified
    assert len(env.db.auth_tokens.docs) == 2


def test_normal_verification_does_not_add_recovery_or_send_reset_email(email_env):
    env = email_env
    env.client.post('/api/auth/register', json={
        'email': 'recovery@gmail.com', 'name': 'Recovery', 'password': 'originalpass123',
    })
    response = env.client.post('/api/auth/verify-email', json={'token': latest(env, VERIFY_EMAIL)})
    assert response.json() == {'ok': True}
    assert env.send.await_count == 1
