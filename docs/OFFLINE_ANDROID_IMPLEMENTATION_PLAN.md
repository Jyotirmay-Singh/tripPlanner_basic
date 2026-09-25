# Android offline expenses and manual payment records: implementation plan

Status: **planning only**. Prepared 2026-09-25 for future Codex sessions. No implementation in this document is claimed complete.

## Instructions for every implementation session

**Do not make unnecessary changes, do not commit the code, and do not create a new APK after each session.**

1. Read this document, applicable repository instructions, current code, and `git status` before editing. Preserve unrelated working-tree changes. Current code and tests win over older architecture notes.
2. Work on the next incomplete session below. Keep changes within that session's scope unless a dependency makes a small adjacent change necessary. Record that reason in the handoff.
3. Run focused tests and relevant static checks. Do not call a feature verified from mocks or code inspection alone. Report test commands, results, and any live Android/MongoDB checks that could not run.
4. Update this document's progress table and handoff log at the end of each session. Update `docs/APP_FEATURE_INVENTORY.md` and `USER_GUIDE.md` when behavior actually changes; do not describe planned behavior as shipped.
5. Leave changes uncommitted. Do not deploy or publish as part of routine sessions. A native development build is allowed only when needed to verify the new native storage integration. Prepare one integrated release APK only after all gates pass and the user requests a release; never build an APK merely because a session ended.

## Approved product scope

These decisions came from the user on 2026-09-25 and supersede earlier exploratory options:

- **First offline release: Android installed app.** Web offline support is deferred. Keep the existing web app working online and compiling throughout. iOS offline behavior is not part of this release.
- A user who previously signed in and opened a trip online can reopen that cached trip without a connection.
- First add **same-currency expenses/refunds** offline, then add **manual payment records** offline. Preserve the existing per-capita, per-family, and exact split choices if their offline validation is verified. New trip creation, joining, roster edits, expense edits/deletes, payment edits/deletes, and legacy settlement APIs remain online.
- An offline expense appears immediately in the expense list with a **Pending sync** state. Dashboard, trip totals, budget figures, balance recommendations, and reports keep showing the **last server-confirmed values** with a visible last-synced timestamp; they do not include pending writes.
- A manual payment record appears in pending payment history, while confirmed balances remain unchanged until server acceptance. “Record payment” means recording money exchanged outside the app. UPI initiation, recipient confirmation, and any real money movement remain online.
- Receipt capture/upload is **not queued in the first release**. An expense saved offline can receive a receipt after it syncs, using the existing online attachment flow. Explain this in the UI rather than silently dropping a selected photo.
- Sign-out with pending actions must warn the user and retain them for the **same account**. They are hidden from other accounts and do not sync until that account signs in again. Confirmed account deletion purges its local data.
- **Provisional session limit pending user confirmation:** allow offline access for up to 30 days after the last successful server authentication, matching the current JWT lifetime. After that, require online same-account sign-in before showing cached trips or accepting new queued writes; preserve existing pending rows. Confirm this product rule before Session 3.

## Current implementation facts to verify again before editing

