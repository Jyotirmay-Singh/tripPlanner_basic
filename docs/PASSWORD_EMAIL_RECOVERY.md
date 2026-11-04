# Password recovery from a signed-in account

The Profile screen previously opened only the current-password form. Its email-recovery
screen existed inside the `(auth)` route group, but the root auth guard redirected signed-in
users away from that group. This made recovery hard to discover and unreachable without
signing out, especially for users who normally sign in with Google.

Profile now offers **Reset password by email**, and the current-password form includes
**Forgot password?**. Both open the existing recovery screen. The route guard permits
that specific recovery route for signed-in and signed-out users while preserving the
normal redirects for login, registration, and protected screens.

The recovery screen prefills a signed-in or asynchronously restored account email without
overwriting user edits. Requesting a link keeps the current session active and returns a
generic confirmation to prevent account enumeration. Disabled delivery is explained on the
screen. The existing email link opens a new-password/confirmation form that does not ask
for the previous password. Completing the reset consumes the single-use token and revokes
old sessions; a later login uses the new password.

The login form also submits the saved email displayed in its account card when that address
arrives after the initial render. Previously, a restored address could be displayed while
the form still submitted an empty email value.

Verification covers signed-in and signed-out recovery, unfinished Google accounts, restored
email prefill, edited addresses, validation, disabled delivery, request failures, single-use
tokens, rejected old credentials/sessions, and login with the new password. Browser checks
use a disposable local account and captured test inbox; production delivery must be checked
separately against an explicitly selected registered inbox.
