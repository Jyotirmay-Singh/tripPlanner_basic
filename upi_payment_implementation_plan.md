# Friend-to-Friend UPI Payments: Android Implementation Plan

Goal: Let users provide their UPI ID during sign-in onboarding, view and change it in Profile, and settle expenses through an external UPI app. No QR-code uploads are required. Reuse the application's existing authentication, profile, expense ledger and notification systems.

## 1. ✅ Inspect the existing app and add UPI profile storage

- [x] Locate the sign-in/onboarding flow, user profile model, Profile tab, settlement logic and notification handlers before changing code.
- [x] Add `upi_id` and `upi_updated_at` to the existing user profile storage. Allow missing values for existing accounts during migration.
- [x] Validate input on both client and server: trim surrounding whitespace and reject malformed values, internal whitespace and control characters. Format validation is not proof of account existence or ownership; do not show a verified badge.

## 2. Collect the UPI ID during sign-in onboarding

- After successful authentication, show a “Set up your UPI ID” screen if the profile has no saved ID. This includes first-time Google sign-in and existing users signing in without a UPI ID.
- Explain: “Enter your UPI ID so friends can pay you directly. You can change it anytime in Profile.”
- Save the ID against the authenticated user before completing this onboarding step. On later sign-ins, reuse the saved value without asking again.
- Show inline validation errors and a retry option if saving fails. Do not treat a failed save as completed onboarding.
- Collect only the UPI ID; never request a UPI PIN, bank password or QR upload.

## 3. Add editable UPI details to the Profile tab

- Add a “Payment details” section displaying the saved UPI ID with Copy and Edit actions.
- Editing opens a prefilled field with Save and Cancel. Apply the same validation as onboarding, and show success only after the server accepts the change.
- Refresh the profile and future payment screens after a successful update. Keep the previous ID if saving fails.
- Fetch the latest recipient ID before starting a payment. If it changed while the payment screen was open, show the new ID and require the payer to review it again.
- Preserve the recipient UPI ID used for each existing payment attempt; a profile edit must not rewrite historical payment records.

## 4. Build the external payment handoff

- Add a “Pay via UPI” action to the existing settlement screen. Show recipient name, current UPI ID, amount in INR and the trip/expense context.
- Primary flow: “Copy UPI ID and open Google Pay” copies the ID and launches the installed app. Explain that the payer must paste the ID, review the recipient, enter the displayed amount and authorize payment there. Offer other supported installed UPI apps and a Copy-only fallback if launching fails.
- Google Pay supports personal payments by entering a UPI ID. [Official personal-payment instructions](https://support.google.com/pay/india/answer/16920555?hl=en)
- Optional convenience: generate a UPI QR locally from the saved recipient details using a standards-compatible URI builder and QR library. No upload is needed. Offer it as an alternative for scanning from another device; verify compatibility before release.
- Treat direct prefilled `upi://pay` handoff as an optional feature behind a feature flag, disabled until provider support for personal recipients is established and real-device testing passes. Google documents merchant prerequisites, so do not assume its merchant integration guarantees friend-to-friend support or fabricate merchant fields. [Google integration prerequisites](https://developers.google.com/pay/india/api/android/overview)
- Payment authorization stays inside the external app. Launching, returning or canceling must not change the expense balance.

## 5. Add recipient-confirmed settlement tracking

- Create a payment-attempt record with a unique ID, payer, recipient, trip, amount in integer paise, currency, recipient UPI ID snapshot, timestamps and status. Use existing settlement models where suitable.
- After returning, offer “I've paid” and “Not paid.” “I've paid” creates an awaiting-confirmation state and notifies the recipient through the existing notification system. A sender-entered transaction reference is optional and is not bank verification.
- Let only the recipient confirm receipt or report non-receipt. Persist pending requests in-app so notification delivery failure does not block confirmation.

| Event | Status | Ledger effect |
| --- | --- | --- |
| Payment screen opened or external app launched | Initiated | None |
| Sender reports payment | Awaiting confirmation | None; show a pending-payment notice to discourage paying again |
| Recipient confirms receipt | Settled — recipient confirmed | Apply the settlement exactly once |
| Recipient reports no receipt | Needs review | None; keep the debt outstanding |
| Sender cancels before reporting payment | Canceled | None |

- Make confirmation and ledger posting atomic and idempotent: repeated taps, retries or concurrent requests must not post the same settlement twice. Reconcile against the current ledger if other settlements occurred while confirmation was pending.
- Never auto-settle from an intent callback, screenshot or app return. Google requires provider-side checks even for a successful response; this implementation uses recipient confirmation and must label it accordingly. [Google payment verification guidance](https://developers.google.com/pay/india/api/android/in-app-payments)

## 6. Validate the complete flow and release the supported path

- Test new-user sign-in, existing users without an ID, returning users with an ID, malformed input, failed saves, Profile editing and persistence across app restarts.
- Verify that users cannot edit another profile, access unrelated users' payment details or confirm a payment meant for someone else.
- Test missing payment apps, launch failure, cancellation, app/process restart, stale recipient IDs and real personal-recipient payments on the Android versions supported by the app. Use consenting test users for real transfers.
- Verify that opening a payment app never changes balances; recipient confirmation posts exactly once; non-receipt preserves the debt; pending requests survive notification failure; and existing manual settlement behavior does not create duplicate entries.
- Release the copy-and-open flow with recipient confirmation as the baseline. Keep unconfirmed prefilled handoff disabled and any generated QR option subject to compatibility checks.

Completion criteria: Users enter their UPI ID during sign-in onboarding, see and edit it in Profile, use the latest saved ID for new payments, and settle balances only after recipient confirmation. No QR upload or payment gateway is required. Normal backend and notification costs remain.
