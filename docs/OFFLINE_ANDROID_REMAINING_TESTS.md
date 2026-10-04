# Android offline QA: remaining and failed checks

**Handoff date:** 2026-09-28. Use this file to run one check at a time in a later conversation. The fuller record of completed tests is in [OFFLINE_ANDROID_QA_RUNBOOK.md](OFFLINE_ANDROID_QA_RUNBOOK.md). Do not treat a source test as proof that the installed APK contains the latest source changes.

## Starting point and boundaries

- The installed side-by-side test app is **Trip Splitter QA**, package `com.tripsplitter.app.qa`. Use only the isolated QA trip and accounts. Do not uninstall or clear `com.tripsplitter.app`, the user's production app.
- The QA API uses `http://127.0.0.1:8000` and the replica-set database `trip_splitter_qa_local_20260925` at `127.0.0.1:27018`. Its config advertised expense and payment create protocol versions `1` on 2026-09-28. Test account credentials are in ignored `.release-tmp/offline-qa-accounts.json`; do not print passwords or tokens.
- The 2026-09-29 preflight found one pre-existing **Conversion review needed** row in the Trips queue. With user authorization, its synthetic QA conversion was approved: exactly one server expense and durable mutation receipt appeared, the local row cleared, and only that new expense was deleted. The receipt remains for replay protection. The queue is empty before the fresh APK update. Private evidence is in ignored `.release-tmp/qa-everyday-20260928-2350/`.
- The moto g54 5G was connected and authorized during the 2026-09-29 preflight. Recheck `adb devices -l` and restore the `adb reverse` mapping for each new phone test.
- After the pre-existing queue row is resolved, build a fresh QA APK from the 2026-09-28 source for this device journey and verify its signer before `adb install -r`. Keep the production package, build 17, and `/download/android` untouched.
- The `rtk` command required by the repository instructions was unavailable in this PowerShell session. The commands below are shown in their runnable form; try `rtk` first in a future session and use raw commands only if it is still unavailable.

### Preflight for each phone check

From `D:\projects\tripPlanner`, run:

```powershell
adb devices -l
adb shell pm path com.tripsplitter.app.qa
adb reverse tcp:8000 tcp:8000
$config = Invoke-RestMethod http://127.0.0.1:8000/api/meta/config
$config | Select-Object expense_create_protocol_version,payment_create_protocol_version,multi_currency_expenses_enabled
```