- Expo SDK 54 / React Native client and FastAPI/MongoDB server: `frontend/package.json`, `backend/server.py`.
- `frontend/src/AuthContext.tsx` `refresh()` currently requests `/auth/me` on startup and clears the token after **any** error, including a network failure. `refreshUserProfile()` already distinguishes HTTP 401 from transient errors. Offline cold start needs a cached identity and a different startup path.
- `frontend/src/api.ts` holds the bearer token in AsyncStorage and classifies network, timeout, abort, and HTTP failures. `frontend/src/chatOutbox.ts`, `frontend/src/useTripChat.ts`, and `backend/routes/chat.py` show a small durable queue and client-ID-based retry pattern; chat is separate and must keep working.
- Trip list/dashboard/add picker and detail/form/settle-up screens fetch live data: `frontend/app/(tabs)/trips.tsx`, `dashboard.tsx`, `frontend/app/add.tsx`, `frontend/app/trip/[id]/index.tsx`, `add-expense.tsx`, `settle-up.tsx`. Detail currently loads trip, expenses, balances, and spend summary together. Settle-up also loads payments and UPI attempts.
- `backend/routes/expenses.py` and `backend/routes/payments.py` generate IDs on the server. Neither create route currently accepts an offline mutation ID. Expense creation can return a budget-confirmation response without saving. Payment creation checks receiver/admin permission, the current suggested debtor-creditor pair, the payable cap, and a trip-version guard.
- `split_member_ids: []` currently means **all members at server processing time**. Offline capture must preserve the user's selected participants explicitly, including when “everyone” was selected, and detect changes in relevant family/roster data.
- `trip.version` is not a complete roster revision: several member/trip mutations do not increment it. Do not use it alone as proof that an offline split or payment recommendation is unchanged.
- `backend/services/ledger_transactions.py` permits a standalone MongoDB fallback. Exact-once offline money writes need an explicitly tested transaction/standalone strategy. Do not assume production MongoDB supports transactions without checking.
- `backend/server.py` creates a unique chat client-message index and a payment-attempt index, but there is no expense/manual-payment idempotency index. Existing expense and payment deletion is physical, so duplicate prevention must survive deletion of an accepted row.
- Backend tests include pure unit tests and live API tests that may need a running API/MongoDB (`backend/tests/conftest.py`). Frontend uses Jest, TypeScript, and Expo lint. `docs/APP_FEATURE_INVENTORY.md` is the current audited inventory; older `memory/ARCHITECTURE.md` is not authoritative.

## Research and design choices

