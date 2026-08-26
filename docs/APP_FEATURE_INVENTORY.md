# App Feature Inventory

This is a code-first inventory of the repository as it existed on 2026-08-22. Plans, roadmap checkboxes, specs, user guides, and Claude instructions were treated as supporting evidence only. A feature is described as current only when a corresponding code path was found.

Status meanings used below:

- **Implemented and verified**: implementation was found and a relevant automated test or direct static verification passed during this audit.
- **Implemented but unverified**: implementation was found, but its live or external integration was not exercised during this audit.
- **Partially implemented**: only part of the advertised behavior is active, or a material path is intentionally unavailable.
- **Configured but inactive**: configuration exists, but runtime activation/deployment was not demonstrated.
- **Planned/specification only**: described in repository documentation but not found in the current code.
- **Deprecated or disabled**: retained for compatibility or deliberately hidden from the current UI.

## Snapshot

- **Date:** 2026-08-22 (Asia/Calcutta).
- **Git branch:** `main`.
- **Commit before this feature work:** `35b8f1b31722b50d478c55924f82249f41d5d776`.
- **Repository state at feature start:** clean according to `git status --short`.
- **Verification run:** 443 self-contained backend tests passed, including 18 focused chat tests; application-source Python compilation, TypeScript `--noEmit`, and targeted ESLint passed; the full frontend Jest run passed 370/370 tests. Live HTTP/MongoDB chat tests were added but not run because Docker was unavailable and the configured MongoDB endpoint did not respond to a bounded ping.

## Application Summary

Trip Splitter is a collaborative trip-expense application for mobile and web. It serves groups whose costs may be attributed to standalone people or family units. Authenticated users create or join trips, chat under their trip-specific person identity, record positive expenses and negative refunds, split each transaction per person, per family, or by exact per-person amounts, inspect balances, record partial payments, attach receipt images, and export reports.

