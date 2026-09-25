# Android offline expense and manual-payment QA

Status on 2026-09-25: **local hardening passed; release gates remain open**. The
Android write flag in `frontend/src/offlineActivation.ts` is still `false`. This
runbook is for a disposable development build and test accounts. Do not use
production trip data for fault injection.

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
3. Use an Android **development build** containing SQLCipher. With the write
   flag still off, sign in and open the trip online, force-stop, enable airplane
   mode, and cold launch. Verify the cached trip, expense form, payment history,
   and last-sync labels. On a debuggable build, `expo-sqlite` stores the database
   under `files/SQLite/trip_offline_v1.db`. Inspect only its first 16 bytes with
   `adb exec-out run-as com.tripsplitter.app head -c 16 files/SQLite/trip_offline_v1.db`;
   they must not be the plaintext `SQLite format 3` header. A working cached
   view also proves the app's `PRAGMA cipher_version` check succeeded after
   restart. Do not export the database or SecureStore key into test logs.
4. For the remaining matrix, enable `ANDROID_OFFLINE_WRITES_ENABLED` only in a
   disposable test build after steps 1–3 pass. Keep the repository/default
   release flag off until every release gate has evidence.

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
