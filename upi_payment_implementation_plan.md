# Friend-to-Friend UPI Payments: Android Implementation Plan

Goal: Let users optionally provide their UPI ID while creating an account, view and change it in Profile, and settle expenses through an external UPI app. No QR-code uploads are required. Reuse the application's existing authentication, profile, expense ledger and notification systems.

## 1. ✅ Inspect the existing app and add UPI profile storage

- [x] Locate the sign-in/onboarding flow, user profile model, Profile tab, settlement logic and notification handlers before changing code.
- [x] Add `upi_id` and `upi_updated_at` to the existing user profile storage. Allow missing values for existing accounts during migration.
- [x] Validate input on both client and server: trim surrounding whitespace and reject malformed values, internal whitespace and control characters. Format validation is not proof of account existence or ownership; do not show a verified badge.

## 2. ✅ Offer optional UPI setup to new accounts and add a Profile entry

- [x] Offer “Set up your UPI ID” after password registration, or after a first-time Google user creates their required local password. Existing sign-ins and restored sessions are not prompted.
- [x] Explain: “Enter your UPI ID so friends can pay you directly. You can change it anytime in Profile.”
- [x] Let users save or explicitly skip, including after a failed save. The optional prompt is kept only in memory and is not recreated after an app restart.
- [x] Preserve validated invite returns through Save or Skip; otherwise continue to Home.
- [x] Show inline validation/server errors, preserve the typed value, and expose a retry action without presenting a failed request as successful.
- [x] Add a Profile “Payment details” entry where every user can add, edit, cancel, or confirm removal of their UPI ID.
- [x] Collect only the UPI ID; never request a UPI PIN, bank password, or QR upload. Syntax validation is not proof of ownership.

## 3. ✅ Complete payment-facing Profile integration

- [x] Add a Copy action to the implemented “Payment details” entry.
- [x] Keep the implemented prefilled Save, Cancel, and confirmed Remove behavior; show success only after the server accepts a change.
- [x] Refresh the profile and future payment screens after a successful update. Keep the previous ID if saving fails.
- [x] Fetch the latest recipient ID before starting a payment. If it changed while the payment screen was open, show the new ID and require the payer to review it again.
- [x] Preserve the reviewed recipient UPI ID in the in-memory handoff attempt and ensure a profile edit never rewrites payment records. Persistent historical attempt snapshots remain part of Step 5.

## 4. ✅ Build the external payment handoff

- [x] Add a “Pay via UPI” action to the existing settlement screen. Show recipient name, current UPI ID, amount in INR and the trip context.
- [x] Implement the primary “Copy UPI ID and open Google Pay” flow, other supported installed UPI apps, and a Copy-only fallback when discovery or launching fails.
- [x] Add explicit in-sheet guidance that the payer must paste the copied ID, verify the recipient, enter the displayed INR amount and authorize the payment in the external app.
- [x] Support Google Pay personal payments by handing off only a copied UPI ID. [Official personal-payment instructions](https://support.google.com/pay/india/answer/16920555?hl=en)
- [x] Exclude optional local UPI QR generation from Step 4. It may be reconsidered later only after compatibility review; no upload is required.
- [x] Exclude direct prefilled `upi://pay` handoff and payment-field intents from Step 4. Do not fabricate merchant fields or infer friend-to-friend support from merchant integration documentation. [Google integration prerequisites](https://developers.google.com/pay/india/api/android/overview)
- [x] Keep payment authorization inside the external app. Copying, launching, returning or canceling must not create a payment record or change the expense balance.

## 5. ✅ Add recipient-confirmed settlement tracking

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

## 6. Validate and harden the complete flow (native sign-off pending)

- Test optional new-account setup, Skip, existing/restored users without an ID, returning users with an ID, malformed input, failed saves, Profile editing, and the non-persistence of unfinished onboarding across app restarts.
- Verify that users cannot edit another profile, access unrelated users' payment details or confirm a payment meant for someone else.
- Test missing payment apps, launch failure, cancellation, app/process restart, stale recipient IDs and real personal-recipient payments on the Android versions supported by the app. Use consenting test users for real transfers.
- Verify that opening a payment app never changes balances; recipient confirmation posts exactly once; non-receipt preserves the debt; pending requests survive notification failure; and existing manual settlement behavior does not create duplicate entries.
- Do not release the copy-and-open flow until the API 24/API 36 physical-device checklist in
  `docs/UPI_PAYMENT_QA.md` is signed off. The implementation remains code-ready only: no Step 6 APK,
  deployment, publication, real-transfer claim, or bank-verification claim has been made.

Authorization policy: only an account linked to the recommended payer can create a handoff, and an
attempt remains owned by that exact initiating account. Every account linked to the receiving family,
plus the trip owner/admin and application super-admin, can list full incoming attempts and perform
recipient review. Unrelated trip members and outsiders cannot access those details. Administrators may
inspect current recipient UPI details but cannot initiate on behalf of an unrelated payer.

Completion criteria: New users may enter or skip a UPI ID during account creation, all users can manage it in Profile, new payments use the latest saved ID, and balances settle only after recipient confirmation. No QR upload or payment gateway is required. Normal backend and notification costs remain.
