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

// Per-trip email uniqueness mirror — keep in sync with backend
// utils/members.py::assert_unique_email_in_trip (one gmail == at most one person per trip). The
// server is authoritative; this only gives inline UX feedback on the member create/edit forms.
// `taken` is the set of emails already on the trip (member linked emails), excluding the row being
// edited. Empty input is deferred to the required/format checks.
export const DUPLICATE_EMAIL_MESSAGE = 'This email is already used by someone on this trip';

export function isEmailTaken(email: string, taken: (string | null | undefined)[]): boolean {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  return taken.some((t) => (t ?? '').trim().toLowerCase() === e);
}
