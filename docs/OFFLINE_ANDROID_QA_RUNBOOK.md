# Android offline expense and manual-payment QA

Activation update on 2026-10-04: ordinary Android source now enables the durable expense/payment
queue by default and in the development/preview/production build profiles. Live production config
advertises protocols `1/1`; build 18 still has capture disabled and needs an updated APK. The earlier
flag-off and production-protocol observations below are historical. Native storage-fault, SQLCipher,
upgrade, and UI/TalkBack checks remain open. Preserve the existing unapproved QA budget-review row.

Status on 2026-10-01: **The everyday QA save, restart, sync, conversion, and
post-sync attachment flow passed on the isolated QA build. Final cleanup is
pending because one unapproved budget review row remains on the phone.
Enlarged-text layout and Trips queue accessibility checks failed. Release gates
remain open.**
Ordinary Android builds still keep offline writes off. The disposable QA build
sets `EXPO_PUBLIC_OFFLINE_QA=true` and uses `com.tripsplitter.app.qa` so it can
be installed beside `com.tripsplitter.app` without clearing real app data.
Do not use production trip data for fault injection.

Replica-set check on 2026-09-27: a disposable local MongoDB 7.0.14
single-node replica set passed both live expense/payment transaction tests
(2 passed, 0 skipped). The earlier selected backend suite passed 321 tests with no
skips and one warning. The test database names were shortened to stay within
MongoDB's 63-character limit. The isolated QA phone and second-account API have
passed the core device checks below. The failure matrix remains open.
With the isolated API server running, unrestricted `pytest -q` finished with
1,352 passed, 14 failed, and 3 skipped. Those older API/report expectations
remain a release gate. The expense/payment idempotency unit and live-Mongo
selection passed 26 tests; `pip check` and backend compilation passed.

## Observed QA device journey (2026-09-27)

- Connected phone: moto g54 5G. The side-by-side QA package
  `com.tripsplitter.app.qa` installed with `adb install -r`, preserving its
  encrypted trip cache. The local backend advertised both create protocols as
  `1`, and the disposable MongoDB replica set accepted transaction probes.
- A 40 INR expense using an exact split with a family participant stayed
  **Pending sync** during airplane mode. A separate 8,877 INR expense was also
  saved pending. Both became one accepted server expense and one durable
  mutation receipt each after the QA API connection was restored. Account B's
  independent authenticated API view showed both alongside the seed expense.
- On the updated QA build, a -10 INR refund was saved in airplane mode. A
  force-stop and cold launch retained the pending row while confirmed budget
  stayed at 9,217 INR and refunds stayed at zero. Reconnecting while foregrounded
  created exactly one -10 INR server expense/receipt, changed confirmed budget
  to 9,207 INR, and showed 10 INR in confirmed refunds.
- A 10 INR partial manual payment on the saved B-to-A suggestion survived an
  APK update and an offline cold launch. Reconnecting created exactly one
  payment and one mutation receipt. The B-to-A suggestion fell from 2,302 INR
  to 2,292 INR, and account B's authenticated API view showed the payment.
- A USD 1 expense survived a force-stop with **Conversion review needed** and
  did not affect confirmed totals. The isolated QA rate service initially
  returned `exchange_rate_unavailable`; a synthetic USD-to-INR rate of 84.00
  with effective date 2026-09-25 was added to the disposable QA database.
  The app then showed the exact USD 1 ≈ INR 84 quote and waited for an explicit
  tap on **Use this conversion**. After approval, the server had one 84 INR
  expense retaining `original_amount=1` and `original_currency=USD`, plus one
  mutation receipt for its original ID. Both accounts saw five expenses and
  the same B-to-A balance of 2,313 INR. The trip's four outbox expense IDs
  corresponded to four receipts. This synthetic rate checks the approval and
  delivery flow; it is not a live exchange-rate availability check.
- The QA API URL is `http://127.0.0.1:8000`. The first reported sync failure
  was reproduced with missing `adb reverse tcp:8000 tcp:8000`: the phone had
  internet but could not reach its local test server. Restoring the mapping
  allowed both queued expenses to sync. The worker now shows a safe connection
  reason and lets reconnect, foreground return, or Retry bypass network backoff.
- The dismissible offline notice and its short details worked. After a later
  API-only reconnect that did not change NetInfo state, the final QA build
  cleared the offline notice automatically within its 20-second check interval.
  The Add Transaction screen showed one navigation title. A further QA build
  is checking the remaining form titles and original-currency labels.
