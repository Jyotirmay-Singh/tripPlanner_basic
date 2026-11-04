from utils.emailer import EmailDeliveryError

GENERIC = {'ok': True, 'message': 'If this email exists, recovery instructions have been sent.'}


def test_known_unknown_throttled_and_delivery_failure_share_response(email_env):
    env = email_env
    env.db.users.docs.append({'_id': 1, 'id': 'u1', 'email': 'real@gmail.com'})
    for address in ['real@gmail.com', 'unknown@gmail.com', 'real@gmail.com', 'unknown@gmail.com']:
        response = env.client.post('/api/auth/request-password-reset', json={'email': address})
        assert response.status_code == 200
        assert response.json() == GENERIC
    assert env.send.await_count == 1
    env.send.side_effect = EmailDeliveryError('provider_rejected')
    env.db.users.docs.append({'_id': 2, 'id': 'u2', 'email': 'failure@gmail.com'})
    assert env.client.post('/api/auth/request-password-reset', json={'email': 'failure@gmail.com'}).json() == GENERIC


def test_password_policy_precedes_token_consumption(email_env):
    response = email_env.client.post('/api/auth/reset-password', json={'token': 'unknown', 'new_password': 'short'})
    assert response.status_code == 400
    assert response.json()['detail'] == 'Password must be at least 9 characters'
    assert not email_env.db.auth_tokens.docs


def test_unknown_and_wrong_tokens_do_not_change_password(email_env):
    env = email_env
    env.db.users.docs.append({'_id': 1, 'id': 'u1', 'email': 'real@gmail.com', 'password_hash': 'unchanged'})
    response = env.client.post('/api/auth/reset-password', json={'token': 'unknown', 'new_password': 'validpassword'})
    assert response.status_code == 400
    assert env.db.users.docs[0]['password_hash'] == 'unchanged'
