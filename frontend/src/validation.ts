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
// Soft, persistent helper hint (vs the hard error message above) shown under new-password fields.
export const PASSWORD_HINT_MESSAGE = `Use at least ${MIN_PASSWORD_LENGTH} characters`;

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}

// UPI/VPA format validation — keep in sync with backend/utils/upi_rules.py.
// This checks syntax only and must never be presented as account verification.
export const UPI_ID_INVALID_MESSAGE = 'Enter a valid UPI ID, for example name@bank';

const UPI_ID_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9]{2,64}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F-\u009F]/;

export function normalizeUpiId(value: string): string {
  return value.trim();
}

export function isValidUpiId(value: string): boolean {
  // Inspect the raw value first so trim cannot hide tabs/newlines at an edge.
  if (CONTROL_CHARACTER_RE.test(value)) return false;
  return UPI_ID_RE.test(normalizeUpiId(value));
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