- Production `/api/health` reported revision `231e71aa34d9`, and production
  `/api/meta/config` still omitted both offline create protocol versions.
  Keep `EXPO_PUBLIC_ANDROID_OFFLINE_WRITES` off in ordinary/release builds.

The 2026-09-28 fault checks below cover dropped responses and two live device
conflicts. Destructive storage/key-loss injection, device quote expiry, device
account switching, and signed build-17 upgrade testing remain open.
The QA APK is signed with a local
test key and cannot replace the user's installed production package.

## Additional fault checks (2026-09-28)

- An actual HTTP response was dropped after the local transaction-capable QA
  server committed an expense, then again for a manual payment. Each receipt
  existed before retry. Two retries using the unchanged mutation ID returned
  the same canonical ID; each operation had exactly one record and one receipt.
- While an INR 5 expense was pending on the phone, the participating family's
  roster changed on the server. Reconnect returned `409`, retained the captured
  amount and participants under **Needs review**, and created no expense. The
  test pending row was discarded and the original family roster restored.
- A pending INR 5 manual payment captured the B-to-A suggestion at INR 2,312.
  Another server payment changed it to INR 2,311 before reconnect. The phone
  retained the original amount and pair under **Needs review**; both accounts
  saw no INR 5 server payment. The stale pending row was discarded.
- An offline INR 100,000 expense exceeded the QA trip budget by INR 9,292.
  Reconnect retained it for explicit budget approval with no server record or
  receipt. After **Save anyway**, one expense and one receipt appeared, and
  both accounts saw it. The synthetic accepted expense was then deleted from
  the disposable trip; confirmed budget used returned to INR 9,292 after a
  cold launch. No pending QA row remained.
- Focused frontend offline tests passed: **7 suites, 85 tests**. Focused
  backend idempotency and conversion tests passed: **48 tests**, including the
  live MongoDB transaction cases. The unrestricted backend run completed with
  **1,354 passed, 14 failed, 1 skipped**; those failures remain a release gate.

## Everyday device journey (2026-09-29 through 2026-10-01)

- A refreshed side-by-side QA APK from commit `959a4957` was installed without
  clearing the phone's saved data or touching the production package. The
  pre-existing conversion review row was resolved and its accepted disposable
  expense deleted before the fresh run.
- Four offline entries survived a cold launch: INR 40 exact-split expense,
  INR -40 opposite refund, INR 10 partial B-to-A manual payment, and USD 1
  expense. Confirmed totals stayed at their server values. Reconnect created
  one expense, refund, and payment each; the USD row waited for explicit
  conversion approval. A synthetic QA quote converted USD 1 to INR 84. After
  approval, both independently authenticated accounts saw the same canonical
  records. A nonsensitive image attached to the confirmed INR 40 expense was
  retrieved by account B without creating another expense.
- The next INR 100,000 offline entry reached **Needs review** for a budget
  warning and remains local and unapproved. On 2026-10-01, the isolated database
  still held zero expense records and mutation receipts for it. The accepted
  entries and receipt file remain until the phone row can be reviewed and
  discarded, then the run's accepted records can be deleted. Private IDs,
  counts, screenshots, and continuation steps are in ignored
  `.release-tmp/qa-everyday-20260928-2350/REPORT.md`.
