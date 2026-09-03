# CLAUDE.md

Repository guidance for Claude Code. Treat this file as current operating guidance, not as proof that a feature works. Verify behavior in code and tests before making claims or changes.

## 1. Project Summary and Sources of Truth

Trip Expense Splitter is an Expo/React Native app with a FastAPI/MongoDB backend. It helps groups track trip expenses, split costs among individuals and families, reconcile balances, record payments, attach receipts, and export XLSX/PDF reports.

1. Current code, schemas, routes, and tests are authoritative for implementation behavior.
2. `docs/APP_FEATURE_INVENTORY.md` is the current audited feature snapshot.
3. `USER_GUIDE.md` describes user-facing workflows.
4. `memory/PRD.md` and files under `.claude/` are requirements, plans, commands, and historical context; they are evidence, not proof of implementation.

When documentation conflicts with code, state the conflict and verify before changing behavior.

## 2. Repository Map

- `backend/`: FastAPI application, MongoDB persistence, business logic, and backend tests.
- `frontend/`: Expo SDK 54 / React Native application using `expo-router`.
- `shared/`: cross-stack fixtures, including exact-split reconciliation vectors.
- `.claude/`: Claude commands, skills, plans, specs, agents, and settings.
- `docs/APP_FEATURE_INVENTORY.md`: evidence-linked application inventory and known gaps.
- `USER_GUIDE.md`: product usage documentation.
- Render, Vercel, Expo, and EAS configuration lives in their root/backend/frontend build files.

Ignore generated, dependency, cache, and build-output directories unless a task specifically requires them.

## 3. Architecture

### Backend

`backend/server.py` assembles the FastAPI app, registers routers, and runs startup/shutdown work. The backend is organized as:

- `backend/models/`: Pydantic request and domain models.
- `backend/routes/`: `/api` routers for auth, trips, members, expenses, balances, settlements, payments, spend, reports, receipts, and metadata.
- `backend/services/`: split calculations, server-authoritative expense conversion, Frankfurter v2
  rate retrieval/caching, report construction, receipts, payments, reallocation, and related
  business logic.
- `backend/utils/`: authentication dependencies, permissions, balance computation, identity helpers, email validation, and supporting utilities.
- `backend/config.py`: environment configuration.
- `backend/database.py`: Motor client and database handle.

MongoDB is accessed through Motor. Principal collections include `users`, `trips`, `expenses`,
`exchange_rates`, `exchange_rate_aliases`, `exchange_rate_quotes`, `settlements`, `payments`,
`chat_messages`, `chat_reads`, `chat_counters`, and `auth_tokens`. Receipts use GridFS. Startup
creates indexes, seeds the configured admin, and runs idempotent legacy-data backfills.

### Frontend

The frontend uses Expo SDK 54, React Native, TypeScript, and file-based `expo-router` routes under `frontend/app/`:

- `(auth)`: password login, registration, verification, and password-reset flows.
- `(tabs)`: dashboard, trips, add, reports, and profile.
- `trip/[id]/`: trip summary, expenses, members, receipt gallery, settle-up, reports, and drill-down screens.

Shared frontend code lives under `frontend/src/`. Important modules include:

- `api.ts`: fetch wrapper, bearer-token attachment, API error normalization, and report URLs.
- `AuthContext.tsx`: session lifecycle, remembered email, and mandatory Google password setup.
- `permissions.ts`: UI mirror of backend permissions; backend permissions remain authoritative.
- `ThemeContext.tsx` and `theme.ts`: persisted light/dark theme.
- `exactSplit.ts`, `expenseConversionPayload.ts`, `familyParticipation.ts`, `payments.ts`,
  `expenseSort.ts`: pure domain helpers.
- `useExchangeRateQuote.ts` and `ui/ExchangeRatePanel.tsx`: debounced/cancelled backend quote
  previews, explicit approval, manual/card conversions, and locked-rate editing UI.
- `chat.ts`, `useTripChat.ts`, and `TripChat.tsx`: chat contracts/identity helpers, realtime state, unread synchronization, and the trip Chat tab.
- `ui/`: shared UI components.

The app reads its API base from `EXPO_PUBLIC_BACKEND_URL`; do not add a hard-coded localhost fallback.

## 4. Developer Commands

