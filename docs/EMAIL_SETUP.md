# EmailJS authentication email setup

Splitora uses server-side HTTPS requests to EmailJS for verification and password reset. The Gmail sender and agreed test inbox are teamsplitora@gmail.com. The application needs no custom domain.

## Release gate: sending remains disabled

Live authorization checks on 2026-11-03 found that, with non-browser access and Use Private Key enabled, both configured templates return HTTP 403 for missing/incorrect private keys without an Origin header, but HTTP 200 for an Origin-bearing request with no private key. Both accepted probes used only the agreed inbox and invalid tokens.

This fails the required protection against unauthorized use of authentication templates. Domain allowlists and hiding the public key are not substitutes for required private-key authentication. Do not enable EMAIL_FEATURES_ENABLED until EmailJS can reject every unauthorized request. Do not upgrade plans or change providers without the user's direction. No production authentication-email journey is claimed as verified while this gate fails.

## Account configuration

- Free account: 200 monthly requests, exactly two templates. Keep the provider footer required by the free plan.
- Gmail is connected through Google's official authorization flow; no Gmail password is stored by the application.
- Verification template: use backend/email_templates/verification.html; subject: Verify your {{app_name}} email.
- Reset template: use backend/email_templates/password-reset.html; subject: Reset your {{app_name}} password.
- Both templates: To Email {{to_email}}, From Name {{app_name}}, default Gmail From Email, Reply To the sender inbox, empty CC/BCC, no auto-reply or contact collection.
- Enable Do not save private data on both templates; template parameters must not appear in history. Disable analytics/tracking. The .txt files alongside the HTML are the required plain-text reference; inspect the received MIME alternative before signing off delivery.
- Enable non-browser API access with Use Private Key checked. The current browser-origin bypass described above must be resolved before rollout.

## Environment names (values are never recorded here)

Set these directly on the existing Render service, merging with other settings:

| Name | Purpose |
| --- | --- |
| EMAIL_FEATURES_ENABLED | Delivery rollout switch; keep disabled until authorization and deployment checks pass |
| APP_NAME | Sender display name and template branding |
| APP_URL | Trusted HTTPS web origin for action links |
| EMAILJS_SERVICE_ID | Connected Gmail service |
| EMAILJS_PUBLIC_KEY | EmailJS account identifier; keep server-side alongside the other sending settings |
| EMAILJS_PRIVATE_KEY | Required server authorization secret |
| EMAILJS_VERIFICATION_TEMPLATE_ID | Verification template |
| EMAILJS_RESET_TEMPLATE_ID | Password-reset template |

Sending settings must never use EXPO_PUBLIC_ names, enter mobile/browser bundles, appear in source control, or be logged. Resend credentials are no longer read. The production host's existing unrelated variables remain intact. Blueprint sync:false entries do not populate existing services; configure the names in Render explicitly.

## Authentication behavior

Tokens contain 256 random bits, are purpose-specific, and expire in 15 minutes. Only SHA-256 hashes are stored. MongoDB transactions bind issuance and consumption to the user and email, replace older tokens, roll back unsuccessful account changes, and make consumption single-use. Replica-set transaction support is required; no standalone fallback is permitted.

Opening an email link changes no account state. New links use URL fragments; the web client captures the token in memory and removes it from browser history. The action pages have no-store, no-referrer and no-index headers. Mobile email links use the hosted web fallback.

Verification stays optional for access. Legacy accounts without dated confirmation evidence for their current email become pending, without credential changes or access restrictions. Google sign-in establishes confirmation only when the verified claim is explicitly true. Old unbound links are invalidated.

A successful password reset updates the bcrypt hash, invalidates reset tokens, increments the session version and closes existing chat connections. Older version-zero JWTs remain valid until reset. Remote offline devices learn of revocation on their next server connection; no disconnected device can accept new server operations.

## Limits and failure handling

Mongo-backed limits survive restarts: ten email-flow requests per minute per trusted client IP; one send per 60 seconds and five sends per hour per normalized address/purpose. Unknown reset addresses use the same limits and public response. HTTP 429 includes Retry-After. Delivery requests are serialized at at most one per 1.05 seconds in the existing single-worker deployment; introducing multiple workers requires shared provider pacing first.

Registration survives mail failure. Authenticated resend failures give retry guidance; reset requests always return the same generic response. Provider exceptions, response bodies, recipient details and action links are never logged. An accepted EmailJS API request proves acceptance, not inbox delivery. Do not retry ambiguous sends automatically or repeatedly retry quota failures.

EmailJS's free account stops accepting sends when the monthly limit is exhausted. Monitor its usage notifications and dashboard. Gmail connection revocation/expiry requires the owner to reconnect through Google. Keep sending disabled during an authorization incident and verify both templates again after any security-setting change.

## Validation and deployment

Run the focused backend auth/provider suites and frontend recovery-screen tests, TypeScript, lint and web export. Automated delivery is mocked. The opt-in real Mongo suite uses only a local replica set on port 27019 and disposable email_auth_test_ databases; set EMAIL_AUTH_TEST_MONGO_URL for that suite.

Deploy through the existing main-branch workflow with email sending disabled. Verify both deployed revisions, the public capability flag, action-page headers and explicit confirmation behavior. Only after mandatory provider authorization passes should keys be supplied directly in Render and delivery enabled. Then use the agreed inbox for registration, one resend after cooldown, and reset; inspect HTML/plain text, complete both journeys, and verify old sessions fail while a fresh login works.

Never restore the retired link-logging fallback during troubleshooting or rollback.

References: https://www.emailjs.com/docs/rest-api/send/ and https://www.emailjs.com/pricing/.