- Font scale 1.3 exposed clipped Trip, Settle Up, and pending-detail content.
  The Trips queue omitted pending expense names and original USD amounts and
  exposed repeated generic **Review**/**Retry sync** TalkBack labels. These are
  failed UI checks, not release passes. The font scale and accessibility service
  were restored after inspection. Spoken output for all requested states is
  still unverified.

## QA APK and local backend

The older artifact on this workstation is
[`Trip-Splitter-QA-local-2026-09-26.apk`](../.release-tmp/Trip-Splitter-QA-local-2026-09-26.apk).
It is **Trip Splitter QA**, package `com.tripsplitter.app`, version `1.0.0`
(code `1`), and 130,976,204 bytes. SHA-256:
`5F809EEE952C6A73417C7D9788F003D69A8C0DE8813357B2BC2712B0E4CA2DF5`.
The locally signed release variant embeds `http://127.0.0.1:8000`, contains
`libexpo-sqlite.so` and `libcrypto.so` for all four Android ABIs, and has
`usesCleartextTraffic=true` and `allowBackup=false` in the merged manifest.
Android APK Signature Scheme v2 verification passed. **Do not install this older
APK beside the current app:** it has the same package ID and a different signer.
A new QA build must pass package-ID inspection before device use. No device was attached,
so installation, cold launch, and SQLCipher runtime behavior are unverified.
That debug-key-signed QA artifact is not a production release APK.

An earlier EAS QA build (code `14`) failed the local-HTTP manifest gate and
must not be used for this test. The corrected EAS rebuild was rejected by
automatic approval review because it would upload repository source to Expo.
The new QA package intentionally omits production Firebase registration and
must use isolated password test accounts. It does not test upgrade migration
from an existing signed installation; that release gate remains open.

From the repository root, check `adb devices -l`. Verify the selected QA APK's
package ID is `com.tripsplitter.app.qa` with `apkanalyzer` or `aapt2` before
installing it. Never uninstall `com.tripsplitter.app` for QA:

```powershell
adb install '<verified com.tripsplitter.app.qa APK>'
```

The isolated MongoDB 7.0.14 data set on this workstation is already initialized
as replica set `qa0`. If it is not running, start it from the repository root
in one PowerShell terminal:

```powershell
$qaMongo = (Resolve-Path '.release-tmp/offline-qa-mongo').Path
& "$qaMongo/mongod.exe" --replSet qa0 --port 27018 --bind_ip 127.0.0.1 --dbpath "$qaMongo/db"
```

Start the test backend in a second terminal. Its ignored `backend/.env` supplies
the required signing secret; these overrides select the disposable
database and prevent email and push delivery:

```powershell
Set-Location backend
$env:MONGO_URL = 'mongodb://127.0.0.1:27018/?replicaSet=qa0'
$env:DB_NAME = 'trip_splitter_qa_local_20260925'
$env:EMAIL_FEATURES_ENABLED = 'false'
$env:RESEND_API_KEY = ''
$env:PUSH_NOTIFICATIONS_ENABLED = 'false'
$env:EXPO_PUSH_ACCESS_TOKEN = ''
$env:MULTI_CURRENCY_EXPENSES_ENABLED = 'true'
& '.\.venv\Scripts\python.exe' -m uvicorn server:app --host 127.0.0.1 --port 8000
```

On 2026-09-26, this backend returned `/api/health` status `ok`, both expense
and payment create protocol versions `1` from `/api/meta/config`, and
`email_features_enabled=false`. Recheck those values after each restart. Connect
the phone by USB and run `adb reverse tcp:8000 tcp:8000` for online setup.
Before airplane-mode testing, run `adb reverse --remove tcp:8000`; restore the
reverse mapping when reconnecting. USB port forwarding can otherwise keep the
API reachable during airplane mode. Keep the backend on `127.0.0.1` and use a
second test account in an independent browser or device to inspect server data.

## Before the device matrix

1. Use an isolated, transaction-capable MongoDB replica set. Point
   `EXPENSE_TEST_MONGO_URL` and `PAYMENT_TEST_MONGO_URL` at it without printing
   their values. From `backend`, run
   `.venv/Scripts/python.exe -m pytest -q tests/test_expense_idempotency_mongo.py tests/test_payment_idempotency_mongo.py`.
   Both tests must **pass**, not skip. They create and drop random test databases.
2. Start a test backend on that replica set. Check `/api/meta/config` advertises
   `expense_create_protocol_version: 1` and `payment_create_protocol_version: 1`.
   A 0 means mutation-ID delivery must stay paused. Use two test accounts linked
   to one INR trip; make account A the receiving person or trip admin and account
   B another linked person. Use B's independent browser or phone as the second
   view. Seed a confirmed payable suggestion from B to A before going offline.
3. Use an Android build containing SQLCipher. Before queuing any writes, sign in
   and open the trip online, force-stop, enable airplane
   mode, and cold launch. Verify the cached trip, expense form, payment history,
   and the dismissible offline notice. On a debuggable build, `expo-sqlite` stores the database
   under `files/SQLite/trip_offline_v1.db`. Inspect only its first 16 bytes with
   `adb exec-out run-as com.tripsplitter.app.qa head -c 16 files/SQLite/trip_offline_v1.db`;
   they must not be the plaintext `SQLite format 3` header. A working cached
   view also proves the app's `PRAGMA cipher_version` check succeeded after
   restart. The local QA APK is a non-debuggable release variant, so `run-as`
   cannot inspect its database header; keep that direct check open for a
   suitable debuggable build. Do not export the database or SecureStore key
   into test logs.
4. Use the disposable local QA APK for the remaining matrix after the protocol
   and cached-view checks pass. Its write gate is enabled by the QA build
   variable. Keep the ordinary/release build flag off until every release gate
   has evidence.

## Main journey

1. In the test build, sign in as A, open the trip and Settle Up online, and note
   the confirmed budget, balances, payable pair, expense IDs, and payment IDs.
   Force-stop; turn on airplane mode; cold launch and open the cached trip.
2. Queue a same-currency positive expense using an EXACT split with a family
   participant. Queue an equal, opposite refund with the same payer and split so
   the seeded payable pair remains valid after both apply. Queue a partial
   manual payment on that saved pair. Queue a USD expense or refund in its
   original currency and verify **Conversion review needed** appears. Each local save must appear once with a
   distinct stable mutation UUID and a pending label. Confirmed totals,
   recommendations, budget, and reports must still show the previous server
   values. A selected receipt must be deferred until the expense syncs.
3. Force-stop and cold launch again in airplane mode. Confirm all four pending
   entries remain, in capture order, with the same UUIDs. Check status text with
   TalkBack: pending, syncing, needs review, and confirmed data must be distinct.
4. Restore connectivity while foregrounded. Confirm the server issues a current
   foreign-currency quote and displays the source amount, converted amount, rate,
   effective date, and stale-rate status. Explicitly approve that quote. Confirm
   each item advances through syncing and reconciliation; expense then refund then
   payment are delivered in order, with the foreign expense sent only after approval.
   Compare the server collections/API and B's independent view: exactly
   one record per accepted UUID, one canonical ID each, updated confirmed balances, and
   no pending copy left in confirmed history. Reopen the app once more to prove
   the reconciled state survives restart.
5. Drop one HTTP response **after** the test backend commits an expense, then
   retry its unchanged UUID. Verify the original response/ID returns and no
   extra expense, audit, or notification appears. Repeat after deleting that
   accepted expense in the disposable trip. Do the same for a manual payment.

## Failure matrix

Use fresh test trips or UUIDs for each case; inspect the Trips queue when the
trip itself becomes inaccessible. Never infer success from a toast alone.

| Case | Required observation |
| --- | --- |
| Budget overage | No record or receipt on warning; needs review; explicit online approval uses the same UUID and creates once. |
| Foreign quote expiry or changed inputs | Original currency and split stay saved; an expired quote cannot be approved or silently replaced on a sent UUID; a current quote needs explicit approval. |
| Family/roster change, invalid split | No silent reinterpretation or ledger write; saved intent remains reviewable. |
| Permission revoked or trip deleted | No upload under another account; orphaned review remains reachable from Trips. |
| Payment pair rerouted, cap changed, or double recorder | No automatic amount adjustment; stale record needs review and confirmed balances do not move. |
| Logout, account switch, same-account return, account deletion | Warning and account isolation; same-account pending rows resume; confirmed deletion purges that account's local rows. |
| Backend outage, timeout, 429, 5xx, 401, capability rollback | Same UUID is retained; bounded retry or sign-in pause; no false synced claim. |
| Storage full, failed schema upgrade, missing key, app kill | Save failure keeps form; uncertain commit is read back with the same UUID; unreadable data is not silently replaced by an empty queue. Test destructive key-loss on a sacrificial installation only. |
| UPI and legacy settlements | Their existing online paths still work and never enter this outbox. |

## Support and evidence

Record the development build identifier, Android version, backend revision,
database topology, protocol versions, test account IDs, mutation UUIDs, canonical
IDs, server counts, second-client observations, and pass/fail for every checklist
row in `OFFLINE_ANDROID_IMPLEMENTATION_PLAN.md`. Store sensitive values and
financial details only in the private QA record, never in telemetry or a public
issue. The app exposes pending count, safe error reasons, and Retry/Review actions.
The offline notice opens a short feature explanation and can be dismissed. Do not clear app storage or
reinstall while unresolved actions are present: uninstall, storage clearing, or
irrecoverable key loss can remove unsynced local data. If a row remains in
`awaiting_reconcile`, verify the canonical server ID before attempting another
action; retry refresh with the same UUID rather than creating a new record.