Run commands from the indicated package directory. Do not execute commands merely because they appear in `.claude/commands`; inspect their effects first.

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --reload
pytest
pytest tests/test_auth.py
pytest tests/test_auth.py::TestAuth::test_register_success
```

### Frontend

```bash
cd frontend
yarn install
yarn start
yarn android
yarn ios
yarn web
yarn lint
```

Use the scripts actually declared in the relevant package/build files. Some backend tests are pure unit tests; live API tests may require a running API and MongoDB. Report what was and was not exercised.

## 5. Environment Variables

Never print, commit, or reproduce secret values. Document names and purpose only.

Backend (`backend/.env`):

- `MONGO_URL`, `DB_NAME`: MongoDB connection and database.
- `JWT_SECRET`: HS256 signing secret.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`: seeded administrator credentials; email must be Gmail.
- `RESEND_API_KEY`, `SENDER_EMAIL`, `APP_URL`: transactional email and public-link configuration.
- `GOOGLE_CLIENT_ID`: one accepted OAuth audience or a comma-separated list; include the Web client
  used by Android Credential Manager/web and the iOS client when iOS sign-in is enabled.
- `MULTI_CURRENCY_EXPENSES_ENABLED`: runtime rollout flag for expense conversion; defaults to
  `false`. Frankfurter v2 requires no API key or new secret.
- `WHOLE_UNIT_SETTLEMENTS_ENABLED`: runtime rollout flag for conserving whole-rupee LKR/NPR
  recommendations and new/amount-edited payment writes; defaults to `false`.

Frontend (`frontend/.env` or build environment):