| Source checked 2026-09-25 | Consequence for this plan |
| --- | --- |
| [Expo SQLite, SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/sqlite/) | Persistent local database with transactions. Use the SDK-compatible release; SQLCipher is available for native builds and needs configuration/native verification. Its web implementation is alpha, another reason to defer web offline work. |
| [Expo SecureStore, SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/securestore/) | Store small secrets such as the database key and Android session token here; do not store trip snapshots or an outbox as large key-value strings. Handle backup/restore and missing-key behavior. |
| [Expo AsyncStorage, SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/async-storage/) | Existing AsyncStorage is persistent but unencrypted. It is unsuitable as the primary store for an expanding financial cache/outbox. |
| [Expo NetInfo, SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/netinfo/) | Reuse the installed connection listener as a trigger. A connected network is only a hint; an API request determines whether this backend is reachable. |
| [Expo BackgroundTask, SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/background-task/) | OS scheduling is delayed and conditional, with a 15-minute Android minimum. Promise sync on open/foreground/reconnect while running; background execution is optional best effort. |
| [AWS Builders' Library: idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) | Retryable create operations need caller-generated IDs, same-intent validation, a stored equivalent response, and atomic recording with the mutation. A timeout may happen after the server has committed. |
| [Expo PWA guidance](https://docs.expo.dev/guides/progressive-web-apps/) | Web offline later needs a carefully versioned service worker plus browser storage; do not introduce that into this Android release. |

**Selected architecture:** server-authoritative ledger, Android encrypted local cache and durable outbox, one account-scoped sync coordinator, and explicit reconciliation. Use the same local-enqueue path whether the phone currently appears online or offline; online simply attempts delivery immediately. Keep pending rows separate from server-confirmed snapshots so no pending action can quietly alter a confirmed balance.

## Required behavior and invariants

### Local data and account boundary

- Add `expo-sqlite` and, for Android secrets, `expo-secure-store` at SDK 54 compatible versions. Preferred Android store is SQLCipher SQLite with a random installation key held in SecureStore. Session 3 must confirm SQLCipher works in this project's actual development build. If it cannot, document the threat-model tradeoff and get a product decision before releasing a plaintext financial cache; do not silently downgrade.
- Keep account data logically or physically partitioned by immutable `user.id`. Every cache read and queued write must assert the active account. A different signed-in user never sees or uploads another user's rows.
- Persist only the needed sanitized user identity, trip/roster, recent expense list, confirmed balances/spend, and manual-payment history. Never cache PIN/password, raw JWT in SQLite, UPI IDs/references, or receipt image bytes. Use bounded retention for confirmed snapshots; **never evict unsynced operations to meet a quota**.
- Add schema-versioned migrations. A failed migration or a lost encryption key must not silently clear pending data. Report a recoverable error where possible, and do not claim a write was saved unless the database transaction completed.
- On first online sign-in, write the cached identity and data. A new account/device or never-opened trip has no offline data. Offline signup, join, and new-trip creation remain unavailable.
- Android token restoration should use SecureStore with a one-time migration from the current AsyncStorage key, preserving existing sign-ins. A network/timeout/5xx during `/auth/me` must retain the cached identity and token; a confirmed HTTP 401 requires reauthentication. If authorization is later revoked, the server's response takes precedence. Logout removes the active session but retains same-account pending data after warning; confirmed account deletion purges it.
- Preserve the current required password/mobile/UPI onboarding and invitation routing; a cached profile must not bypass a required credential step. Remote access revocation cannot be learned while the phone is offline, so cached data must be locked or purged on the next authoritative 401/403 as appropriate.
- Use a native storage adapter and an online-only web adapter (or equivalent platform boundary) so `expo-sqlite`/SecureStore imports do not break the current web build.

### Suggested local schema

The exact SQL names can change in Session 3, but preserve these fields and constraints:

| Store | Minimum data |
| --- | --- |
| `account_meta` | user ID, sanitized profile, last authenticated time, schema version, offline capability/protocol version |
| `trip_snapshots` | account ID, trip ID, full roster/permissions/currency/budget JSON, fetch time, optional revision/fingerprint |
| `read_snapshots` | account ID, trip ID, kind (`expenses`, `balances`, `spend`, `payments`), server payload JSON, fetch time; do not mix a failed partial refresh into a previously complete view |
| `outbox` | stable UUID `client_mutation_id`, account/trip IDs, type (`expense_create`, `manual_payment_create`), immutable captured intent/payload and relevant roster/balance fingerprint, queued time, state, attempt count, next retry time, last safe error code, canonical server ID/response when acknowledged |
| `sync_meta` | per-account/trip last successful refresh, last error class, active worker lease if needed for crash recovery |

States: `queued` → `sending` → `awaiting_reconcile` → `synced` (then prune after a bounded audit period). `queued`/`sending` can move to `needs_review` for a business conflict or `paused_auth` for 401. Recover an interrupted `sending` row on restart using the **same** mutation UUID; never make a new UUID on retry. Allow a user to edit/reconfirm or discard a `needs_review` item. Discard requires a clear action; no automatic data loss.

### Backend mutation contract

- Add optional `client_mutation_id` to new expense and manual-payment create requests; old clients remain compatible. The server associates it with the authenticated user, operation type, trip, a canonical request fingerprint, and the accepted response/resource ID. Reusing the ID with the same intent returns an equivalent success; reusing it with different intent returns a stable 409. Do not infer duplicates by matching amount/date/description: two identical expenses can be intentional.
- Use a durable idempotency receipt/tombstone independent of the expense/payment row so a retry **after another actor deletes that row** cannot recreate it. Decide retention with the maximum supported offline duration; do not use a short TTL that silently permits duplicates. Add unique indexes and race tests. Avoid repeating audit/notification side effects on replay; make their recovery/deduplication explicit.
- Recording the receipt and ledger mutation must be atomic for offline requests. First verify whether deployed MongoDB offers transactions. If not, design and test a safe fallback/recovery protocol before enabling offline writes. For offline manual payments, fail closed if exact-once and balance concurrency cannot be guaranteed. Keep legacy online clients functional.
- Add a server-recognized offline protocol capability/version to `/meta/config` or an equivalent existing config surface, and roll out backend support before the Android client. If a server rollback removes that capability, preserve queued actions and pause delivery; disabling new offline capture must not delete the queue.
- For expense capture, freeze explicit `split_member_ids`, family participant IDs, payer, split mode, source amount, currency, date/time, category, and exact allocations. Keep existing whole-unit money validation. Because roster mutations do not all increment `trip.version`, define a precondition based on the **relevant roster semantics**, enforced by the server at write time. Changed members/family structure or stale permissions become `needs_review`; never silently reinterpret “everyone.” Server still validates current membership, budget, split, and money rules.
- Offline foreign-currency conversion is out of scope: online quotes/approval can expire. Reject or save only an unsent draft, clearly labeled, when source currency differs from the trip currency. A budget overage response is **not** a successful write; move it to review for online confirmation rather than auto-applying `force=true`.
- A budget-warning response does not consume the mutation UUID because nothing was committed. After the user reviews it online, the confirmed `force=true` submission may use that same UUID; the request fingerprint is fixed only when a create actually commits.
- For manual payments, capture the selected pair, amount, note, and last confirmed recommendation context. The server must recheck permission, current payable/cap, whole-unit policy, and a snapshot precondition at apply time. A stale pair, changed amount, or 409 never auto-adjusts the payment. Existing UPI attempt/confirmation paths and legacy settlements must not be routed into this queue.

### Sync coordinator and presentation

1. Commit the outbox row locally before showing “Saved on this device.” If storage fails, keep the form and report that the action was **not** saved. A retry from the UI must reuse the same locally committed UUID.
2. Trigger a single worker per account on enqueue, Android app start, return to foreground, connection regained, and explicit Retry. Process in capture order per trip; serialize dependent expense-then-payment actions. Multiple screens must not start overlapping workers.
3. NetInfo is a trigger, not proof of server availability. Try the API with bounded timeouts. For network/timeout/5xx/429, preserve the row and retry with bounded exponential backoff and jitter (`Retry-After` for 429). Do not retry 4xx business errors indefinitely.
4. On an acknowledged create, persist the canonical server response/ID before changing UI state; refresh relevant server snapshots, then remove the pending presentation. If the response was lost, replay the same mutation UUID to recover the canonical result. If reconciliation fails, retain `awaiting_reconcile` and retry refresh, not create with a new ID.
5. Show an offline/last-synced indicator and pending count on cached trip views. Mark pending entries distinctly from confirmed rows; accessibility labels must announce state. Keep confirmed balances, budget, and recommendations unchanged until server reconciliation. If a cached endpoint is absent, show an honest unavailable state instead of zero.
6. `401` pauses delivery and prompts same-account sign-in without discarding rows. `403`/`404` (lost trip access/deleted trip), roster mismatch, invalid split, budget confirmation, and stale-payment/overpay conflicts become `needs_review` with a clear reason and safe recovery. A different account must never take over a pending row.
7. Do not promise immediate sync when the app is closed. Optional `expo-background-task` may attempt best-effort delivery late in the project, but foreground/reconnect sync and explicit Retry are the release-critical paths.

### Operations and support

- Expose queue count, oldest pending age, last successful sync, and a safe per-item Retry/Review action in the app. Persist stable error codes, not raw server traces. Never log token, payment note, expense description, roster, or financial amount in telemetry.
- Measure server idempotent replays, fingerprint conflicts, rejected stale writes, and client retry/review rates without personal or trip content. Test a staged internal rollout with the server protocol deployed first. A kill switch can stop new offline capture after the app reconnects, but it must preserve and drain already queued compatible operations.
- Treat app uninstall, device storage clearing, and unrecoverable key loss as possible loss of unsynced local data. Explain this limitation in user guidance. A backup restore must not turn encrypted-but-unreadable rows into a silent empty queue.

## Eight implementation sessions

Sessions are sequential gates, not an instruction to make eight commits or eight APKs. Split a session further if a gate cannot be safely completed; do not skip its acceptance criteria.

### Session 1 — Freeze the protocol and make expense creation retry-safe

**Work:** Confirm current API behavior, Mongo transaction capability in the intended environment, and the exact relevant-roster precondition. Add backward-compatible `client_mutation_id` support to expense creation, durable receipt/tombstone and unique index, same-intent replay, different-intent 409, and nonduplicated side effects. Preserve budget-confirmation behavior. Add focused backend tests for concurrent retries, timeout-after-commit simulation, deleted-row replay, changed roster, old-client requests, and whole-unit/exact/family/refund paths. If transaction guarantees are unavailable, stop enabling offline writes until a safe tested design exists.

**Gate:** Replaying an accepted expense request cannot create a second expense or side effect, even after the expense is deleted. A warning-only budget response creates nothing. Existing expense callers still work.

### Session 2 — Make manual payment creation retry-safe

**Work:** Add the same optional mutation contract to `POST /trips/{id}/payments`, including durable receipt, unique index, same-intent replay, and changed-intent 409. Enforce fresh recommendation/precondition and existing receiver/admin, cap, currency/whole-unit, and trip concurrency rules. Keep UPI-created payments and legacy settlements unchanged. Test concurrent recorders, lost response/replay, deleted-row replay, revoked rights, changed recommendation, excessive amount, and the supported/unsupported Mongo transaction modes.

**Gate:** Exactly one manual ledger payment can result from one UUID; stale or unauthorized requests never move balances. Existing online payment flows pass their focused tests.

### Session 3 — Android encrypted store and offline session restoration

**Work:** Add SDK-compatible native SQLite and SecureStore integration, SQLCipher configuration/key handling, schema migrations, account partitioning, repository interfaces, and an online-only web adapter. Migrate Android token storage without logging users out. Cache a sanitized profile after successful authentication. Change startup so a transient network error loads the last verified profile; only a confirmed 401 clears the active session. Implement account switching, sign-out warning/retention, and account-deletion purge behavior. Test migration, process restart, corrupt store/key loss, no-cache offline launch, 401, and account isolation.

**Gate:** Previously authenticated Android user can reopen the app offline without being signed out; a different account cannot see or sync that user's data. Web build still works online. Validate actual native storage/encryption with one development build if needed; do not create a per-session APK.

### Session 4 — Cache the read path without changing confirmed math

**Work:** Populate and hydrate trip list, selected trip/roster, expenses, server balances, spend summary, and manual-payment history. Adapt `dashboard`, `trips`, `add`, trip detail, add-expense, and settle-up screens to read cached data when fetches fail. Make UPI attempt details unavailable offline without blocking cached manual-payment history. Add last-synced/stale labeling; preserve old complete snapshots on partial refresh failure. Do not recalculate authoritative balances locally. Test cold restart, empty cache, cached trip navigation, incomplete snapshots, and web regression.

**Gate:** A previously opened trip and its expense form can be reached in airplane mode; displayed financial totals are clearly identified as last confirmed and never silently zeroed.

### Session 5 — Durable offline expense capture and pending UI

**Work:** Route same-currency expense/refund submissions through one atomic local enqueue path on Android, online and offline. Reuse existing form validation, including exact split and family participation, and persist an explicit captured roster/participant set. Show pending items in expense history across navigation and app restart, without changing confirmed totals. Disable offline receipt attachment and foreign-currency conversion with clear copy; permit online attachment after acknowledgement. Add edit/review/discard UI for rejected pending intents without changing confirmed records.

**Gate:** An expense survives force-stop/restart in airplane mode, appears once with `Pending sync`, and has a stable UUID. Storage failure does not claim success. Exact/family/refund test vectors remain correct.

### Session 6 — Delivery, reconciliation, and conflict handling

**Work:** Implement the single account-scoped worker, queue ordering, timeouts, backoff, connectivity/foreground/explicit-retry triggers, crash recovery, acknowledgement persistence, and canonical snapshot refresh. Map network/5xx/429 versus 401/403/404/409/422/budget warning into retry/pause/review states. Ensure user-visible status survives restart. Test server commit plus lost response, rapid reconnects, duplicate taps, two trips, queued expense followed by payment, server outage, account change, and server capability rollback.

**Gate:** Each queued expense is applied at most once, eventually reconciles to the canonical expense after a reachable server returns, and never disappears on an unresolved error. Another signed-in device sees it only after server acceptance.

### Session 7 — Offline manual payment recording

**Work:** Allow only a user who appears eligible in the cached trip to queue a manual payment for a last-confirmed suggested pair, with a stale-data warning. Put the record in pending history; leave balances/recommendations unchanged. Sync through the Session 2 endpoint with fresh server validation and explicit `needs_review` on stale pair, changed cap, permission loss, or conflict. Keep UPI handoff/confirmation online. Test receiver/admin permissions, partial amounts, pair rerouting, double recording, offline restart, and payment after earlier queued expenses.

**Gate:** Offline manual records are honest pending evidence, never represented as a completed server settlement before acknowledgement; server rejection never changes confirmed balances.

### Session 8 — Production hardening and integrated verification

**Work:** Check security/storage threat model, Android backup/key restoration, migration and upgrade behavior, queue size/storage-full handling, retention, accessibility, privacy-safe diagnostics, capability flag/rollback, and battery/network behavior. Run relevant backend unit and transaction-backed API tests, frontend Jest/TypeScript/lint, and an Android airplane-mode end-to-end matrix on a development build. Confirm web remains online and builds. Update user guide/inventory with verified facts and a support runbook. Resolve all release-blocking failures; keep any optional background task clearly best effort.

**Gate:** Complete the release checklist below with evidence. Do not create a release APK in this session by default; do that once only if the user asks for the final build/release.

## Release acceptance checklist

- [ ] Prior sign-in + opened trip → force-stop → airplane mode → cold launch shows cached trip, last-sync timestamp, and expense form.
- [ ] Two same-currency expenses (including refund, family/exact split) queued offline remain after restart; confirmed totals do not change while pending.
- [ ] Connectivity returns while foregrounded → each expense appears exactly once on server and another device, with canonical IDs and updated confirmed balances.
- [ ] Lost HTTP response after a committed write → retry with the same UUID returns the prior outcome, including after a resource is later deleted.
- [ ] Budget warning, changed roster, deleted trip, permission loss, invalid split, and stale payment each produce a reviewable state without silent force, double write, or data loss.
- [ ] Manual payment is pending in history and does not affect balances until server acceptance; UPI and legacy settlement behavior remain unchanged.
- [ ] Logout warns and retains unsynced rows only for that account; account switch hides them; same-account re-login resumes; confirmed account deletion purges them.
- [ ] Storage-full, key-loss, failed migration, backend outage, 401, and app kill do not create false “saved/synced” claims.
- [ ] Accessibility/status text clearly distinguishes pending, syncing, needs review, and confirmed data.
- [ ] Native device test, backend transaction-backed tests, frontend tests/typecheck/lint, and online web build results are recorded. No unrelated behavior or files changed.

## Session tracking and handoff

| Session | State | Evidence / handoff link |
| --- | --- | --- |
| 1. Expense protocol | Implemented; live Mongo verification pending | [Session 1 handoff](#session-1-handoff-2026-09-25) |
| 2. Payment protocol | Not started | |
| 3. Store and auth | Not started | |
| 4. Cached reads | Not started | |
| 5. Expense capture | Not started | |
| 6. Sync coordinator | Not started | |
| 7. Manual payments | Not started | |
| 8. Hardening | Not started | |

At each handoff append: date; session number; user-visible behavior completed; files changed; tests and exact results; decisions made; remaining risks; next session's first task. Keep the table truthful and leave any unverified acceptance box unchecked.

### Session 1 handoff (2026-09-25)

- **Behavior:** Optional UUID `client_mutation_id` on expense create returns the stored accepted response on same-intent replay (including after expense/trip deletion) and 409 `client_mutation_conflict` on changed intent. A budget warning writes no receipt and the same ID may be used with reviewed `force=true`. Old clients retain their existing request and response behavior; no Android offline UI or payment protocol was added.
- **Request contract:** A mutation-ID request also supplies nonempty, explicit `split_member_ids` and `expected_roster` containing trip `currency` and exactly the payer plus selected split entities (`id`, `kind`, and ordered `family_member_ids` for families). The server compares this relevant snapshot again inside the transaction; mismatch returns 409 `expense_roster_changed`. `force` does not alter intent. `/api/meta/config` exposes `expense_create_protocol_version: 1` only after a successful startup write-transaction probe; otherwise it is `0`, and new mutation-ID writes fail closed with 503 `expense_retry_unavailable` while legacy writes remain available.
- **Atomicity:** A permanent receipt in `expense_mutation_receipts` has a unique `(actor_user_id, operation, client_mutation_id)` index and no TTL. The trip claim, expense, receipt, money normalization audit, privileged admin audit, and notification outbox event share one MongoDB transaction. Only the outbox dispatch is scheduled after commit; a replay does not repeat any side effect. Runtime transaction unavailability turns off the advertised capability.
- **Files:** `backend/models/expense.py`, `backend/routes/expenses.py`, `backend/routes/meta.py`, `backend/server.py`, `backend/services/expense_idempotency.py`, `backend/services/admin_audit.py`, `backend/services/push_notifications.py`, `backend/services/departure.py`, `backend/tests/test_expense_idempotency.py`, `backend/tests/test_expense_idempotency_mongo.py`, `backend/tests/test_departure_service.py`, `docs/APP_FEATURE_INVENTORY.md`, and this plan. `USER_GUIDE.md` is unchanged because no user-facing offline flow shipped.
- **Evidence:** From `backend`, `.venv/Scripts/pytest.exe -q tests/test_expense_idempotency.py tests/test_expense_idempotency_mongo.py tests/test_departure_service.py tests/test_super_admin.py tests/test_notification_triggers.py tests/test_push_notifications.py tests/test_currency_precision_audit.py tests/test_expense_conversion.py tests/test_expense_conversion_routes.py tests/test_expense_shares.py tests/test_signed_expense.py --disable-warnings`: **231 passed, 1 skipped, 1 warning**. Tests cover concurrent same-ID requests, conflicting intent, lost response, deleted-row replay, roster changes before and during the transaction, budget force confirmation, whole-unit/exact/family/refund paths, rollback after outbox failure, old-model compatibility, capability gating, and account-deletion receipt cleanup. An attempted wider run had 186 passed, 1 skipped, and 10 live-RBAC fixture errors because no API is listening on localhost:8000; these are not counted as verified.
- **Remaining gate:** The configured MongoDB at localhost:27017 refused connections; Docker's daemon was unavailable. The real-Mongo transaction test therefore skipped, and production MongoDB topology/transaction behavior has **not** been verified. No offline capture should be enabled until the disposable transaction-backed test passes against the intended replica set and the deployed server advertises version 1. Receipts remain durable after expense or trip deletion for replay, but are purged when their account is deleted. The current client has no offline queue; no APK was built.
- **Next session:** Make manual payment creation independently retry-safe (Session 2), retaining its existing permission, recommendation, cap, currency, and UPI behavior; first arrange a reachable transaction-capable test MongoDB and run the Session 1 integration test.
