# CLAUDE.md

This file provides strict guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 1. Project Overview

Trip Expense Splitter — a mobile app (Expo/React Native) + FastAPI/MongoDB backend for tracking trip
expenses, splitting costs between individuals and families, settling balances, and exporting reports.
See `USER_GUIDE.md` for full feature documentation and `memory/PRD.md` for the product spec.

## 2. Current Architecture

### Backend (`backend/server.py`)
*(Note: This application is actively being refactored from a single-file script into a modular architecture. See Section 6: Roadmap).*

Single-file FastAPI app (no internal package structure). Sections are marked with `# ---------- Name ----------` comments and appear in this order: Setup → Utils → Models (Pydantic) → Auth → Trips → Members → Expenses → Balances/Settle Up → Reports → Meta → Startup.

- All routes are registered on an `APIRouter(prefix="/api")` which is mounted on `app` at the bottom of the file.
- Mongo access via Motor (`AsyncIOMotorClient`); collections are accessed directly as `db.<collection>` (e.g. `db.users`, `db.trips`, `db.expenses`).
- Auth: bcrypt-hashed password + 4-digit PIN, JWT bearer tokens (30-day expiry, `HS256`, secret from `JWT_SECRET`). `get_current_user` dependency decodes the `Authorization: Bearer <token>` header.
- IDs are UUID strings (`gen_id()`), not Mongo ObjectIds — documents store `id` and queries use `{"_id": 0}` projections to strip Mongo's internal id.
- A trip's `user_ids` array tracks which app users can access it; `_trip_or_404` enforces membership.
- Members are either individuals or families (`family_members: []`); `_weight_of_member` determines the per-member split weight, and expenses can override the family weight per-transaction via `split_family_count`.
- Balance/settle-up logic lives in `_compute_balances` — a greedy minimum-transaction settlement algorithm.
- XLSX reports (`report.xlsx`) are built in-memory with `openpyxl` and streamed back; this endpoint takes the JWT as a `token` query param (not a header) since it's opened via a browser link.
- On startup, indexes are created and an admin user is seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_PIN` env vars if it doesn't exist.
- Forgot-PIN flow sends email via Resend (`RESEND_API_KEY`); if not configured, the reset token is logged instead.

### Frontend (`frontend/`)
Expo SDK 54 app using `expo-router` (file-based routing under `frontend/app/`).

- Route groups: `(auth)` for login/register/forgot/reset/pin-login, `(tabs)` for the bottom-tab nav (dashboard, trips, add, reports, profile), and `trip/[id]/*` for trip detail, member/expense add-edit modals, settle-up, and category drill-down.
- Shared logic lives in `frontend/src/`:
  - `api.ts` — thin fetch wrapper; reads `EXPO_PUBLIC_BACKEND_URL`, attaches the bearer token from AsyncStorage, normalizes FastAPI error responses, and builds the XLSX download URL.
  - `AuthContext.tsx` — session state, sign in/up/out, remembers last-used email for quick PIN login.
  - `ThemeContext.tsx` / `theme.ts` — light/dark color schemes, persisted via AsyncStorage, toggled from Profile.
  - `DonutChart.tsx`, `T.tsx`, `LogoutButton.tsx` — shared UI components used across screens.
- All screens read the backend base URL from `process.env.EXPO_PUBLIC_BACKEND_URL` (set in `frontend/.env`); there is no localhost fallback baked into the app itself.

## 3. Commands

### Backend Commands
cd backend
pip install -r requirements.txt
uvicorn server:app --reload          # run the API (loads backend/.env via python-dotenv)
pytest                                # run all tests
pytest tests/test_auth.py             # run one test file
pytest tests/test_auth.py::TestAuth::test_register_success   # run one test

### Frontend Commands
cd frontend
yarn install
yarn start      # expo start — scan QR with Expo Go
yarn android / yarn ios / yarn web
yarn lint       # expo lint

## 4. Required Environment Variables

### Backend Configuration (`backend/.env`)
* `MONGO_URL`: MongoDB connection string
* `DB_NAME`: Database identification string
* `JWT_SECRET`: Signing key for HS256 authentication tokens
* `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_PIN`: Seed credentials for system superuser (must be a `@gmail.com` address)
* `RESEND_API_KEY`, `SENDER_EMAIL`, `APP_URL`: Email transactional routing configuration
* `GOOGLE_CLIENT_ID`: OAuth 2.0 client ID(s) used to verify Google ID tokens for `POST /api/auth/google`. Accepts a single client ID or a comma-separated list of accepted audiences (e.g. `<web>,<ios>,<android>`), since `expo-auth-session` mints an `id_token` whose `aud` is the current platform's client ID.

### Frontend Configuration (`frontend/.env`)
* `EXPO_PUBLIC_BACKEND_URL`: Complete targeted API base URL path
* `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`: OAuth 2.0 client IDs for "Sign in with Google" (`GoogleSignInButton`)

### Gmail-Only Identity
This project is gmail-only: every email address accepted anywhere (register, login, forgot-PIN, member
linked emails, and Google sign-in) must end in `@gmail.com`, enforced server-side by
`backend/utils/email_rules.py::assert_gmail` and mirrored client-side by `frontend/src/validation.ts`.

---

## 5. Splitting Engine Logic (CRITICAL)

When calculating balances and rendering reports, the core engine must verify the targeted Expense's `split_mode`.

A) Per-Capita Split (Total Humans Involved)
- Rule: Divide the expense by the total number of individual human beings checked.
- Math: Total Humans (H) = sum of members in selected Families + selected Individuals. Cost per human C = Expense / H.
- Example: 4 families (sizes 4, 4, 2, 1) + 2 individuals = 13 humans. A $130 expense means C = 10. The first two families owe $40 each, the third owes $20, the fourth owes $10, and both standalone individuals owe $10 each.

B) Per-Family Split (Total Entities Involved)
- Rule: Divide the expense by the number of root entities (Families + Unaffiliated Individuals), regardless of family size.
- Math: Total Entities (E) = (number of selected families) + (number of selected individuals). Cost per entity C = Expense / E.
- Example: 4 families + 2 individuals = 6 entities. A $120 expense means every family unit and every single individual owes exactly $20, regardless of internal family member size.

App User Identity Mapping: If an App User joins an existing family group via code, they retain their unique App User ID identity for login/auth operations, but are mathematically treated as an integrated member of that family unit during the cost allocations above.

---

## 6. Implementation Roadmap

AGENT DIRECTIVE: You must update this file by changing `[ ]` to `[x]` as you successfully complete, test, and commit each step. Do not skip steps or leave partial components.

### Phase 1: Data Model Expansion & Refactor (Backend)
- [x] Step 1: Modularize Backend. Break down `server.py` into cleanly decoupled layers under `/models`, `/routes`, and `/utils`. Verify all current functional integration tests pass perfectly.
- [x] Step 2: Trip RBAC Infrastructure. Update the Trip schema to support an explicit `admin_ids` string array. Ensure the initializing creator is flagged as the root admin.
- [x] Step 3: Unique Family & Domain Mapping. Update the Family validation schema to guarantee unique `linked_email` addresses and prevent identical naming conventions inside a single trip context.
- [x] Step 4: Dual Split Mode Enums. Update the Pydantic and database Expense validation models to support a strict literal `split_mode` tracking field (`PER_CAPITA` | `PER_FAMILY`).

### Phase 2: The Calculation & Export Engines (Backend)
- [x] Step 5: Isolate Mathematical Layer. Create `services/calculator.py`. Extract and migrate the minimum-transaction greedy settlement algorithm into this module.
- [x] Step 6: Realize Per-Capita Mode Math. Implement the complete calculation logic for the human-count division (PER_CAPITA) specified in Section 5.
- [x] Step 7: Realize Per-Family Mode Math. Implement the complete entity-based division calculation logic (PER_FAMILY) specified in Section 5.
- [x] Step 8: Retroactive Family Re-allocation Routine. Code a transactional service tracking past expenses for a target `family_id` upon member size mutations. Provide toggled options to recalculate past ledger balances.
- [x] Step 9: Synchronize XLSX Export Report. Update the `openpyxl` reporting code pipeline to parse the new split modes and output clear mathematical validation tabs tracking per-capita versus per-family line items.

### Phase 3: Access Control & Route Constraints (Backend)
- [x] Step 10: Expense Modification Protection. Intercept expense edit/delete endpoints to verify that the requesting user context matches either the record creator ID or a designated Trip Admin ID.
- [x] Step 11: Member Administration Locks. Protect member/family mutation endpoints to ensure exclusively authenticated Trip Admins can execute modifications.
- [x] Step 12: Complex Joining Context API. Refactor the invitation code route (`/join`) to handle contextual payloads mapping whether the incoming profile is arriving as a clean individual, linking into a family entity, or initializing a new group structure.

### Phase 4: Join Pipeline & Member Administration (Frontend)
- [x] Step 13: Interactive Join Wizard UI. Build out a clear navigation step processing trip code validations. Prompt user with clear selection triggers: "Join as Individual", "Join existing Family [Dynamic Picker]", or "Create New Family Lineage".
- [x] Step 14: Administrative Controls Member Tab. Upgrade the Members roster interface. Implement crisp operational badges distinguishing Admins, and open modal pathways to allow designated admins to safely alter family configurations.
- [x] Step 15: Structural Recalculation Prompt. Attach a UI confirmation trigger upon family size adjustment saving operations. Prompt: "Apply updates retroactively to prior expenses or apply to future items only?", firing the Phase 2 backend recalculation route when accepted.

### Phase 5: Transaction Interfaces (Frontend)
- [x] Step 16: Dual Split Mode Selector. Integration of a visible segmented control element inside Add/Edit transaction screens supporting toggles between [Per Person] and [Per Family]. Drive active form sub-label state changes detailing simulated pricing splits dynamically.
- [x] Step 17: RBAC-Driven Component Hiding. Condition the visibility states of transaction update and deletion elements based on current identity roles (validating creator token flags or trip admin criteria).

### Phase 6: Core Presentation Layer & Media Handling (Frontend)
- [x] Step 18: Layout UI Audit & Standardization. Homogenize typography scales, layout padding grids, and color tokens across all interfaces. Update Home and Detail layouts to compute exact strings reading: `[X] Individuals across [Y] Families & [Z] Singles`.
- [x] Step 19: Ubiquitous Global Session Drop. Leverage Expo Router layout configurations (`_layout.tsx`) utilizing `screenOptions` mappings to anchor the shared application `LogoutButton` element into the persistent top-right header layout frame universally across all screens.
- [x] Step 20: Photo Asset Acquisition & Gallery Pipeline. Wire up `expo-image-picker` actions to intercept receipt images. Embed a download trigger on the target transaction asset modal consuming `expo-media-library` configurations to safely write files back into the phone’s local camera roll gallery.

### Phase 7: Post-Launch Bug Fixes & Hardening (Frontend)
- [x] Step 21: Working Logout Button. Fix the cross-platform-broken logout flow: route the confirm through the themed `ConfirmModal` (the native `Alert` renders no buttons on web), tear down the authenticated navigation stack on sign-out (`dismissAll` + `replace`), and add a declarative auth-redirect guard in the root `_layout.tsx`. Consolidate the single logout flow into `LogoutProvider` with pure, unit-tested helpers in `authNav.ts`, preserving the saved-email/PIN quick-login behavior from Step 19.
### Phase 7: Post-Launch Bug Fixes & Hardening
- [x] Step 22: Attaching Bill's Image. Promote receipt/bill image storage off the inline `receipt_base64` blob into a dedicated MongoDB GridFS pipeline. A multipart upload endpoint (`POST /trips/{id}/expenses/{eid}/receipt`) stores the image and stamps the expense with a lightweight UUID `receipt_id`; a streamed `GET` (auth via `Authorization` header **or** `?token=` query) serves it; and the expense-list endpoint stops returning image bytes, exposing only a derived `has_receipt` flag. Preserve backward compatibility with legacy `receipt_base64` rows through a read-time fallback, gate attach/replace/remove behind creator-or-admin RBAC (`_expense_modify_or_403`), and cascade-delete the GridFS file when its expense is removed.
  - Follow-up (UI + web upload): fixed receipt upload in the browser — `uploadReceipt` now fetches the picked asset into a real `Blob` on web (`Platform.OS === 'web'`) so the multipart part is a genuine file (the prior `{uri,name,type}` shape serialized to `"[object Object]"` and 422'd). Added a per-trip **Gallery** tab on the trip detail screen (a flex-wrap thumbnail grid that reuses the `has_receipt` flag and opens `ReceiptViewer`), and an inline bill state in the Expenses tab that shows the bill thumbnail or a muted **"Bill not attached"** note. Pure helpers in `frontend/src/gallery.ts` (`receiptExpenses`, `billLabel`) are unit-tested in `frontend/src/__tests__/gallery.test.ts`. No backend change.
- [x] Step 23: Owner / Admin / Member Control Differences. Define the three-tier access matrix once and enforce it consistently. New pure `backend/utils/permissions.py` (`role_of` + capability predicates) is the single source of truth, mirrored UX-only in `frontend/src/permissions.ts` (`roleOf`, `canManageMembers`, `canEditTripSettings`, `canManageAdmins`, `canTransferOwnership`, `canDeleteTrip`). Closes the gap where any member could edit trip settings (`PATCH /trips/{id}` now requires admin via `_trip_admin_or_403`), tightens admin promote/demote to **owner-only** (`_trip_owner_or_403`), and adds an owner-only `POST /trips/{id}/transfer-ownership` (reassigns `owner_id`, keeps the previous owner as an admin — touches only `owner_id`/`admin_ids`, never member/split data). Frontend gates the `trip-edit` pencil behind `canEditTripSettings`, makes the `manage-member` admin toggle owner-only (non-owner admins see a muted note), and adds a `ConfirmModal`-driven **Transfer ownership** action. Covered by `backend/tests/test_role_control.py` (pure matrix + API) and extended `frontend/src/__tests__/permissions.test.ts`.

### Phase 8: Global Hosting (Free Testing)
*(Infrastructure only — every change is a new file or strictly additive/non-functional. Local `uvicorn server:app --reload` dev and `docker-compose` stay byte-for-byte unchanged. No business logic, splitting/settlement math, auth/JWT, RBAC, GridFS, reports, or Gmail rules are touched. Host = Render free · Region = Singapore.)*
- [x] Step 24: Production container. Add `backend/Dockerfile.prod` running gunicorn with one uvicorn worker bound to the platform-injected `$PORT` (shell-form `CMD` so `$PORT` expands). `--workers 1` avoids the first-boot admin-seed `DuplicateKeyError` race and fits free RAM + M0 connection limits. The compose `Dockerfile` is left untouched.
- [x] Step 25: Health probe. Add an additive `GET /api/health` (static 200 `{"status":"ok"}`, no DB) in `routes/meta.py` for the host health check.
- [x] Step 26: Production deps. Add `gunicorn==23.0.0` to `backend/requirements.txt` (`dnspython` for Atlas `mongodb+srv://` resolution is already present).
- [x] Step 27: Render Blueprint. Add `render.yaml` (docker · singapore · free · `healthCheckPath: /api/health`, all env vars `sync: false`) and `backend/.env.example` documenting the required env vars (placeholders only — secrets never committed).
- [x] Step 28: Atlas M0 + Network Access. Provisioned an M0 cluster (AWS Singapore), allowed `0.0.0.0/0` in Network Access, and created a DB user; `MONGO_URL` set to the SRV string. `DB_NAME` = `tripsplitter`.
- [x] Step 29: Go live. Deployed to Render at `https://tripsplitter-api.onrender.com` (Blueprint, free, Singapore). Verified live: `/api/health` → 200, registration writes to Atlas (data persists), auth/JWT working. `frontend/.env` `EXPO_PUBLIC_BACKEND_URL` points at the Render URL. Note: backend `APP_URL` is still blank — to be set to the web URL once the web build is hosted (forgot-PIN reset links fall back to logging the token until then).
- [x] Step 30: Frontend web on Vercel. Host the Expo **web** build as a free static site, live at `https://tripsplitter-web.vercel.app` (project `tripsplitter-web`), pointed at the Render API. Additive-only, no app/screen/nav/logic changes: new `frontend/vercel.json` (`buildCommand: npx expo export -p web`, `outputDirectory: dist`, SPA rewrite `/(.*) -> /index.html` so deep links like `/trip/<id>` don't 404) and `frontend/.vercelignore` (excludes `node_modules`/`dist`; the Vercel CLI does not honor `.gitignore` and 422s past 15000 files). `EXPO_PUBLIC_BACKEND_URL` is set as a Vercel **Production + Preview** env var (build-time inlined) so `frontend/.env`/`yarn start`/native stay byte-for-byte untouched. Backend CORS is already `allow_origins=["*"]` (Bearer auth, not cookies) so the web origin works with no backend change. Verified live: site + deep links → 200, browser-origin `POST /api/auth/login` → 401 (CORS OK, correct URL), `/api/health` → 200, login screen renders. Gotcha recorded: set env values via Git Bash `printf` — a PowerShell pipe prepended a UTF-8 BOM that corrupted the inlined URL (405s) on the first deploy. Known-benign console noise: React #418 hydration mismatch from `output: "static"` + the `/`→`/login` client redirect (cosmetic). Web limitations for testers: email+PIN only (no web Google sign-in — button auto-hidden), file-picker receipts (no camera), receipt "Save to gallery" is a no-op on web (viewing + XLSX export still work). Follow-up: set backend `APP_URL` to the Vercel URL (Step 29 note); optional `vercel git connect` for push-to-deploy (needs Root Directory = `frontend`).

### Phase 9: Gmail Auth — Google OAuth (prod-wire) + Email Verification + Forgot-Password
*(Additive only — builds on existing email+PIN+JWT auth. No change to the splitting engine, settlement math, RBAC, GridFS, reports, openpyxl, trip/member/expense logic, or the Gmail rule. Existing flows + all prior tests unchanged. Two new additive user fields + a new `auth_tokens` collection; existing users grandfathered as verified + credential-complete on startup so no one is locked out.)*
- [x] Step 31: Hardened email tokens. New `backend/utils/auth_tokens.py` — cryptographically random tokens stored **SHA-256-hashed** (never raw) in a new `db.auth_tokens` collection, tagged by `type` (`verify_email` | `reset_password`), single-use (`used` flag), time-limited (real UTC `expires_at`), with prior unused tokens of the same type invalidated on reissue. Startup lifespan adds a unique `token_hash` index and a TTL index on `expires_at` (`expireAfterSeconds=0`) so expired rows auto-purge. New `backend/utils/emailer.py` (`send_email` + link/HTML builders) reuses the Resend pattern and logs the link when Resend is unconfigured; the legacy forgot-PIN inline send is left byte-for-byte. Unit-tested in `tests/test_auth_tokens.py`.
- [x] Step 32: Additive user fields + migration. New optional `email_verified` and `credentials_set` on the user doc. `register` → `email_verified:false`, `credentials_set:true`; Google signup → `email_verified:true` (Google already verified) + `credentials_set:false` (random placeholder PIN/password → routes to one-time setup). Idempotent startup backfill marks every pre-existing user (and the seeded admin) `email_verified:true` + `credentials_set:true`. User payloads on `register`/`login`/`google`/`set-credentials` + `GET /auth/me` expose both fields (default `true`).
- [x] Step 33: Email verification (soft gate). `POST /auth/register` emails a 24h verification link (`{APP_URL}/verify-email?token=`); new additive `POST /auth/verify-email` (token-proof, unauthenticated) flips `email_verified:true`; `POST /auth/resend-verification` (Bearer, 60s per-user rate limit → 429) reissues. Unverified users still log in — the dashboard shows an additive `UnverifiedBanner` (resend button). Google signups skip verification. Covered by `tests/test_email_verification.py`.
- [x] Step 34: Forgot PASSWORD by email. New additive `POST /auth/request-password-reset` (distinct path — `/auth/forgot-password` is already the forgot-PIN alias) **always** returns a generic body (no account enumeration) and, if the account exists, emails a 1h link (`{APP_URL}/reset-password?token=`). New `POST /auth/reset-password` validates the new password (reuses `MIN_PASSWORD_LENGTH`, validated **before** consuming the token) and updates the bcrypt hash — **PIN left unchanged**. Covered by `tests/test_password_reset.py`.
- [x] Step 35: OAuth credential setup. New additive `POST /auth/set-credentials` (Bearer) lets a first-time Google user choose a real 4-digit PIN + password (`credentials_set:true`), enabling email+PIN/email+password login afterwards. Covered by `tests/test_set_credentials.py`.
- [x] Step 36: Frontend wiring (additive). New top-level routes `app/verify-email.tsx`, `app/reset-password.tsx`, `app/set-credentials.tsx` and `(auth)/forgot-password.tsx`; new `src/UnverifiedBanner.tsx`; "Forgot password?" link on login; `GoogleSignInButton` routes first-time OAuth users to `/set-credentials`; `User` type += `email_verified?`/`credentials_set?`; `signInWithGoogle` returns the user. `authNav.authRedirectTarget` gains an optional `isPublicRoute` arg (back-compat) so the email-link landing pages work signed-out; `PUBLIC_TOKEN_ROUTES`/`isPublicTokenRoute` + the root `_layout` guard cover `verify-email`/`reset-password`. New `src/__tests__/authNav.test.ts`. Verified: backend 279 passed / 1 skipped, frontend 81 passed, `tsc --noEmit` + eslint clean, `expo export -p web` builds all new routes.
- [x] Step 37: Production wiring (USER ACTION). Google Cloud Console: add the Vercel origin (`https://tripsplitter-web.vercel.app`) + `http://localhost:8081` to the **Web** OAuth client's Authorized JavaScript origins **and** redirect URIs; add the EAS keystore SHA-1 to the **Android** OAuth client (package `com.tripsplitter.app`). Render env: `RESEND_API_KEY` (secret), `SENDER_EMAIL`, `APP_URL=https://tripsplitter-web.vercel.app`, `GOOGLE_CLIENT_ID=<web>,<android>`. Vercel env: `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (Prod+Preview). Fill `frontend/eas.json` `<WEB_CLIENT_ID>`/`<ANDROID_CLIENT_ID>` (public). Resend test sender `onboarding@resend.dev` only delivers to the Resend account owner's email (others get a logged link). Atlas: `auth_tokens` indexes auto-create on boot.
