# Android offline expense and manual-payment QA

Status on 2026-09-26: **a local QA APK is ready; release gates remain open**.
Ordinary Android builds still keep offline writes off. The disposable QA build
sets `EXPO_PUBLIC_OFFLINE_QA=true` to exercise them with test accounts only.
Do not use production trip data for fault injection.

Replica-set check on 2026-09-25: a disposable local MongoDB 7.0.14
single-node replica set passed both live expense/payment transaction tests
(2 passed, 0 skipped). The selected backend suite passed 321 tests with no
skips and one warning. The test database names were shortened to stay within
MongoDB's 63-character limit. The backend API, Android device, and second-client
steps below still need observed results.
An unrestricted `pytest -q` run was not a standalone unit-test gate: it reached
`tests/test_auth.py`, which calls `localhost:8000`, and failed because no test
API server was running. Run that HTTP integration suite with an isolated test
backend before treating it as release evidence.

## QA APK and local backend

The verified artifact on this workstation is
[`Trip-Splitter-QA-local-2026-09-26.apk`](../.release-tmp/Trip-Splitter-QA-local-2026-09-26.apk).
It is **Trip Splitter QA**, package `com.tripsplitter.app`, version `1.0.0`
(code `1`), and 130,976,204 bytes. SHA-256:
`5F809EEE952C6A73417C7D9788F003D69A8C0DE8813357B2BC2712B0E4CA2DF5`.
The locally signed release variant embeds `http://127.0.0.1:8000`, contains
`libexpo-sqlite.so` and `libcrypto.so` for all four Android ABIs, and has
`usesCleartextTraffic=true` and `allowBackup=false` in the merged manifest.
Android APK Signature Scheme v2 verification passed. No device was attached,
so installation, cold launch, and SQLCipher runtime behavior are unverified.
This debug-key-signed QA artifact is not a production release APK.

An earlier EAS QA build (code `14`) failed the local-HTTP manifest gate and
must not be used for this test. The corrected EAS rebuild was rejected by
automatic approval review because it would upload repository source to Expo;
the artifact above was built locally instead. Its signing certificate differs
from the earlier EAS build and normal app. Install it only on a disposable
device or app installation with **no unsynced real actions**. Android requires
uninstalling an existing `com.tripsplitter.app` first, which erases that app's
local data. This local APK does not test upgrade migration from an existing
signed installation; that release gate remains open.

From the repository root, check `adb devices -l`. On that disposable
installation only, remove an existing app before installing the QA APK:

```powershell
adb uninstall com.tripsplitter.app  # Skip if the package is not installed; this erases its local data.
adb install '.release-tmp/Trip-Splitter-QA-local-2026-09-26.apk'
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
   and last-sync labels. On a debuggable build, `expo-sqlite` stores the database
   under `files/SQLite/trip_offline_v1.db`. Inspect only its first 16 bytes with
   `adb exec-out run-as com.tripsplitter.app head -c 16 files/SQLite/trip_offline_v1.db`;
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
   manual payment on that saved pair. Each local save must appear once with a
   distinct stable mutation UUID and a pending label. Confirmed totals,
   recommendations, budget, and reports must still show the previous server
   values. A selected receipt must be deferred until the expense syncs.
3. Force-stop and cold launch again in airplane mode. Confirm all three pending
   entries remain, in capture order, with the same UUIDs. Check status text with
   TalkBack: pending, syncing, needs review, and confirmed data must be distinct.
4. Restore connectivity while foregrounded. Confirm each item advances through
   syncing and reconciliation; expense then refund then payment are delivered in
   order. Compare the server collections/API and B's independent view: exactly
   one record per UUID, one canonical ID each, updated confirmed balances, and
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
issue. The app exposes pending count, oldest pending age, last successful sync,
safe error reasons, and Retry/Review actions. Do not clear app storage or
reinstall while unresolved actions are present: uninstall, storage clearing, or
irrecoverable key loss can remove unsynced local data. If a row remains in
`awaiting_reconcile`, verify the canonical server ID before attempting another
action; retry refresh with the same UUID rather than creating a new record.
