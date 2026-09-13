# UPI Payment Step 6 — Code Validation and Deferred Device Sign-off

Status: **code-ready; not released**. Step 6 does not authorize an APK build, deployment,
publication, production-data change, or real transfer. Native behavior and personal-recipient payment
sign-off remain pending until a build is separately authorized.

## Automated/local acceptance scope

- Backend authorization covers the exact initiating payer, a second payer-family account, the
  selected recipient, another recipient-family account, owner, admin, application super-admin,
  unrelated trip member, and outsider.
- A second payer-family account receives only
  `409 active_attempt_owned_by_another_payer`; the response contains no attempt, UPI snapshot, or
  payer reference, and the client performs no clipboard or launch action.
- Recipient-confirmed ledger amounts are immutable; remark-only editing remains available. Deletion
  requires a transaction that removes the payment and marks its audit attempt `voided`.
- The local Compose MongoDB is an idempotently initialized single-node replica set. A host-run backend
  connects with `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`. Transaction-
  incapable deployments continue to fail closed with a retryable `503`.
- Unresolved attempts retain the 24-hour expiry and active/confirmed attempts retain member-removal
  protection.

## Deferred physical-device matrix

Run every item on both **Android API 24** and **Android API 36** using consenting test accounts.

- [ ] Google Pay personal-recipient transfer: copied ID, displayed recipient, exact INR amount,
      authorization, and real recipient confirmation.
- [ ] Google Pay, PhonePe, Paytm, and BHIM are discovered only when installed and each app launches
      through its launcher activity.
- [ ] Missing app after discovery falls back to the copied ID without losing the saved attempt.
- [ ] Cancellation in each external app returns to an unchanged balance and allows **Not paid**.
- [ ] Native launch failure falls back to copy-only and exposes the paid/not-paid decision.
- [ ] A launch that never backgrounds Trip Splitter can use
      **App didn't open / continue manually**.
- [ ] Background/foreground return exposes the paid/not-paid decision exactly once.
- [ ] Process termination and restart restores the initiating payer's unresolved attempt.
- [ ] A recipient UPI ID changed after review forces a fresh review and approval.
- [ ] Disabled/failed notifications do not lose the in-app recipient confirmation request.
- [ ] A real recipient can report non-receipt, retry review, and close without a ledger post.
- [ ] No balance changes after copy, launch, app return, cancellation, or **I've paid** alone.
- [ ] Exactly one balance change occurs after recipient confirmation, including repeated/concurrent
      confirmation taps.

Record device model, OS/API level, app build identifier, installed UPI app versions, test account
roles, timestamps, and observed result for every check. Do not record UPI IDs, transaction references,
PINs, bank credentials, or other payment secrets in the report.