The code is substantially ahead of the older MVP documents. Current code includes per-person family identity linking, three-tier trip RBAC, GridFS receipts, partial payments, exact splits, and PDF reports. Older claims in [memory/ARCHITECTURE.md](../memory/ARCHITECTURE.md#L251) and [memory/PRD.md](../memory/PRD.md#L28) that receipts are inline and PDF/RBAC are future work are no longer accurate.

## Technology and Architecture

### Languages, frameworks, and packages

| Area | Current structure | Evidence |
|---|---|---|
| Frontend | TypeScript, React 19, React Native 0.81, Expo SDK 54, Expo Router 6, React Navigation, Jest, ESLint | [frontend/package.json](../frontend/package.json#L1) |
| Backend | Python 3.11 container, FastAPI, Pydantic 2, Motor/PyMongo, Uvicorn locally and Gunicorn/Uvicorn in production | [backend/requirements.txt](../backend/requirements.txt#L1), [backend/Dockerfile](../backend/Dockerfile#L4), [backend/Dockerfile.prod](../backend/Dockerfile.prod#L19) |
| Shared fixtures | JSON vectors keep frontend and backend exact-split rounding aligned | [shared/exact-split-vectors.json](../shared/exact-split-vectors.json#L1) |
| Root package | The root Node package only declares `headroom-ai`; the application package is under `frontend/` | [package.json](../package.json#L1) |

### Main applications and boundaries

- `backend/server.py` is the FastAPI assembly point. It registers auth, trips, members, expenses, balances, reports, metadata, receipts, spend, payments, and chat routers under `/api` ([backend/server.py](../backend/server.py#L135)).
- `backend/models/`, `routes/`, `services/`, and `utils/` separate request schemas, HTTP handling, pure business/report logic, and cross-cutting helpers.
- `frontend/app/` uses file-based routes. The persistent tab bar currently contains Home, Trips, Reports, and Profile ([frontend/app/(tabs)/_layout.tsx](<../frontend/app/(tabs)/_layout.tsx#L55>)); transaction creation is reached from trip screens and `app/add.tsx`, not a visible fifth tab.
- `frontend/src/` contains the API client, auth/theme contexts, permissions mirror, split/payment helpers, receipt viewer, charts, and shared UI system.

### Database and storage

MongoDB is accessed through Motor ([backend/database.py](../backend/database.py#L1)). Documents use application UUID strings in `id` fields rather than exposing Mongo `_id` values.

| Storage | Purpose |
|---|---|
| `users` | Account identity, hashed password/PIN, global role label, verification and credential flags |
| `trips` | Trip metadata, share code, access arrays, and the embedded member/family roster |
| `expenses` | Signed transactions, payer, participants, split mode, snapshots, exact amounts, and receipt reference |
| `settlements` | Legacy completed settlements and the older pending-to-paid lifecycle |
| `payments` | Current partial-payment log over suggested debtor/creditor pairs |
| `chat_messages` | Per-trip text history, sent-time attribution, edits, and deletion tombstones |
| `chat_reads` | Per-trip/per-user last-read sequence for cross-device unread counts |
| `chat_counters` | Stable per-trip message sequencing and owner clear-history boundary |
| `auth_tokens` | Hashed, typed, expiring email-verification/password-reset tokens |
| `password_reset_tokens` | Older raw-token store used only by the legacy email-based PIN reset path |
| GridFS `receipts.files` / `receipts.chunks` | Receipt images, indexed by owning expense metadata |

Indexes, compatibility migrations, admin seeding, member-id backfills, and family-email demotion run during application lifespan startup ([backend/server.py](../backend/server.py#L22)). Startup is therefore not read-only against the database.

### Authentication and authorization

- JWT bearer authentication uses HS256 and resolves the current user from the `Authorization` header ([backend/utils/deps.py](../backend/utils/deps.py#L10)). Tokens are stored in frontend AsyncStorage ([frontend/src/api.ts](../frontend/src/api.ts#L6)).
- Registration and all identity-email inputs are Gmail-only; password length is at least nine characters and the PIN is four digits ([backend/routes/auth.py](../backend/routes/auth.py#L61)).
- Google ID-token login is implemented but requires platform client IDs on the client and accepted audiences on the backend ([frontend/src/GoogleSignInButton.tsx](../frontend/src/GoogleSignInButton.tsx#L15), [backend/routes/auth.py](../backend/routes/auth.py#L184)).
- Trip authorization is independent of the user's global `role` field. Trip owner/admin/member is derived from `owner_id`, `admin_ids`, and `user_ids` ([backend/utils/permissions.py](../backend/utils/permissions.py#L21)).

### External services

- **MongoDB/Atlas:** required for all live backend behavior.
- **Google OAuth:** conditionally rendered per platform; external sign-in was not exercised.
- **Resend:** optional transactional email transport. The backend can disable email features at runtime or log links when a sender is unavailable ([backend/config.py](../backend/config.py#L20)).
- **Expo/EAS:** native builds and credentials are configured.
- **Render:** backend blueprint and health check are configured ([render.yaml](../render.yaml#L5)).
- **Vercel:** static Expo web export and SPA rewrite are configured ([frontend/vercel.json](../frontend/vercel.json#L1)).

No external deployment, OAuth exchange, email delivery, or hosted database was contacted during this audit.

### Deployment and build structure

- Local full stack: MongoDB 7 plus FastAPI through Docker Compose; the Expo client remains host-run ([docker-compose.yml](../docker-compose.yml#L1)).
- Local backend container: Python 3.11 plus Uvicorn on port 8000 ([backend/Dockerfile](../backend/Dockerfile#L4)).
- Production backend: one Gunicorn/Uvicorn worker bound to the platform port ([backend/Dockerfile.prod](../backend/Dockerfile.prod#L16)).
- Web frontend: `npx expo export -p web` to `dist`, hosted as an SPA ([frontend/vercel.json](../frontend/vercel.json#L3)).
- Native frontend: EAS profiles exist at both repository root and `frontend/`; these copies currently disagree on package/project identity and should not be treated as interchangeable.

## Current Features

| Feature | Status | User-facing behavior | Entry point/UI/API | Code evidence | Tests/verification | Limitations |
|---|---|---|---|---|---|---|
| Gmail registration, password/PIN login, JWT session | Implemented but unverified | Users register with name, Gmail, password, and PIN; subsequent login is PIN-first with remembered email, while the API also accepts password login | `(auth)/register`, `(auth)/login`, `(auth)/pin-login`; `POST /auth/register`, `POST /auth/login`, `GET /auth/me` | [backend/routes/auth.py](../backend/routes/auth.py#L61), [frontend/src/AuthContext.tsx](../frontend/src/AuthContext.tsx#L63) | Integration tests exist in [backend/tests/test_auth.py](../backend/tests/test_auth.py#L35), but live API tests were not run | Requires MongoDB and correctly configured JWT secret; Gmail-only is a product restriction |
| Google sign-in and first-time credential setup | Implemented but externally unverified | Android uses Credential Manager with the Web OAuth audience; web/iOS retain AuthSession; new OAuth users are routed to set a PIN and password | `GoogleSignInButton.android`, `GoogleSignInButton`, `/set-credentials`; `POST /auth/google`, `POST /auth/set-credentials` | [frontend/src/GoogleSignInButton.android.tsx](../frontend/src/GoogleSignInButton.android.tsx), [frontend/src/GoogleSignInButton.tsx](../frontend/src/GoogleSignInButton.tsx), [backend/routes/auth.py](../backend/routes/auth.py#L184) | Focused Android tests and TypeScript pass; external OAuth still requires package/SHA and production audience verification | Hidden in Expo Go or when the required client ID is absent; backend must accept the Web audience used by Android |
| Email verification and email password reset | Partially implemented | Verification banner/link flow and token-based password-reset screens/routes exist | `/verify-email`, `(auth)/forgot-password`, `/reset-password`; verification/reset APIs | [backend/routes/auth.py](../backend/routes/auth.py#L229), [frontend/src/UnverifiedBanner.tsx](../frontend/src/UnverifiedBanner.tsx#L1) | Related frontend tests passed, including [verify-email.test.tsx](../frontend/src/__tests__/screens/verify-email.test.tsx#L54) | The login-screen “Forgot password?” link is hardcoded off ([login.tsx](<../frontend/app/(auth)/login.tsx#L12>)); the entire email feature can also be runtime-disabled |
| PIN recovery and signed-in password change | Implemented but unverified | “Forgot PIN?” verifies email plus account password and sets a new PIN; Profile links to password change | `(auth)/forgot`, `/change-password`; `POST /auth/reset-pin-by-password`, `POST /auth/change-password` | [frontend/app/(auth)/forgot.tsx](<../frontend/app/(auth)/forgot.tsx#L20>), [backend/routes/auth.py](../backend/routes/auth.py#L167) | TypeScript passed; live account mutation was not exercised | A separate legacy emailed PIN-token API remains and logs/stores raw reset tokens |
| Session persistence, logout, and route guard | Implemented and verified | Token/session is restored from AsyncStorage; logout uses a themed confirmation and resets navigation; signed-out users are redirected from protected routes | Root layout, Profile, avatar header | [frontend/app/_layout.tsx](../frontend/app/_layout.tsx#L23), [frontend/src/AuthContext.tsx](../frontend/src/AuthContext.tsx#L101) | Logout/auth-navigation Jest tests passed ([logout.test.ts](../frontend/src/__tests__/logout.test.ts#L10)); TypeScript passed | No refresh-token flow; an invalid/expired token clears the local session |
| Trip create/list/view/edit/delete and share code | Implemented but unverified | Users create trips with date range, budget, currency, and individual/family self-identity; share a six-character code; admins edit; owner deletes | `/create-trip`, Trips/Home, `/trip/[id]`; trip CRUD APIs | [frontend/app/create-trip.tsx](../frontend/app/create-trip.tsx#L47), [backend/routes/trips.py](../backend/routes/trips.py#L59) | Date/identity helper tests passed; live CRUD was not run | Currency changes only relabel values; they do not convert historical amounts |
| Contextual join wizard and per-person family account linking | Implemented but unverified | A code preview supports joining as an individual, linking to a specific open family-member slot, creating a new family, or claiming a matching stub | `/join-trip`; `POST /trips/join/preview`, `POST /trips/join` | [frontend/app/join-trip.tsx](../frontend/app/join-trip.tsx#L64), [backend/routes/trips.py](../backend/routes/trips.py#L355) | Frontend join-decision tests passed ([joinIdentity.test.ts](../frontend/src/__tests__/joinIdentity.test.ts#L20)); extensive live tests exist but were not run | Concurrency and database identity reconciliation were not exercised live; legacy action-less API behavior remains |
| Member/family administration and contact identity | Implemented but unverified | Admins add/edit/remove people and families; family sub-members have stable IDs, optional Gmail contacts, and server-managed linked accounts | Trip Members tab and add/edit/manage-member screens; member APIs | [backend/models/member.py](../backend/models/member.py#L6), [backend/routes/members.py](../backend/routes/members.py#L41) | Existing pure member/email helper coverage remains green in the selected backend run | A family entity itself cannot own an email/account; removal is blocked while balances remain |
| Per-trip realtime text chat | Implemented and verified locally | A fifth trip tab provides MongoDB-backed text history, trip-person sender labels, exact cross-device unread counts, optimistic retry, sender edit/delete tombstones, reconnect catch-up, and owner-only clearing | Trip Chat tab; chat REST APIs and authenticated WebSocket | [frontend/src/TripChat.tsx](../frontend/src/TripChat.tsx#L1), [frontend/src/useTripChat.ts](../frontend/src/useTripChat.ts#L1), [backend/routes/chat.py](../backend/routes/chat.py#L1) | 18 backend chat tests plus frontend helper, component, tab, TypeScript, lint, and full Jest verification passed | Live HTTP/MongoDB/WebSocket round-trip was not run; realtime fan-out is intentionally process-local while production uses one worker; text-only with no push/presence/media |
| Owner/admin/member RBAC and ownership transfer | Implemented and verified | Members view and add their own data; admins manage members/settings and any expense; only owner manages admins, transfers ownership, or deletes the trip | Manage Member, trip action controls; admin/ownership APIs | [backend/utils/permissions.py](../backend/utils/permissions.py#L39), [frontend/src/permissions.ts](../frontend/src/permissions.ts#L41), [backend/routes/trips.py](../backend/routes/trips.py#L539) | Frontend permission suite passed ([permissions.test.ts](../frontend/src/__tests__/permissions.test.ts#L13)); backend guard paths were statically rechecked | Backend live RBAC tests were not run; global user `role="admin"` does not grant access to unrelated trips |
| Expense/refund CRUD, categories, date/time, and ordering | Implemented but unverified | Any trip member can add a transaction; creator/admin can edit/delete; negative nonzero amounts represent money returned; lists sort newest first by parsed date/time | Add/Edit Transaction and Expenses tab; expense CRUD APIs | [backend/models/expense.py](../backend/models/expense.py#L11), [backend/routes/expenses.py](../backend/routes/expenses.py#L54), [frontend/src/expenseSort.ts](../frontend/src/expenseSort.ts#L1) | Ordering tests passed ([expenseSort.test.ts](../frontend/src/__tests__/expenseSort.test.ts#L12)); TypeScript passed | Live CRUD not run; edit does not repeat all create-time category/member/budget validations |
| Budget warning and force-save | Partially implemented | Creating an expense over budget returns a confirmation response and can be re-submitted with `force=true`; refunds reduce net spend | Add Transaction; `POST /trips/{id}/expenses?force=true` | [backend/routes/expenses.py](../backend/routes/expenses.py#L80), [frontend/app/trip/[id]/add-expense.tsx](../frontend/app/trip/[id]/add-expense.tsx#L156) | Static code verification only | Editing an expense does not re-run the budget warning, so edits can silently exceed budget |
| Per-capita split | Implemented and verified | Cost is divided by involved humans, including selected family-member participation and weight snapshots | Add/Edit split selector; balances and reports | [backend/services/calculator.py](../backend/services/calculator.py#L119), [backend/services/expense_shares.py](../backend/services/expense_shares.py#L78) | Per-capita, expense-share, report, and split-bug tests passed; reference tests start at [test_per_capita.py](../backend/tests/test_per_capita.py#L6) | Family size/participation semantics are complex; live API persistence was not exercised |
| Per-family split | Implemented and verified | Each selected root entity owes one equal share regardless of family size | Add/Edit split selector; balances and reports | [backend/services/calculator.py](../backend/services/calculator.py#L134) | Per-family and report tests passed ([test_per_family.py](../backend/tests/test_per_family.py#L6)) | Intra-family display breakdown is separate from the entity ledger |
| Exact per-person split | Implemented and verified | The author selects individual people and assigns explicit amounts; Save is gated until the assigned amount matches the total; backend rejects mismatches with 422 | Add/Edit Exact editor; expense APIs | [backend/services/custom_split.py](../backend/services/custom_split.py#L68), [backend/routes/expenses.py](../backend/routes/expenses.py#L74), [frontend/src/ExactSplitEditor.tsx](../frontend/src/ExactSplitEditor.tsx#L1) | Backend exact/share/report tests and frontend exact tests passed ([test_exact_split.py](../backend/tests/test_exact_split.py#L44), [exactSplit.test.ts](../frontend/src/__tests__/exactSplit.test.ts#L25)) | Live create/edit round-trip was not exercised |
| Family participation and historical reallocation | Implemented and verified | A family expense may include only selected sub-members; changing family size can reweight history or freeze old weights | Edit Member confirmation; member update/reallocation service | [backend/routes/members.py](../backend/routes/members.py#L166), [backend/services/reallocation.py](../backend/services/reallocation.py#L1) | Reallocation/family participation tests remain part of the backend unit coverage | Mongo transaction/fallback behavior was not exercised against a live server |
| Balance ledger, greedy settle suggestions, per-member family breakdown | Implemented and verified | Trip users see entity net balances, minimum-transfer suggestions, and chronological family sub-member balances | Balances tab; `GET /trips/{id}/balances` | [backend/utils/balances.py](../backend/utils/balances.py#L1), [backend/services/calculator.py](../backend/services/calculator.py#L184), [backend/services/member_breakdown.py](../backend/services/member_breakdown.py#L1) | Calculator, split, breakdown, report, and adversarial settle-up tests passed | Algorithm is greedy over cent-rounded net values; live database aggregation was not exercised |
| Legacy settlement lifecycle | Deprecated or disabled | APIs can still create completed settlements or pending records and mark pending records paid | `POST /settle`; settlement list/create/patch APIs | [backend/models/settlement.py](../backend/models/settlement.py#L6), [backend/routes/balances.py](../backend/routes/balances.py#L24) | Pure settlement helpers passed; live APIs not run | Current settle-up UI uses `payments`, not these endpoints; retained for compatibility |
| Partial payments | Implemented and verified | Receiver or trip admin records, edits, or deletes partial payments up to the current suggested amount; UI shows open/partial/paid pair state and payment history | `/trip/[id]/settle-up`; payment CRUD APIs | [backend/routes/payments.py](../backend/routes/payments.py#L24), [frontend/app/trip/[id]/settle-up.tsx](../frontend/app/trip/[id]/settle-up.tsx#L57) | Backend payment roll-up and frontend payment/adversarial tests passed ([test_payments_rollup.py](../backend/tests/test_payments_rollup.py#L10), [payments.test.ts](../frontend/src/__tests__/payments.test.ts#L22)) | Live optimistic-concurrency guard and authorization were not exercised |
| Receipt acquisition, GridFS upload/view/remove, save to gallery | Implemented but unverified | Users pick/capture a receipt, upload it after saving an expense, view it on demand, replace/remove it, and save it to the device gallery | Add/Edit Transaction, Gallery-like receipt views; receipt APIs | [frontend/src/api.ts](../frontend/src/api.ts#L101), [frontend/src/ReceiptViewer.tsx](../frontend/src/ReceiptViewer.tsx#L19), [backend/routes/receipts.py](../backend/routes/receipts.py#L44) | Receipt parsing helpers passed ([receipt.test.ts](../frontend/src/__tests__/receipt.test.ts#L3)); live multipart/GridFS tests exist at [test_receipts.py](../backend/tests/test_receipts.py#L20) but were not run | Device permissions and native/web file behavior were not exercised; legacy inline receipts are read-only fallback |
| Dashboard, personal trip balances, spend ranking, and drill-downs | Implemented and verified | Home groups the authenticated person's net position by currency; trip Summary shows category/entity charts; category drill-down reconciles net/gross/refunds and ranks positive amounts by payer above amount-ordered transactions | Home/Trips, Trip Summary, and Category detail; `GET /balances`, `/expenses`, `/spend-summary` | [frontend/app/(tabs)/dashboard.tsx](<../frontend/app/(tabs)/dashboard.tsx#L1>), [frontend/app/trip/[id]/category/[name].tsx](<../frontend/app/trip/[id]/category/[name].tsx#L1>), [frontend/src/categorySpend.ts](../frontend/src/categorySpend.ts#L1) | Category aggregation, Android touch callback, concrete-route navigation, category render, authenticated balance, and spend-ranking tests passed | Signed-APK physical-device verification remains post-publication; payer rankings count positive fronted amounts and show refunds separately |
| JSON report summary | Implemented but unverified | Returns trip, signed total, budget, category/date totals, and balances | `GET /trips/{id}/report` | [backend/routes/reports.py](../backend/routes/reports.py#L61) | Static review only | Date rows are sorted by stored `DD-MM-YY` strings, which is not chronologically reliable across years |
| XLSX report | Implemented and verified | Downloads five tabs: Summary, Members & Families, Split Math, exploded Transactions, and Payments | Reports tab; `GET /report.xlsx?token=...` | [frontend/app/(tabs)/reports.tsx](<../frontend/app/(tabs)/reports.tsx#L25>), [backend/routes/reports.py](../backend/routes/reports.py#L84) | Report builder/layout tests passed ([test_report_builder.py](../backend/tests/test_report_builder.py#L44), [test_report_layout.py](../backend/tests/test_report_layout.py#L35)) | HTTP download was not run; JWT appears in the URL query string; reports cap fetched rows at 5,000 |
| PDF report | Implemented but unverified | Reports tab exposes PDF alongside XLSX; backend builds a full multi-section landscape report | Reports tab; `GET /report.pdf?token=...` | [frontend/src/api.ts](../frontend/src/api.ts#L95), [frontend/app/(tabs)/reports.tsx](<../frontend/app/(tabs)/reports.tsx#L57>), [backend/routes/reports.py](../backend/routes/reports.py#L328) | Builders/type-check passed, but no live PDF download/render inspection was performed | Root roadmap Step 74 remains unchecked even though the UI code exists; query-string JWT has the same exposure caveat as XLSX |
| Theme, shared UI system, profile avatar, and responsive web/mobile navigation | Implemented and verified | Persisted light/dark mode, shared components, four-tab navigation, profile avatar header, modal-specific headers, and web theming | Root/tab layouts, Profile, shared `ui/` | [frontend/src/ThemeContext.tsx](../frontend/src/ThemeContext.tsx#L20), [frontend/app/_layout.tsx](../frontend/app/_layout.tsx#L41) | TypeScript and ESLint passed; broad frontend helper/render tests passed | No visual/device QA was performed in this audit |
| Health/config/categories metadata | Implemented and verified | Public health check, category list, and runtime email-feature flag | `GET /health`, `/meta/categories`, `/meta/config` | [backend/routes/meta.py](../backend/routes/meta.py#L9) | Simple route implementation statically verified; live HTTP not run | Health deliberately does not prove database health |
| Local/hosted deployment wiring | Configured but inactive | Compose, Render backend, Vercel web, and EAS native profiles are present | Deployment/config files | [docker-compose.yml](../docker-compose.yml#L7), [render.yaml](../render.yaml#L5), [frontend/vercel.json](../frontend/vercel.json#L1), [frontend/eas.json](../frontend/eas.json#L1) | Configuration review only | No deployment was contacted; duplicate root/frontend Expo/EAS identities conflict |

## User Roles and Permissions

Trip roles are per trip. The seeded account's global `users.role = "admin"` is not consulted by the trip permission matrix and does not bypass trip membership.

| Capability | Unauthenticated/non-member | Member | Admin | Owner |
|---|---:|---:|---:|---:|
| View trip, expenses, balances, reports, receipts, payments | No | Yes | Yes | Yes |
| Read/send trip chat | No | Yes | Yes | Yes |
| Edit/delete own chat messages | No | Yes | Yes | Yes |
| Clear all chat history | No | No | No | Yes |
| Add an expense | No | Yes | Yes | Yes |
| Edit/delete own expense | No | Yes | Yes | Yes |
| Edit/delete any expense | No | No | Yes | Yes |
| Upload/remove an expense receipt | No | Creator only | Yes | Yes |
| Edit trip settings | No | No | Yes | Yes |
| Add/edit/remove members and families | No | No | Yes | Yes |
| Promote/demote admins | No | No | No | Yes |
| Transfer ownership | No | No | No | Yes |
| Delete trip | No | No | No | Yes |
| Record/edit/delete a partial payment | No | Receiver only | Yes | Yes |
| Mark an old pending settlement paid | No | Creditor/lender only | Yes | Yes |

Backend guards are authoritative ([backend/utils/deps.py](../backend/utils/deps.py#L20)); the frontend predicates only hide controls for better UX ([frontend/src/permissions.ts](../frontend/src/permissions.ts#L1)). Removing the owner, the last family member, or a person/family with outstanding balances is additionally blocked by member routes.

## Developer Commands and Workflows

Commands below are documented or defined by the repository. They were not run merely because they were documented.

| Command/workflow | Purpose and important parameters | Safety/state impact |
|---|---|---|
| `cd backend; python -m venv .venv; pip install -r requirements.txt` | Create backend environment and install pinned runtime dependencies | Changes local files/environment; network/package install |
| `cd backend; uvicorn server:app --reload` | Run API on the local development port | Changes database state at startup through indexes, backfills, migrations, and admin seed |
| `cd backend; pytest` | Run full backend suite | Many tests use a live URL and create/mutate test data; requires running API/MongoDB ([backend/tests/conftest.py](../backend/tests/conftest.py#L1)) |
| `cd backend; pytest tests/test_calculator.py` | Run a pure backend unit file without a server | Read-only apart from normal test caches/bytecode unless disabled |
| `cd frontend; yarn install` | Install Expo/React dependencies | Changes `node_modules` and may update package-manager metadata |
| `yarn start`, `yarn web` | Start Expo dev server for device QR or web | Starts local processes/caches; no intended source mutation |
| `yarn android`, `yarn ios` | Run native projects using `expo run:*` | Can generate native projects/build outputs and use device tooling |
| `yarn test` | Run Jest suite | Intended read-only; cache may be written unless disabled |
| `yarn lint` | Run Expo ESLint | Read-only unless invoked with a fix flag; in this shell the wrapper could not find `yarnpkg`, so ESLint was invoked directly |
| `npx tsc --noEmit` | Strict TypeScript verification | Read-only; not a package script but used as a verification gate in roadmap docs |
| `yarn reset-project` | Expo starter reset script | **Destructive/high risk:** interactively moves or deletes `app`, `components`, `hooks`, `constants`, and `scripts`, then creates a blank app ([frontend/scripts/reset-project.js](../frontend/scripts/reset-project.js#L1)) |
| `docker compose up -d --build` | Build/start MongoDB and backend | Creates containers/images and mutates the named database volume |
| `docker compose down` | Stop local stack while keeping data | Changes runtime state; named volume retained |
| `docker compose down -v` | Stop stack and delete database volume | **Destructive:** erases local Compose database data ([docker-compose.yml](../docker-compose.yml#L4)) |
| `eas build --platform android --profile preview` | Build an installable Android preview | Changes external EAS build state; may consume credentials/quota ([docs/ANDROID_APK.md](ANDROID_APK.md#L24)) |
| `eas credentials` | Inspect/manage native signing credentials | External state may change depending on subsequent choices |
| Vercel `npx expo export -p web` build | Produce static web output in `dist` | Writes build output; hosting deployment changes external state |
| Claude `/create_spec <step> <feature>` | Checks clean status, switches/pulls `main`, creates a feature branch, researches code, and writes a spec | **State-changing:** Git checkout/pull/branch and file creation; not safe/read-only ([.claude/commands/create_spec.md](../.claude/commands/create_spec.md#L1)) |

The root `package.json` defines no application scripts. The canonical frontend commands are in [frontend/package.json](../frontend/package.json#L5), while backend commands are documented in [README.md](../README.md#L38) and [CLAUDE.md](../CLAUDE.md#L55).

## Available Claude Skills

Only one repository-local Claude skill exists:

| Skill | Intended purpose and use | Dependencies/notes |
|---|---|---|
| `context` | Load full project context before any non-trivial task/new session, optionally focusing on an argument; produce a short architecture/tech-debt briefing before work | Reads root `CLAUDE.md`, `memory/ARCHITECTURE.md`, `memory/PRD.md`, and all other memory files. It explicitly forbids echoing secrets ([.claude/skills/context/SKILL.md](../.claude/skills/context/SKILL.md#L1)). `memory/test_credentials.md` exists, but credential values were deliberately not copied into this inventory. |

`.claude/settings.local.json` also supplies a local Claude endpoint override. It is configuration, not a skill, and its URL is intentionally omitted here.

## Plans and Specifications

### Plan files

| Plan | Intended work | Current code status |
|---|---|---|
| [plan_01_modularizeBackend.md](../.claude/plan/plan_01_modularizeBackend.md#L1) | Split monolithic backend into config/database/models/routes/utils | Implemented and verified by current structure and the passing backend unit subset |
| [plan_02_RBAC_infrastructure.md](../.claude/plan/plan_02_RBAC_infrastructure.md#L1) | Add `admin_ids`, owner seed/backfill, admin guards and endpoints | Implemented; later owner-only controls supersede the plan's original “any admin manages admins” behavior |
| [03-unique-family-individual-mapping.md](../.claude/plan/03-unique-family-individual-mapping.md#L1) | Name/email uniqueness, Gmail-only inputs, Google sign-in, test migration | Mostly implemented; entity-level family email assumptions were later retired in favor of per-person sub-member emails/accounts |
| [04-split-mode.md](../.claude/plan/04-split-mode.md#L1) | Persist strict per-capita/per-family enum | Implemented and later expanded with `EXACT` |
| [05-isolate-math.md](../.claude/plan/05-isolate-math.md#L1) | Extract pure settlement calculator and tests | Implemented and verified |
| [phase-22-exact-amount-split-prompt.md](../.claude/plan/phase-22-exact-amount-split-prompt.md#L1) | Full person-level exact split through ledger, reports, UI, and tests | Implemented and verified at pure/unit level; live API round-trip not run in this audit |

### Specification files

Every spec's own Definition of Done checkboxes is still unchecked. Those checkboxes are historical template state, not evidence that the requirement is absent. The root roadmap and, more importantly, current code often show the work landed.

| Spec | Requirement summary | Status against current code |
|---|---|---|
| [02-rbac-infrastructure.md](../.claude/specs/02-rbac-infrastructure.md#L1) | Trip `admin_ids`, owner seed/backfill, admin APIs | Implemented; later tightened so only owner manages admins |
| [03-unique-family-individual-mapping.md](../.claude/specs/03-unique-family-individual-mapping.md#L1) | Unique roster names/emails and join collision handling | Implemented, then identity model superseded family entity emails with per-person emails |
| [04-split-mode.md](../.claude/specs/04-split-mode.md#L1) | Persist `PER_CAPITA`/`PER_FAMILY` | Implemented and expanded with `EXACT` |
| [05-isolate-math.md](../.claude/specs/05-isolate-math.md#L1) | Pure greedy settlement calculator | Implemented and verified |
| [06-per-capita-math-edge-cases.md](../.claude/specs/06-per-capita-math-edge-cases.md#L1) | Human-count split and edge cases | Implemented and verified |
| [07-per-family-math.md](../.claude/specs/07-per-family-math.md#L1) | Flat root-entity split | Implemented and verified |
| [08-size-mutation-calculations.md](../.claude/specs/08-size-mutation-calculations.md#L1) | Historical reallocation/freeze on family size change | Implemented and verified at service level |
| [09-synchronizing-excel-report.md](../.claude/specs/09-synchronizing-excel-report.md#L1) | Split-aware XLSX validation tabs | Implemented, then superseded by the current five-tab professional report |
| [10-expense-modification-protection.md](../.claude/specs/10-expense-modification-protection.md#L1) | Creator-or-admin expense mutation | Implemented |
| [11-member-administration.md](../.claude/specs/11-member-administration.md#L1) | Admin-only member mutations | Implemented |
| [12-new-joiner-choices.md](../.claude/specs/12-new-joiner-choices.md#L1) | Contextual preview and join modes | Implemented and later expanded to per-person family slots |
| [13-interactive-join-wizard.md](../.claude/specs/13-interactive-join-wizard.md#L1) | Multi-step join UI | Implemented |
| [14-admin-controls-member-tab.md](../.claude/specs/14-admin-controls-member-tab.md#L1) | Role badges and admin member controls | Implemented; admin-role toggles are now owner-only and can target linked sub-members |
| [15-family-recalculation-prompt.md](../.claude/specs/15-family-recalculation-prompt.md#L1) | Retroactive versus future-only confirmation | Implemented |
| [16-split-mode-selector.md](../.claude/specs/16-split-mode-selector.md#L1) | Add/Edit per-person/per-family selector and preview | Implemented and expanded with Exact |
| [17-rbac-driven-component.md](../.claude/specs/17-rbac-driven-component.md#L1) and [companion plan](../.claude/specs/17-rbac-driven-component.plan.md#L1) | Hide unauthorized expense controls and add Jest | Implemented and verified |
| [18-layout-ui-standardization.md](../.claude/specs/18-layout-ui-standardization.md#L1) | Shared design tokens and trip-composition labels | Implemented and verified by helper/tests/type-check |
| [19-logout-clean-ui-logic.md](../.claude/specs/19-logout-clean-ui-logic.md#L1) | Shared global logout with modal exclusions | Implemented, then header logout icon was replaced by profile avatar while logout remained on Profile |
| [20-gallery-pipeline.md](../.claude/specs/20-gallery-pipeline.md#L1) | Camera/library acquisition and save to gallery | Implemented; its inline-base64 backend assumption was superseded by GridFS |
| [21-working-logout-button.md](../.claude/specs/21-working-logout-button.md#L1) | Cross-platform themed logout and navigation reset | Implemented and verified |
| [22-attaching-bills-image.md](../.claude/specs/22-attaching-bills-image.md#L1) | Dedicated multipart/GridFS receipt pipeline | Implemented; live multipart/GridFS not verified in this audit |
| [23-owner-admin-member-control-differences.md](../.claude/specs/23-owner-admin-member-control-differences.md#L1) | Canonical role matrix and ownership transfer | Implemented; frontend predicates verified, live API tests not run |

### Already implemented requirements

- Roadmap Phases 1-27 are broadly represented in current code, including later family-person identity phases even though those phases have no separate `.claude/specs/` files.
- The split engine, report builders, member participation/reallocation, payment roll-up, frontend permission mirror, logout navigation, and most UI helpers have passing unit coverage from this audit.
- PDF UI code requested by unchecked Roadmap Step 74 is present at [frontend/src/api.ts](../frontend/src/api.ts#L95) and [frontend/app/(tabs)/reports.tsx](<../frontend/app/(tabs)/reports.tsx#L25>).

### Partially implemented requirements

- Roadmap Step 70 remains unchecked because its stated live-API/commit verification gate was not completed. This audit passed the backend pure subset, TypeScript, and lint; full Jest had one timeout that passed in isolation.
- Roadmap Step 74 remains unchecked. Its frontend code is implemented, but this audit did not prove the live PDF endpoint/download/render path.
- Email password recovery has backend and deep-link screens but is intentionally undiscoverable from the login screen.
- Budget enforcement is complete on create but absent on edit.

### Requirements not found in current code

The older PRD lists live foreign-exchange conversion, push notifications, and offline synchronization as future work ([memory/PRD.md](../memory/PRD.md#L28)). No implementation was found; these are **Planned/specification only**, not current features.

### Requirements whose status cannot be determined

- Whether Render, Vercel, Atlas, Resend, Google OAuth, or EAS configurations are currently deployed and healthy.
- Whether the full live HTTP/MongoDB suite is green at this commit.
- Whether roadmap “committed” claims match repository history, because the Git executable was unavailable and commit history was not inspected.

## Known Gaps and Risks

- **Live integration is unverified.** Chat API/WebSocket tests require a running service and MongoDB; the configured endpoint timed out and Docker Desktop was unavailable during this feature verification.
- **Realtime fan-out is single-process.** The production image currently runs one worker, matching the in-process chat connection manager. Multiple workers/instances require shared pub/sub before rollout.
- **Password reset is intentionally hidden.** `SHOW_FORGOT_PASSWORD = false` prevents normal login-screen discovery even when email features are enabled ([login.tsx](<../frontend/app/(auth)/login.tsx#L12>)).
- **Budget edits bypass the warning.** `ExpenseUpdate.force` is excluded and updates are written without recomputing budget ([backend/routes/expenses.py](../backend/routes/expenses.py#L142)). Updates also do not repeat create-time category, payer, and participant validation.
- **Older PIN-reset path is weaker than newer token flows.** Forgot-PIN creates raw reset tokens and logs the token/link ([backend/routes/auth.py](../backend/routes/auth.py#L117)); email verification/password reset use hashed typed tokens. Avoid exposing logs.
- **Query-string JWTs.** XLSX, PDF, and receipt image URLs carry the access token in the query string, which can leak into browser history, logs, referrers, or screenshots ([frontend/src/api.ts](../frontend/src/api.ts#L91)).
- **Permissive CORS.** The backend allows every origin, method, and header ([backend/server.py](../backend/server.py#L143)). This should be reviewed before broader production use.
- **Startup has fallback seed credentials.** Default admin credentials are embedded as fallbacks when environment values are absent ([backend/server.py](../backend/server.py#L110)); production must always override them. Values are intentionally not repeated here.
- **Configuration duplication/conflict.** Root and `frontend/` Expo/EAS files use different app package/project identities. The root copies were already modified relative to the Git index. Establish one canonical working directory/config set before building.
- **Dependency-pin conflict.** Root [requirements.txt](../requirements.txt#L29) and [backend/requirements.txt](../backend/requirements.txt#L20) pin different Motor/PyMongo versions and describe different Python compatibility expectations.
- **Documentation drift.** `memory/ARCHITECTURE.md` still says receipts are inline and `memory/PRD.md` calls PDF and RBAC future; both conflict with code. Several `.claude/specs` describe historical intermediate behavior. Root `CLAUDE.md` is newer but still has unchecked Steps 70/74.
- **Backend URL documentation conflict.** [README.md](../README.md#L86) describes a localhost default, while the API client reads `EXPO_PUBLIC_BACKEND_URL` without a fallback ([frontend/src/api.ts](../frontend/src/api.ts#L6)). A missing variable produces an invalid base URL.
- **Two settlement systems coexist.** `db.settlements` remains functional for compatibility while the current UI uses `db.payments`. Future changes must preserve both ledger overlays or migrate deliberately.
- **Mixed date representations.** Trips use ISO date ranges; expenses retain `DD-MM-YY` plus optional `HH:MM`. Frontend sorting parses these correctly, but JSON report date ordering is still string-based.
- **Row caps.** Expense lists cap at 1,000 and report/payment fetches cap at 5,000. Larger trips are silently incomplete in those responses/reports.
- **Currency is a label.** Changing currency does not convert stored amounts; live FX is absent.
- **Destructive starter command remains exposed.** `yarn reset-project` can remove the current application source and should not be part of routine onboarding.
- **Tooling availability differs from docs.** This shell had Git and npm/npx, but neither `rtk` nor `yarnpkg` was on PATH. Raw commands/direct executables were used where documented fallbacks permitted them.

## Evidence Reviewed

Important evidence included:

- Root guidance and product docs: `CLAUDE.md`, `README.md`, `USER_GUIDE.md`, `memory/ARCHITECTURE.md`, and `memory/PRD.md`.
- All repository-local Claude artifacts: `.claude/commands/create_spec.md`, `.claude/skills/context/SKILL.md`, all six files under `.claude/plan/`, all files under `.claude/specs/`, and `.claude/settings.local.json` (without reproducing its URL).
- Backend assembly/config/schema: `backend/server.py`, `config.py`, `database.py`, all models, all route modules, split/payment/report/receipt services, and authorization/date/member utilities.
- Backend tests: the existing auth, RBAC, join, member, expense, receipt, split, payment, balance, and report suites plus focused chat helper/route/realtime coverage.
- Frontend routes: every file under `frontend/app/`, with focused reading of root/tab layouts, auth screens, trip detail, create/join, add/edit expense/member, settle-up, and reports.
- Frontend shared code/tests: `api.ts`, auth/theme contexts, permission/split/payment/date/receipt/navigation helpers, shared UI components, and every Jest test file. The full Jest suite, isolated flaky file, TypeScript, and ESLint were executed.
- Storage/deployment/build files: both requirements files, both Expo/EAS config locations, Dockerfiles, Compose, Render, Vercel, package files, pytest/Jest/TypeScript/ESLint config, and shared exact-split vectors.
- Documentation under `docs/` for Android/EAS, email setup, launch wiring, and Play internal testing.

Generated dependency, environment, cache, log, build-output, and credential contents were excluded. In particular, `.env` values and `memory/test_credentials.md` values were not copied or exposed.

## Keeping This Document Updated

After a feature change:

1. Update the snapshot date, branch/commit, worktree state, and verification results.
2. Trace the behavior end to end: UI entry point, API/guard, model/storage, service logic, and relevant tests.
3. Change status only when code and verification justify it. Never promote a roadmap/spec claim by itself.
4. Add or update relative file links with line anchors, and call out external/runtime dependencies that were not exercised.
5. Reconcile affected `.claude` plans/specs and `CLAUDE.md` checklist items, explicitly noting historical or superseded requirements.
6. Re-run the smallest relevant unit suites plus TypeScript/lint; run live API/database and device/web checks when the feature depends on them.
7. Review Known Gaps for resolved or newly introduced risks, without copying secrets or private configuration values.