Stop the phone check if ADB has no authorized device, the QA package is absent, or either local create protocol is not `1`. Start the isolated MongoDB and backend as described in the [QA runbook](OFFLINE_ANDROID_QA_RUNBOOK.md#qa-apk-and-local-backend) if needed. Confirm the test trip opens online and record its expense/payment counts and confirmed balances before changing anything. Check the Trips queue for leftover pending rows.

For a genuine offline interval, remove USB forwarding **before** enabling airplane mode. Restore both afterward, even if a check fails:

```powershell
adb reverse --remove tcp:8000
adb shell cmd connectivity airplane-mode enable
# Perform the offline steps in the QA app.
adb shell cmd connectivity airplane-mode disable
adb reverse tcp:8000 tcp:8000
```

Record the test description, account, captured amount/split, before/after server counts, mutation ID where observable, canonical ID if accepted, second-account observation, and any review reason. Screenshots and private evidence belong in ignored `.release-tmp`; keep credentials and database keys out of logs. Restore the phone's connectivity and clean up disposable server records after each test. A pending row must be discarded explicitly only **after** its result is verified.

## Remaining phone checks

### D01 — Expired currency quote

**Status:** Open on phone. Fresh USD quote approval and delivery already passed. Unit tests cover expired/mismatched quotes. Server quotes last 30 minutes.

1. Note the QA trip's expense count and confirmed totals. Queue a uniquely named USD 1 expense in airplane mode. Confirm **Conversion review needed** and no change to confirmed totals.
2. Reconnect and open its pending detail. Wait for the quote. Record the displayed USD amount, INR amount, rate, reference date, and expiry time. Do **not** approve it.
3. Keep that detail open until more than 30 minutes have elapsed. Attempt **Use this conversion** if still shown. The app must refuse the expired approval; the backend must still have no expense or mutation receipt for this entry.
4. Request a current quote, approve it explicitly, and verify exactly one server expense and receipt with the original USD amount/currency. Verify account B's independent view, then delete only this accepted test expense if cleanup is desired.

If the app refreshes the quote automatically before step 3, record that observation and repeat with a newly captured quote while staying on the detail screen. Do not change the phone clock or production exchange-rate data.

### D02 — Sign-out, account switch, and same-account return

**Status:** Open on phone. Account isolation and same-ID recovery have unit coverage.

1. Queue a uniquely named INR 3 expense as account A while offline. Confirm it survives a force-stop and remains outside confirmed totals.
2. Still offline, sign out and confirm any pending-action warning. Reconnect and sign in as account B. Confirm A's pending row is absent from B's trip and Trips queue, and no A expense was uploaded with B's credentials.
3. Sign out B and sign back in as A. The saved intent must resume or sync automatically under A. Verify one canonical expense and receipt, no duplicate, and account B's independent confirmed view.
4. Clean up the accepted test expense. If the app cannot sign out offline, use a local fault proxy that blocks create requests but permits authentication while switching accounts; document the changed setup.

### D03 — Permission loss and trip deletion

**Status:** Open on phone. `403` and `404` review behavior passed unit tests, but not a device/server state change.

Run each subcase on a **fresh disposable trip** so the shared QA trip remains usable. Make B the trip admin and A a participant. A opens the trip online, then queues one uniquely named expense offline. While A is offline, B either (a) removes A's permission or (b) deletes the trip. Reconnect A. Expect **Needs review** in the trip or Trips queue with the captured amount and participants intact, no new expense or receipt, and no upload under another account. Save evidence, discard the local test intent, and remove any surviving disposable trip.

### D04 — Authentication, rate limits, server failures, and capability rollback

**Status:** Open on phone. Focused `syncWorker` tests already cover `401`, `429`, `503`, connection loss, and protocol `0`; lost responses after a real server commit passed the live QA check.

Use a temporary **local-only fault proxy** on port 8000 forwarding to the isolated backend on another port (for example 8001). Keep `adb reverse tcp:8000 tcp:8000`. Intercept only the selected test request; pass authentication and all unrelated requests through. Create a fresh uniquely named offline expense for each case, then reconnect through the proxy:

| Inject once | Expected phone/server result |
| --- | --- |
| `401` on create | Row pauses for sign-in; no false synced state. Signing in again as A resumes the **same** entry once. |
| `429` with `Retry-After` | Row remains saved, respects the server delay, and then creates once. |
| `503` or a request timeout before commit | Row remains queued with a safe reason; Retry/reconnect uses the same mutation ID and creates once. |
| `/api/meta/config` reports expense protocol `0` | No create request is sent; row stays queued. Restore protocol `1`, retry, and verify one create. Repeat separately for payment protocol `0` if desired. |

For each case, capture proxy request count and mutation ID **without** logging bearer tokens or full financial payloads. Verify one server record/receipt only after the fault is removed. Stop the proxy, restore the normal QA backend on port 8000 and `adb reverse`, then clean up accepted test expenses. Do not inject faults into production.

### D05 — Payment cap and competing recorder

**Status:** Open variants. A changed B-to-A suggestion already produced **Needs review** on the phone with no unwanted INR 5 payment.

Use separate disposable payable suggestions. Open Settle Up online to cache B-to-A, then queue a partial manual payment offline. In one run, B records enough payment online to reduce the remaining cap below the queued amount; in another, B records the same payment while A remains offline. Reconnect A. Each stale entry must retain the original pair and amount under **Needs review** rather than shrinking, rerouting, or duplicating a payment. Compare both accounts' confirmed balances and server payment/receipt counts. Discard the rejected local intents after recording evidence.

### D06 — Online-only actions and post-sync receipt

**Status:** Partially checked on 2026-09-29. New-trip and member changes clearly
required a connection; UPI initiation was unavailable offline and no transfer
was launched. Receipt selection for an unsynced expense was deferred. After
sync, a nonsensitive image was attached to the same canonical INR 40 expense;
account B independently retrieved it and no new expense was created. Final
receipt-file deletion is pending with the run's cleanup. See the private
`.release-tmp/qa-everyday-20260928-2350/REPORT.md`.

With the QA app offline, attempt new-trip creation, member changes, UPI initiation, and receipt upload. Each must clearly require connectivity and must not enter the expense/payment outbox. Do not initiate a real money transfer. Then sync one small disposable expense, attach a non-sensitive test receipt **after** confirmation, and verify it on account B without creating another expense. Clean up the test record and attachment.

### D07 — Offline notice, headers, and accessibility

**Status:** Partially checked and UI failures found on 2026-09-29. The
dismissible notice, short details, automatic clearing, no last-sync time, and a
single **Add Transaction** title were observed. At font scale 1.3, Trip, Settle
Up, and pending-detail text and controls clipped. Trips queue rows omitted
expense names and original USD amounts; repeated **Review** and **Retry sync**
buttons had generic TalkBack labels. Full spoken-output traversal and repaired
screen verification remain open. Private screenshots and hierarchy notes are
in `.release-tmp/qa-everyday-20260928-2350/REPORT.md`.

In airplane mode, inspect Trip, Add Transaction, Settle Up, pending expense, and pending payment screens. The notice should say only that the app is offline, open short feature details on tap, and dismiss with ×. No “last synced” timestamp should appear. Each screen should have one clear title and usable spacing. With TalkBack, confirm **Pending sync**, **Conversion review needed**, **Needs review**, and confirmed entries are distinguishable. Restore connectivity and verify the notice clears.

### D08 — Storage, encryption, and account deletion

**Status:** Hardware fault injection open. Unit tests passed for missing key, migration failure, plaintext SQLite rejection, atomic writes, and retained outbox data. The installed QA APK is non-debuggable, so `run-as` cannot inspect its encrypted database header or selectively remove a key.

- **Storage/key faults:** Use a future debuggable **sacrificial** QA installation or test hook. Queue a disposable entry, inject one failure at a time (write failure, missing SecureStore key, failed migration), cold launch, and verify an error instead of an empty queue or silent data loss. A failed save must retain the form. Never fill the user's phone storage, export its key/database, or use `pm clear` as a substitute for selective key loss; `pm clear` removes both data and key.
- **Account deletion:** Use a separate disposable QA account and trip. Hold a queued entry with the local fault proxy, delete that account online, and verify its local rows are purged and inaccessible to another account. Do not delete the shared A/B QA accounts.
- **Direct SQLCipher header check:** Only on a debuggable sacrificial build, read at most the first 16 database bytes with `run-as`; they must not start with `SQLite format 3`. This cannot be completed on the currently installed QA APK without a different build.

## Automated checks and known failures

### A01 — Full frontend, static checks, web export

**Status:** No final full-run pass recorded after the offline edits. The focused offline frontend selection passed **7 suites / 85 tests**. From `frontend`, run these separately and record each exit code and summary:

```powershell
Set-Location D:\projects\tripPlanner\frontend
npm test -- --runInBand
.\node_modules\.bin\tsc.cmd --noEmit
npm run lint
.\node_modules\.bin\expo.cmd export --platform web --output-dir ..\.release-tmp\offline-web-export-check
```

The export produces web files only, not an Android APK. Investigate failures, then rerun only affected suites before one final full pass. Do not claim the installed QA APK contains any source-only fix.

### A02 — Full backend suite: 14 failures

**Status:** Last unrestricted run: **1,354 passed, 14 failed, 1 skipped, 1 warning** in `.release-tmp/backend-pytest-final.log`. The focused idempotency/conversion selection passed **48 tests**, including live MongoDB transaction tests. Some failed assertions may reflect old expectations or test environment; they still need triage. Use the isolated QA API and replica-set setup in the runbook, then run an individual node ID with:

```powershell
Set-Location D:\projects\tripPlanner\backend
$env:EXPO_PUBLIC_BACKEND_URL = 'http://127.0.0.1:8000'
.\.venv\Scripts\python.exe -m pytest -q 'tests/test_exact_split_api.py::TestCreateHardRule::test_create_mismatched_sum_rejected_422'
```

Replace the quoted node ID with any one below. Prioritize the five money/split cases because they touch offline entry validation:

```text
tests/test_exact_split_api.py::TestCreateHardRule::test_create_mismatched_sum_rejected_422
tests/test_expenses.py::TestExpenses::test_non_official_expense_currency_requires_exchange_rate_support
tests/test_family_participation_api.py::TestFamilyParticipationAPI::test_excluded_member_zero_and_involved_count_weight
tests/test_family_participation_api.py::TestFamilyParticipationAPI::test_per_family_redistributes_within_each_family
tests/test_settleup_hunt_api.py::TestEditCaps::test_edit_cap_is_residual_plus_own_amount

tests/test_balances_reports.py::TestReports::test_get_report_xlsx
tests/test_balances_reports.py::TestReports::test_report_settlements_column_includes_partial_payments
tests/test_payments.py::TestPaymentExcelReconciles::test_payments_tab_rows_reconcile
tests/test_email_flows_api.py::test_register_starts_unverified
tests/test_email_flows_api.py::test_unverified_user_can_still_log_in_soft_gate
tests/test_email_flows_api.py::test_resend_verification_rate_limited_after_register
tests/test_google_auth.py::TestGoogleAuthUnit::test_real_verifier_rejects_malformed_token
tests/test_member_linking_api.py::TestSubMemberClaim::test_preview_returns_family_member_claim_only
tests/test_member_linking_api.py::TestSubMemberClaim::test_join_as_new_with_sub_member_email_blocked
```

After resolving or explicitly dispositioning each failure, rerun `pytest -q` against the QA API. The live transaction tests must **pass rather than skip**. Do not point these tests at production; they create accounts and trips.

## Deferred release gates

- **R01 — Production backend:** The read-only check on 2026-10-04 returned expense/payment create protocol versions `1/1`, multi-currency `true`, and health `ok` (revision `3a91b55911f5`). Source now enables ordinary Android capture at the user's request; build 18 keeps it disabled. An updated APK and signed/device verification remain required. The public capability response does not establish a live production money-write test.
- **R02 — Signed upgrade and download:** A signed APK installed over build 17 without clearing data, repeat device journey, and `/download/android` update/verification remain undone. These require a new APK and publication work and are **excluded by the current instruction**. The QA test key cannot upgrade the user's production package.

For the next conversation, cite one ID (for example, “Run D02 with the connected phone” or “Triage A02 exact split”). Finish that ID's cleanup and record its result before starting another.
