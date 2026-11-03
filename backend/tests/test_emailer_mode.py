import utils.emailer as emailer


def test_summary_never_contains_secrets(monkeypatch):
    names = ['EMAILJS_SERVICE_ID', 'EMAILJS_PUBLIC_KEY', 'EMAILJS_PRIVATE_KEY',
             'EMAILJS_VERIFICATION_TEMPLATE_ID', 'EMAILJS_RESET_TEMPLATE_ID']
    for name in names: monkeypatch.setattr(emailer, name, 'sensitive-value')
    assert emailer.sender_mode_summary() == 'EMAIL: EmailJS configured'
    assert 'sensitive-value' not in emailer.sender_mode_summary()
    monkeypatch.setattr(emailer, 'EMAILJS_PRIVATE_KEY', '')
    assert 'configuration incomplete' in emailer.sender_mode_summary()
