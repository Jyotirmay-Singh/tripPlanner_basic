def test_disabled_email_never_proves_ownership_or_sends(email_env, monkeypatch):
    env = email_env
    import routes.meta as meta
    monkeypatch.setattr(env.auth, 'EMAIL_FEATURES_ENABLED', False)
    monkeypatch.setattr(meta, 'EMAIL_FEATURES_ENABLED', False)
    response = env.client.post('/api/auth/register', json={
        'email': 'disabled@gmail.com', 'name': 'Disabled', 'password': 'validpassword'})
    assert response.status_code == 200
    assert response.json()['user']['email_verified'] is False
    assert response.json()['verification_delivery'] == 'disabled'
    assert not env.db.auth_tokens.docs
    assert env.client.get('/api/meta/config').json()['email_features_enabled'] is False
    assert env.client.post('/api/auth/request-password-reset', json={'email': 'disabled@gmail.com'}).status_code == 200
    assert not env.db.auth_tokens.docs
    env.send.assert_not_awaited()


def test_enabled_capability(email_env):
    assert email_env.client.get('/api/meta/config').json()['email_features_enabled'] is True