- `EXPO_PUBLIC_BACKEND_URL`: complete API base URL.
- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`: web and Android Credential Manager token audience.
- `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`: iOS AuthSession client and reversed URL-scheme source.

Android OAuth clients are Google Cloud package/SHA registrations, not runtime environment values.

If Resend is not configured, current backend behavior may log a link/token for development. Never expose those values in output.

## 6. Critical Domain Invariants

Preserve these unless the task explicitly changes them. Changes require focused tests across every affected layer.

### IDs and Storage

- Application IDs are UUID strings produced by `gen_id()`, not MongoDB ObjectIds.
- Documents expose `id`; normal queries exclude Mongo `_id`.
- Trip members are embedded in the trip document. `user_ids` controls trip access, and `admin_ids` stores app-user IDs with admin rights.
- Legacy migrations and startup backfills must remain idempotent.

### Currency and Expense Conversion

- A trip's official currency is selected at creation and is immutable. Create separate trips when
  different official/reporting currencies are required.
- Existing expense `amount` and `currency` fields are canonical ledger values in the trip's
  official currency. Budgets, balances, settlements, spend summaries, notifications, and reports
  must use those canonical fields only.
- Foreign expenses retain `original_amount`, `original_currency`, locked rate/effective-date/source
  metadata, a conversion version/history, and original-currency Exact allocations when applicable.
  Legacy rows without that metadata remain valid same-currency rows and must not be destructively
  migrated.
- The backend is authoritative for conversion. The client may preview a quote but must never submit
  a trusted canonical foreign amount. A foreign write requires an explicit approved automatic or
  manual quote; same-currency writes use rate 1 without provider I/O.
- Automatic conversion uses the expense-date Frankfurter v2 reference rate. Preserve the provider's
  actual effective date for weekend/holiday fallback. Never fail over to another provider silently.
- Saved rates and converted amounts are locked. Unrelated edits must not reconvert; changing a
  conversion input or explicitly requesting reconversion increments `conversion_version` and appends
  audit history.
- Backend rate/original metadata arithmetic uses `Decimal`/Mongo `Decimal128`; the persisted canonical
  expense amount remains the immutable trip-currency source. Settlement parses stored values through
  decimal strings into 12-place scaled integers, preserving split fractions without fetching or
  mutating FX history. The compatibility `net` field remains a jointly rounded two-decimal numeric
  view; currency-specific ledger minor units beyond the LKR/NPR settlement projection are deferred.
- Exact allocations are entered as positive magnitudes in the original currency, validated against
  `abs(original_amount)`, converted with the locked rate, and largest-remainder rounded so canonical
  shares sum exactly to canonical `amount`. Refund shares receive the transaction's negative sign.

### Authentication and Gmail Identity

- The backend is the source of truth for authentication and authorization.
- JWT bearer tokens use HS256 and currently expire after 30 days.
- Authentication supports Gmail/password credentials and Google OAuth. New Google users must create a local password before entering protected screens. Verification and reset tokens are hashed, single-use, and time-limited.
- All accepted identity emails must end in `@gmail.com`. Backend enforcement is in `backend/utils/email_rules.py`; `frontend/src/validation.ts` is only the UI mirror.
- Within a trip, one Gmail address identifies at most one person.

### Roles and Permissions

Roles are owner, admin, and member. Use `backend/utils/permissions.py` and backend dependencies as the source of truth; keep `frontend/src/permissions.ts` aligned for UX only.

- Owner: full trip control, promotion/demotion, and ownership transfer.
- Admin: trip/member management and broad expense/payment controls, except owner-only operations.
- Member: normal trip use within route-specific restrictions.
- Expense update/delete is limited to the expense creator or a trip admin.
- Member and family mutations are admin-only.
- Promotion, demotion, and ownership transfer are owner-only.
- Recording/editing/deleting a payment is restricted to the receiver's linked app user or a trip admin.
- Settlement/payment permissions must be checked against linked person accounts, including family sub-members.

Do not rely on hidden frontend buttons for security.

### People, Families, and Account Linking

- An email represents a person, never a family entity.
- A standalone individual stores identity at entity level.
- Keep a family's parallel arrays aligned by stable member ID: `family_members`, `family_member_ids`, `family_member_emails`, and `family_member_user_ids`.
- A family entity must not receive its own email or user account.
- Multiple people in one family may each link their own app account to a specific family sub-member slot.
- Joining or claiming a family always targets a specific unclaimed member slot; joining must not change cost allocation.
- Admin rights are per linked app user, not per family entity.
- Removing a member/family must preserve owner safety and evict vanished linked users from access/admin lists where required.
- The split engine must never use emails or user IDs as allocation weights.

### Expense Amounts and Refunds

- Normal expenses are positive; refunds are represented as signed negative expenses where supported.
- Spend rankings use gross positive amounts fronted by the payer and exclude refunds/zero rows.
- Reports and transaction views must preserve signed values and reconcile totals.

### Split Modes

All ledger allocation must flow through shared backend calculation helpers. Do not fork split math in routes, reports, or UI code.

#### `PER_CAPITA`

Divide by the total number of involved people. A selected individual's weight is 1. A family's weight is its involved member count:

1. use a stored `weight_snapshots` override when present;
2. otherwise use the count from `family_participants`;
3. otherwise use the full family size.

That same involved count determines the family entity's share and which family members receive its per-member expense breakdown. Excluded members receive zero for that expense.

#### `PER_FAMILY`

Divide equally among selected root entities: each family counts as one and each standalone individual counts as one, regardless of family size. Family participation can affect display breakdown but must not change the family entity's ledger share.

#### `EXACT`

`custom_amounts` maps person-level member IDs to explicitly assigned amounts. Key presence means involved; absence means zero. `family_participants` and `weight_snapshots` do not drive this mode.

- At least one amount must be positive, all amounts must be non-negative, IDs must be valid, and assigned amounts must sum to the expense total.
- The frontend disables Save while unreconciled, but backend create/edit validation is mandatory and returns HTTP 422 on mismatch.
- Reconciliation uses integer cents and largest-remainder snapping.
- Person amounts roll up to the existing entity-share ledger shape; family per-member display uses the typed proportions.
- Backend logic is centralized in `backend/services/custom_split.py`; frontend parity is pinned through `shared/exact-split-vectors.json`.

### Balances, Settlements, and Payments

- `backend/utils/balances.py::_compute_balances` is the read-time ledger source of truth;
  `backend/services/settlement_engine.py` owns canonical scaled arithmetic, joint rounding, and routing.
- The precise signed member vector must sum to zero. Never independently round member balances or
  transfers. Material imbalance is HTTP 409; only admins receive the diagnostic code/detail.
- `settlement_projection` is derived, not persisted. It exposes the immutable trip currency,
  increment, exact/rounded member nets, per-member adjustments, policy/tie-break metadata, route
  algorithm, optimality, state count, fallback reason, and greedy transfer-count bound.
- With `WHOLE_UNIT_SETTLEMENTS_ENABLED=true`, only LKR/NPR use a one-rupee increment. Joint
  largest-remainder rounding is deterministic (equal remainders prefer moving a negative balance
  toward zero, then stable member ID) and conserves the group total. Other currencies retain a
  conserving cent projection.
- Routing is dependency-free: exact zero-sum partition search proves the minimum transfer count for
  at most 12 non-zero entities within 100,000 deterministic states; otherwise heap-greedy routing
  emits at most debtors + creditors - 1 transfers. Never describe the fallback as globally minimal.
- Only non-pending legacy settlements offset balances; pending settlements do not.
- Historical expenses may retain a removed entity ID. They remain replayable only when that
  entity's complete precise position is exactly zero; whole-entity removal must not orphan a
  disclosed sub-cent residual.
- Payments are persistent directed ledger overlays. They reduce the current obligation, and the
  balance engine re-derives and may reroute residual pairs after any payment or later expense.
- Enabled LKR/NPR trips require whole rupees for new payments/settlements and amount edits. Legacy
  decimals remain valid; marking a legacy pending record paid and note-only legacy payment edits must
  preserve the original amount exactly.
- The backend recommendation list is authoritative. Payment history is chronological and separate
  from the live route; do not reattach old payments to newly derived pairs.
- Chronological family-member breakdown replays expenses plus effective settlement/payment events and scales running member positions. It is display-only and must always sum to the family entity net.
- Reports' settlement adjustment must include the same effective overlay used by the balance engine, including payments.

### Receipts

- New receipt content belongs in GridFS, not inline expense documents.
- Expense lists expose `has_receipt`; legacy inline `receipt_base64` is read only as a compatibility fallback.
- Receipt create/read/delete follows expense/trip authorization and cascade-delete behavior.
- Browser/media access may use tokenized URLs. Do not log or expose tokens.

### Reports

- XLSX and PDF reports must display the same engine-computed values; report builders must not implement independent allocation math.
- XLSX contains Summary, Members & Families, Split Math, Transactions, and Payments sections/tabs as currently assembled by `backend/routes/reports.py`.
- PDF is a full professional report assembled by `backend/services/report_pdf.py` from shared builders.
- Transactions use exploded per-person rows and preserve negative refunds.
- `GET /api/trips/{id}/report.xlsx` and `report.pdf` use a JWT `token` query parameter for browser-download compatibility. Preserve authorization and avoid leaking URLs.

### Trip Chat

- Chat is restricted to signed-in IDs in `trip.user_ids`, and sending additionally requires that the
  app account resolve to a standalone trip member or one exact family sub-member.
- Persisted messages snapshot the trip-specific sender/family display names. Historical attribution
  must not depend on the current roster or global account profile.
- REST writes are durable and idempotent before WebSocket events are broadcast. WebSocket auth is in
  the first frame, never a query-string JWT.
- Senders alone may edit/delete their own messages; deletion removes the original text and retains a
  tombstone. Only the trip owner may clear all chat history.
- Per-user read sequences live in MongoDB and must advance monotonically. Own messages and deleted
  tombstones do not count as unread.
- Production currently runs one backend worker, so the in-process realtime manager is sufficient.
  Add shared pub/sub before scaling to multiple workers or service instances.

## 7. Current Capability Snapshot

The 27-phase, 118-step implementation diary was removed. Current evidence is in `docs/APP_FEATURE_INVENTORY.md`; history remains in Git and `.claude/` plans/specs.

Broadly implemented areas include:

- modular FastAPI/Expo architecture;
- Gmail-only credential and Google authentication flows;
- trip creation/joining with person-level family account linking;
- owner/admin/member RBAC;
- `PER_CAPITA`, `PER_FAMILY`, and `EXACT` expenses;
- historical and manual multi-currency expense conversion with locked audit metadata and a guarded
  runtime rollout flag;
- receipts and gallery support;
- precise conserving balance calculation, optional whole-rupee LKR/NPR settlement projection,
  legacy settlements, and partial-payment ledger;
- spend/category/member drill-downs and date/time expense ordering;
- XLSX and PDF reporting;
- hosted-build configuration for Render, Vercel, Expo, and EAS.
- per-trip realtime text chat with MongoDB history, cross-device unread state, sender snapshots,
  optimistic retry, sender edits/deletion, and owner-only history clearing.

Historical roadmap caveats:

- Former Step 70 (member-spend drill-down) still lacked its live-API verification/commit gate even though implementation, docs, and local tests were present.
- Former Step 74 (PDF frontend/report integration) was left unchecked even though the frontend PDF URL/button code is present. Treat it as implemented but not fully live-verified until the end-to-end download is exercised.
- External services such as MongoDB, Resend, Google OAuth, Render, Vercel, Expo, and EAS can be configured in code while inactive or stale at runtime.

## 8. Change and Verification Rules

Before editing:

1. Read root and nested `CLAUDE.md`/`AGENTS.md` instructions applicable to the target files.
2. Inspect relevant `.claude/` commands, skills, plans, and specs, but confirm all claims against code.
3. Check Git status and preserve unrelated user changes.

While editing:

- Make the smallest coherent change.
- Do not silently alter API shapes, persisted document fields, RBAC, identity rules, split semantics, report reconciliation, or token handling.
- Keep backend source-of-truth logic and frontend mirrors synchronized.
- Add or update focused tests for behavior changes, including legacy/edge cases.
- Never expose `.env` values, JWTs, reset links, OAuth credentials, database URLs, or private deployment URLs.

Before finishing:

1. Run the narrowest relevant tests first, then broader checks proportional to risk.
2. For backend domain changes, cover pure unit tests and identify any live API/MongoDB suite not run.
3. For frontend changes, run relevant Jest tests, TypeScript checking, and lint when available.
4. For split/report changes, verify cent-level reconciliation and parity across ledger, UI helpers, XLSX, and PDF.
5. Review the final diff and confirm only intended files changed.
6. Update `docs/APP_FEATURE_INVENTORY.md`, `USER_GUIDE.md`, and relevant plans/specs when a feature's actual status or behavior changes.
7. Report commands run, results, limitations, and unverified runtime dependencies accurately.

Do not mark planned work as implemented, and do not claim end-to-end verification from code inspection or unit tests alone.
