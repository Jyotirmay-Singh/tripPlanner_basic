# EmailJS authentication email setup

Splitora uses server-side HTTPS requests to EmailJS for verification and password reset. The Gmail sender and agreed test inbox are teamsplitora@gmail.com. The application needs no custom domain.

## Interim rollout authorized by the owner

Live authorization checks on 2026-11-03 found that, with non-browser access and Use Private Key enabled, both configured templates return HTTP 403 for missing/incorrect private keys without an Origin header, but HTTP 200 for an Origin-bearing request with no private key. Both accepted probes used only the agreed inbox and invalid tokens.

This fails the original requirement that every send must require private-key authorization. On 2026-11-04, after contacting EmailJS support, the owner explicitly authorized enabling automatic verification and password-reset emails with this known limitation while awaiting the support response. This instruction supersedes the earlier release hold for the provider authorization check. It does not establish that the provider authorization issue is fixed.

Keep the existing non-browser/private-key settings enabled and supply the private key on every backend send. Keep all EmailJS identifiers and credentials on Render. Preserve token validation, transactions, rate limits, and sanitized logging. Domain allowlists and hiding the public key do not replace required private-key authorization. Do not upgrade plans or change providers without the owner's direction. Confirm operational delivery and the current rollout flag separately before claiming activation or a successful inbox journey.

## Account configuration

- Free account: 200 monthly requests, exactly two templates. Keep the provider footer required by the free plan.
- Gmail is connected through Google's official authorization flow; no Gmail password is stored by the application.
- Verification template: use backend/email_templates/verification.html; subject: Verify your {{app_name}} email.
- Reset template: use backend/email_templates/password-reset.html; subject: Reset your {{app_name}} password.
- Both templates: To Email {{to_email}}, From Name {{app_name}}, default Gmail From Email, Reply To the sender inbox, empty CC/BCC, no auto-reply or contact collection.
- Enable Do not save private data on both templates; template parameters must not appear in history. Disable analytics/tracking. The .txt files alongside the HTML are the required plain-text reference; inspect the received MIME alternative before signing off delivery.
- Enable non-browser API access with Use Private Key checked. The browser-origin authorization limitation above remains open with EmailJS support; the owner has accepted it for this interim rollout.

## Environment names (values are never recorded here)

Set these directly on the existing Render service, merging with other settings:

| Name | Purpose |
| --- | --- |
| EMAIL_FEATURES_ENABLED | Delivery rollout switch; enable only after configuration and operational checks, subject to the owner's rollout decision above |
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

When email features are enabled, new and existing unverified accounts see the same dashboard reminder. Its cross button hides it for the current app session, including tab changes and profile refreshes. It returns after a new sign-in, an app restart/web reload, or a change of email address if verification is still pending. Verified accounts see no reminder. Showing or closing the reminder sends no email; resend requires an explicit press. No scheduled reminder emails are sent.

A successful password reset updates the bcrypt hash, invalidates reset tokens, increments the session version and closes existing chat connections. Older version-zero JWTs remain valid until reset. Remote offline devices learn of revocation on their next server connection; no disconnected device can accept new server operations.

## Limits and failure handling

Mongo-backed limits survive restarts: ten email-flow requests per minute per trusted client IP; one send per 60 seconds and five sends per hour per normalized address/purpose. Unknown reset addresses use the same limits and public response. HTTP 429 includes Retry-After. Delivery requests are serialized at at most one per 1.05 seconds in the existing single-worker deployment; introducing multiple workers requires shared provider pacing first.

Registration survives mail failure. Authenticated resend failures give retry guidance; reset requests always return the same generic response. Provider exceptions, response bodies, recipient details and action links are never logged. An accepted EmailJS API request proves acceptance, not inbox delivery. Do not retry ambiguous sends automatically or repeatedly retry quota failures.

EmailJS's free account stops accepting sends when the monthly limit is exhausted. Monitor its usage notifications and dashboard. Gmail connection revocation/expiry requires the owner to reconnect through Google. Keep sending disabled during an authorization incident and verify both templates again after any security-setting change.

## Validation and deployment

Run the focused backend auth/provider suites and frontend recovery-screen tests, TypeScript, lint and web export. Automated delivery is mocked. The opt-in real Mongo suite uses only a local replica set on port 27019 and disposable email_auth_test_ databases; set EMAIL_AUTH_TEST_MONGO_URL for that suite.

Deploy through the existing main-branch workflow, preserving the existing non-email configuration. Provision EmailJS credentials directly in Render; never copy their values into this document. Verify deployed revisions, action-page headers, database readiness, and explicit confirmation behavior. For the owner-authorized interim rollout, activate sending despite the documented provider authorization limitation, then use the agreed inbox for registration, one resend after cooldown, and reset. Inspect HTML/plain text, complete both journeys, and verify old sessions fail while a fresh login works. Confirm the public capability flag after the configuration deployment and record verified delivery separately from provider acceptance.

To disable sending safely, set EMAIL_FEATURES_ENABLED=false on the existing Render service and deploy the configuration change. Verify /api/meta/config reports email_features_enabled=false. This stops automatic registration/reset sends and hides the dashboard reminder and forgot-password entry point; existing credentials and account access remain intact. Disabling this application flag does not revoke the EmailJS templates or prevent direct provider requests; an incident involving provider access also requires action in EmailJS.

Never restore the retired link-logging fallback during troubleshooting or rollback.

References: https://www.emailjs.com/docs/rest-api/send/ and https://www.emailjs.com/pricing/.
