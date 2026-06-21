// Email domain validation — keep in sync with backend/utils/email_rules.py
export const ALLOWED_EMAIL_DOMAIN = 'gmail.com';

export const GMAIL_ONLY_MESSAGE = `Only @${ALLOWED_EMAIL_DOMAIN} email addresses are allowed`;

export function isGmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e) return true; // empty handled separately by required-field checks
  return e.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

// Account-password rule — keep in sync with backend (routes/auth.py MIN_PASSWORD_LENGTH).
// Length-only: minimum 9 characters, no uppercase/number/symbol complexity requirements.
export const MIN_PASSWORD_LENGTH = 9;

export const PASSWORD_TOO_SHORT_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
export const PASSWORD_MISMATCH_MESSAGE = 'Passwords do not match';

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}
