# CLAUDE.md

This file provides strict guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 1. Project Overview

Trip Expense Splitter — a mobile app (Expo/React Native) + FastAPI/MongoDB backend for tracking trip
expenses, splitting costs between individuals and families, settling balances, and exporting reports.
See `USER_GUIDE.md` for full feature documentation and `memory/PRD.md` for the product spec.

## 2. Current Architecture

### Backend (`backend/`)
Modular FastAPI app. The original single-file `server.py` was split (Roadmap Step 1) into `models/`
(Pydantic bodies), `routes/` (an `APIRouter(prefix="/api")` per area: auth, trips, members, expenses,
balances, reports, receipts, spend, meta), `services/` (business + split math), and `utils/` (auth, RBAC
deps, helpers). `server.py` now just builds `app`, includes the routers, and runs startup/shutdown;
`config.py` holds env vars, `database.py` the Motor client + `db` handle.

- Mongo via Motor (`AsyncIOMotorClient`); collections accessed as `db.<collection>` (`db.users`,
  `db.trips`, `db.expenses`, `db.settlements`, `db.auth_tokens`) + GridFS for receipts.
- Auth: bcrypt-hashed password + 4-digit PIN, plus Google OAuth (`POST /api/auth/google`); JWT bearer
  tokens (30-day expiry, `HS256`, secret from `JWT_SECRET`). `get_current_user` (`utils/deps.py`) decodes
  the `Authorization: Bearer <token>` header.
- IDs are UUID strings (`gen_id()`), not Mongo ObjectIds — documents store `id` and queries use
  `{"_id": 0}` projections. Members are an **embedded array** on the trip doc (positional `$` updates).
- A trip's `user_ids` array tracks access (`_trip_or_404`); three-tier RBAC owner/admin/member is enforced
  by `utils/permissions.py` (source of truth) + `utils/deps.py` guards.
- Balance/settle-up logic lives in `utils/balances.py::_compute_balances` (greedy minimum-transaction
  settlement) over `services/calculator.py`. Expenses carry a `split_mode` (`PER_CAPITA`|`PER_FAMILY`, §5).
- XLSX reports (`services/report_builder.py` + `routes/reports.py`, `openpyxl`) are built in-memory and
  streamed; this endpoint takes the JWT as a `token` query param (not a header) since it's opened via a
  browser link.
- Receipts live in GridFS (`services/receipts.py`); expense lists expose only a `has_receipt` flag, with a
  read-time fallback for legacy inline `receipt_base64` rows.
- Startup creates indexes, seeds an admin user from `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_PIN`, and runs
  idempotent backfills. Verification / forgot-PIN / password-reset emails go via Resend
  (`utils/emailer.py`); if not configured, the link/token is logged instead.

### Frontend (`frontend/`)
Expo SDK 54 app using `expo-router` (file-based routing under `frontend/app/`).

- Route groups: `(auth)` for login/register/forgot/reset/pin-login, `(tabs)` for the bottom-tab nav (dashboard, trips, add, reports, profile), and `trip/[id]/*` for trip detail, member/expense add-edit modals, settle-up, and category drill-down.
- Shared logic lives in `frontend/src/`:
  - `api.ts` — thin fetch wrapper; reads `EXPO_PUBLIC_BACKEND_URL`, attaches the bearer token from AsyncStorage, normalizes FastAPI error responses, and builds the XLSX download URL.
  - `AuthContext.tsx` — session state, sign in/up/out, remembers last-used email for quick PIN login.
  - `ThemeContext.tsx` / `theme.ts` — light/dark color schemes, persisted via AsyncStorage, toggled from Profile.
  - `permissions.ts` — UX mirror of the backend RBAC matrix; `ui/` — shared design-system components.
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
- Rule: Divide the expense by the total number of individual human beings *involved*.
- Math: Total Humans (H) = sum of *involved* members across selected Families + selected Individuals. Cost per human C = Expense / H.
- Example: 4 families (sizes 4, 4, 2, 1) + 2 individuals = 13 humans. A $130 expense means C = 10. The first two families owe $40 each, the third owes $20, the fourth owes $10, and both standalone individuals owe $10 each.
- Partial family involvement: a family's *involved* count comes from its per-expense `weight_snapshots` override when set, otherwise from `family_participants` (the members who took part), otherwise its full size. That single involved count BOTH sizes the family's share AND divides it among its involved members. Example: $100 across 1 individual + a family with 3 of 4 members involved → H = 3 + 1 = 4, C = 25 → individual 25, each involved family member 25, family total 75, the uninvolved member 0. (`family_participants` is per-member display-only in PER_FAMILY, but in PER_CAPITA it reduces the family's headcount per this rule.)
- Per-member family breakdown (DISPLAY-only, Balances + report Sheet 3b): a family's already-computed ledger net is divided among its members by CHRONOLOGICAL replay (`services/calculator.py::distribute_chronological`, Phase 14) — the family's expenses and non-pending settlements are replayed in time order; each expense's net is split only among that expense's participants (excluded ⇒ 0), and each settlement scales the running positions toward 0, so settled money disappears per member and only later (unsettled) expenses remain. The rows still sum EXACTLY to the family net. This never changes the ledger net or any other entity.

B) Per-Family Split (Total Entities Involved)
- Rule: Divide the expense by the number of root entities (Families + Unaffiliated Individuals), regardless of family size.
- Math: Total Entities (E) = (number of selected families) + (number of selected individuals). Cost per entity C = Expense / E.
- Example: 4 families + 2 individuals = 6 entities. A $120 expense means every family unit and every single individual owes exactly $20, regardless of internal family member size.

C) Exact-Amount Split (`split_mode = "EXACT"`, Phase 22)
- Rule: the expense author assigns an **explicit amount to specific people** (family members and/or standalone individuals); the amounts MUST sum to the expense total. Selection is person-level — presence of a member key means "involved", absence means exactly 0.
- Data: the expense stores raw per-person input `custom_amounts: {member_id -> amount}` (persisted verbatim so edits round-trip). EXACT **ignores** `family_participants` and `weight_snapshots` (those drive PER_CAPITA involvement); "involved" is defined solely by presence in `custom_amounts`.
- Design (person-level input → entity-level ledger → per-member display). All three stages funnel through the single pure module `services/custom_split.py` so no branch point forks logic; all reconciliation is in **integer cents**, snapped largest-remainder so resolved shares sum EXACTLY to the total:
  1. **Ledger (entity rollup).** `resolve_exact_entity_shares(custom_amounts, members)` rolls each person up to their entity (family share = Σ its selected members' amounts; individual = own), producing the SAME `{entity_key: amount}` shape as §5-A/§5-B — so it feeds `expense_shares.entity_shares_raw` → `utils/balances._compute_balances` → `services/calculator.minimize_transfers` **unchanged**. The ledger still settles between entities.
  2. **Per-member display.** The Phase-14 family breakdown branches for EXACT: `services/member_breakdown.family_member_breakdown` splits an expense's family net in **proportion to the typed member amounts** (excluded ⇒ 0) via `calculator.distribute_chronological`'s optional per-member weight; `services/expense_shares.expense_share_breakdown` and the report builders use the explicit amounts. Because the family entity share equals Σ member amounts by construction, the breakdown still foots EXACTLY to the family net, and the chronological settlement replay scales it unchanged.
- **The one hard rule (two-layer save-gate).** An EXACT expense cannot be saved unless Σ amounts == total. Enforced in BOTH: (a) frontend — the Save button is disabled and a live reconciliation bar shows Assigned/Remaining until it balances (`src/exactSplit.ts` + `src/ExactSplitEditor.tsx`); (b) backend (source of truth) — `routes/expenses.py` create + edit call `custom_split.validate_exact_amounts` and reject a mismatch with **HTTP 422**. Frontend and backend snap logic are pinned together by `shared/exact-split-vectors.json`.
- Reports display EXACT (`_MODE_LABELS["EXACT"]="Exact"`) with no forked math — the Split Math and exploded Transactions tabs + PDF reuse `entity_shares_raw` / `exact_member_shares`.

App User Identity Mapping: If an App User joins an existing family group via code, they retain their unique App User ID identity for login/auth operations, but are mathematically treated as an integrated member of that family unit during the cost allocations above.

---

## 6. Implementation Roadmap

AGENT DIRECTIVE: You must update this file by changing `[ ]` to `[x]` as you successfully complete, test,
and commit each step. Do not skip steps or leave partial components. Phases 1–16 below are **complete** —
each step is condensed to its load-bearing artifacts (files/endpoints/invariants); the blow-by-blow history
(test counts, branch names, verification runs, deploy gotchas) lives in git and the `memory/` files.

**Do-not-break invariants (most phases were strictly additive):** unless a task is *specifically* about
them, do not alter the split/balance engine (`services/calculator.py` + `minimize_transfers`; PER_CAPITA
involved-count §5-A and PER_FAMILY §5-B), `utils/balances._compute_balances`, the settlement lifecycle +
mark-paid RBAC (Phase 10), JWT/auth, GridFS receipts, the XLSX report's engine values, the Gmail-only rule
(§4), or any existing Pydantic/DB model + route shape.

### Phase 1: Data Model Expansion & Refactor (Backend)
- [x] Step 1: Modularize backend `server.py` into `models/`, `routes/`, `services/`, `utils/` (server.py = assembly point); all integration tests pass.
- [x] Step 2: Trip RBAC — add `admin_ids` string array; the creating owner is the root admin.
- [x] Step 3: Unique family `linked_email` addresses + no duplicate family names within a trip.
- [x] Step 4: Expense `split_mode` strict literal (`PER_CAPITA`|`PER_FAMILY`) on Pydantic + DB models.

### Phase 2: The Calculation & Export Engines (Backend)
- [x] Step 5: Create `services/calculator.py`; extract the greedy minimum-transaction settlement (`minimize_transfers`).
- [x] Step 6: PER_CAPITA human-count division math (§5-A).
- [x] Step 7: PER_FAMILY entity-based division math (§5-B).
- [x] Step 8: Retroactive family re-allocation on member-size change (`services/reallocation.py`), with a toggle to recalc past ledgers.
- [x] Step 9: XLSX export parses the split modes + emits per-capita vs per-family validation tabs.

### Phase 3: Access Control & Route Constraints (Backend)
- [x] Step 10: Expense edit/delete gated to record creator OR trip admin (`_expense_modify_or_403`).
- [x] Step 11: Member/family mutation endpoints admin-only.
- [x] Step 12: `/join` contextual payloads (clean individual | link into family | new family group).

### Phase 4: Join Pipeline & Member Administration (Frontend)
- [x] Step 13: Join wizard UI — "Join as Individual" / "Join existing Family [picker]" / "Create New Family Lineage".
- [x] Step 14: Members roster with admin badges + admin-only family-config modals.
- [x] Step 15: Family size-change prompt ("retroactive vs future-only") → fires the Phase-2 recalc route.

### Phase 5: Transaction Interfaces (Frontend)
- [x] Step 16: Add/Edit expense segmented `[Per Person]|[Per Family]` selector with live split-preview sublabel.
- [x] Step 17: Hide expense update/delete controls by role (creator / trip admin).

### Phase 6: Core Presentation Layer & Media Handling (Frontend)
- [x] Step 18: Standardize typography/spacing/color tokens; composition string `[X] Individuals across [Y] Families & [Z] Singles`.
- [x] Step 19: Global header `LogoutButton` via `_layout.tsx` `screenOptions`.
- [x] Step 20: `expo-image-picker` receipts + `expo-media-library` save-to-gallery.

### Phase 7: Post-Launch Bug Fixes & Hardening
- [x] Step 21: Working logout — themed `ConfirmModal` (native `Alert` renders no web buttons), `dismissAll`+`replace`, root `_layout` auth-redirect guard, `LogoutProvider` + pure `authNav.ts` helpers.
- [x] Step 22: Receipts → GridFS. `POST/GET/DELETE /trips/{id}/expenses/{eid}/receipt` (GET auth via header OR `?token=`), `has_receipt` flag + `receipt_id`, legacy `receipt_base64` read-fallback, cascade-delete, creator-or-admin RBAC. Frontend: real-`Blob` web upload, per-trip Gallery tab, `ReceiptViewer`, pure `src/gallery.ts`.
- [x] Step 23: Owner/Admin/Member matrix — `utils/permissions.py` (source of truth) + `frontend/src/permissions.ts`. `PATCH /trips/{id}` admin-only; promote/demote owner-only; owner-only `POST /trips/{id}/transfer-ownership`.

### Phase 8: Global Hosting (Free Testing)
*(Infra only — additive/non-functional; local `uvicorn`/`docker-compose` unchanged. Host = Render free · Region = Singapore.)*
- [x] Step 24: `backend/Dockerfile.prod` (gunicorn + 1 uvicorn worker bound to `$PORT`; compose `Dockerfile` untouched).
- [x] Step 25: Additive `GET /api/health` (static 200, no DB) in `routes/meta.py`.
- [x] Step 26: `gunicorn==23.0.0` added to `backend/requirements.txt`.
- [x] Step 27: `render.yaml` (docker/singapore/free, `healthCheckPath: /api/health`, env `sync: false`) + `backend/.env.example`.
- [x] Step 28: Atlas M0 (AWS Singapore), Network Access `0.0.0.0/0`, DB user; `DB_NAME=tripsplitter`.
- [x] Step 29: Live on Render `https://tripsplitter-api.onrender.com` (health/register/auth verified). Note: backend `APP_URL` set once web is hosted (reset links log the token until then).
- [x] Step 30: Expo **web** on Vercel `https://tripsplitter-web.vercel.app` (`frontend/vercel.json` build + SPA rewrite, `frontend/.vercelignore`); `EXPO_PUBLIC_BACKEND_URL` as a build-time Vercel env. Web limits for testers: email+PIN only (no web Google), file-picker receipts, save-to-gallery is a no-op.

### Phase 9: Gmail Auth — Google OAuth + Email Verification + Forgot-Password
*(Additive on top of email+PIN+JWT. User doc += `email_verified`/`credentials_set`; new `db.auth_tokens`; pre-existing users backfilled verified + credential-complete on startup.)*
- [x] Step 31: `utils/auth_tokens.py` — cryptographically random, SHA-256-**hashed**, single-use, time-limited tokens (`verify_email`|`reset_password`) in `db.auth_tokens` (unique `token_hash` index + TTL on `expires_at`); `utils/emailer.py` (logs the link when Resend unconfigured).
- [x] Step 32: Additive user fields `email_verified`/`credentials_set` (register → verified:false/creds:true; Google → verified:true/creds:false) + idempotent startup backfill; exposed on auth payloads + `GET /auth/me`.
- [x] Step 33: Email verification (soft gate): register emails a 24h link; `POST /auth/verify-email` (unauth), `POST /auth/resend-verification` (Bearer, 60s rate-limit → 429). Unverified users still log in; dashboard `UnverifiedBanner`. Google signups skip it.
- [x] Step 34: Forgot PASSWORD: `POST /auth/request-password-reset` (generic body, no enumeration) → 1h link; `POST /auth/reset-password` (validates before consuming token; PIN unchanged).
- [x] Step 35: `POST /auth/set-credentials` (Bearer) — first-time Google user sets a real PIN + password (`credentials_set:true`).
- [x] Step 36: Frontend routes `verify-email`/`reset-password`/`set-credentials`/`(auth)/forgot-password`; `UnverifiedBanner`; "Forgot password?" link; `GoogleSignInButton` routes first-time OAuth → `/set-credentials`; `PUBLIC_TOKEN_ROUTES` + root `_layout` guard for signed-out email-link landings.
- [x] Step 37: Production wiring (USER ACTION) — Google Console origins/redirects + Android SHA-1; Render env `RESEND_API_KEY`/`SENDER_EMAIL`/`APP_URL`/`GOOGLE_CLIENT_ID`; Vercel `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`; fill public client IDs in `frontend/eas.json`.

### Phase 10: Settlement History & Mark-as-Paid
*(Additive on `db.settlements` + `/settle`. Decisions: paid offsets balances, pending does not; explicit pending records (nothing deleted); lender-or-admin may mark paid.)*
- [x] Step 38: `db.settlements` += `status` (`pending`|`paid`), `paid_at`, `recorded_by`, `note`; `models/settlement.py`; index `[(trip_id,1),(created_at,-1)]` + backfill legacy rows → `paid`.
- [x] Step 39: `_compute_balances` settlement overlay filtered to `status != "pending"` (also matches legacy rows); pending never offsets.
- [x] Step 40: `GET/POST /trips/{id}/settlements`, `PATCH .../{sid}` (→paid, idempotent). Legacy `POST /settle` kept (stamps paid).
- [x] Step 41: Mark-paid RBAC `can_mark_settlement_paid` (trip admin OR lender) + `_settlement_mark_paid_or_403`.
- [x] Step 42: `settle-up.tsx` — Suggested (Record → pending) + History (Mark paid → `ConfirmModal` → PATCH); pure `src/settlements.ts`, mirrored `canMarkSettlementPaid`.

### Phase 11: One Gmail = One Person Per Trip (Identity Reconciliation)
*(Within a trip a gmail belongs to ≤1 person. Stub vs claimed = `member.user_id` (falsy ⇒ stub). CLAIM only writes `user_id`; JOIN_NEW only `$pull`s a zero-reference stub — both balance-neutral. Enforced on every join path.)*
- [x] Step 43: `utils/members.py` identity helpers — `find_own_stubs`, `member_has_financial_history(_in)`, `is_stub_removable`, `assert_unique_email_in_trip` (superset that also rejects claimed users' account emails).
- [x] Step 44: `POST /trips/join/preview` returns `match {member_id, member_type, member_name, family_id?, family_name?, has_financial_history}` (+ `match_conflicts`); `matched_family`/`families` byte-compatible.
- [x] Step 45: `POST /trips/join` += `action=claim|join_new` (+ `member_id`/`replace_member_id`); `claim` self-serve/own-email/idempotent/atomic; `join_new` server-authoritative history guard (409/403) then `$pull`s a clean stub; legacy `mode=None` auto-claims own-email stub.
- [x] Step 46: `add_member`/`update_member` use `assert_unique_email_in_trip` (preserving merge-target/self-exclusion + `assert_gmail`-first).
- [x] Step 47: Join wizard identity step — pure `src/joinIdentity.ts` (`availableJoinChoices`/`mustClaim`/`replacementNeeded`/`buildClaimBody`/`buildJoinNewBody`); `api.ts` `previewJoin`/`joinTrip`; claim (recommended) vs join-as-new with `ConfirmModal`-gated stub removal.
- [x] Step 48: `validation.ts` `isEmailTaken` + `DUPLICATE_EMAIL_MESSAGE` mirror wired into `add-member.tsx`/`edit-member.tsx`.
- [x] Step 49: Docs (USER_GUIDE §3.2/§4.3/§4.4) + full verification gate.

### Phase 12: Spend Ranking Bar Chart (Trip Insights)
*(Additive, read-only. "Spent" = Σ gross positive `amount` grouped by payer `paid_by_member_id`, descending; split/settlement-independent; zero-spenders shown.)*
- [x] Step 50: Pure `services/spend_summary.py::aggregate_spend` (entity roll-up; `total`=Σ bars, `count`=spenders).
- [x] Step 51: Read-only `GET /trips/{id}/spend-summary` in `routes/spend.py` (RBAC via `_trip_or_404`).
- [x] Step 52: Pure `src/spend.ts::rankSpend` + types.
- [x] Step 53: `SpendBarChart.tsx` (react-native-svg, theme intensity ramp, empty state).
- [x] Step 54: Wire into the trip Summary tab (`api.ts::spendSummary`, near the donut).
- [x] Step 55: Docs (USER_GUIDE §6) + full verification gate.

### Phase 13: Splitting & Balance Bug Fixes
*(Decisions: (a) BUG 2 — `family_participants` now DRIVES the PER_CAPITA family weight to the involved count (overturns "ledger ignores family_participants" for PER_CAPITA only); (b) apply the involved-count weight EVERYWHERE — ledger, per-expense `shares`, frontend preview, XLSX. PER_FAMILY §5-B untouched.)*
- [x] Step 56: BUG 2 — `calculator.py` `_chosen_participants`/`involved_count`/`resolve_weights(..., family_participants, rosters)` (snapshot override → involved count → full size); wired into `_compute_balances`, `member_breakdown`, `expense_shares.entity_shares_raw`, `report_builder.build_per_capita_rows`, `income_migration.compute_net`.
- [x] Step 57: BUG 1 — family per-member breakdown shows the post-settlement remainder (superseded by Phase 14 / Step 63).
- [x] Step 58: Frontend preview mirror — `src/familyParticipation.ts` `familyInvolvedWeight`/`perCapitaHumans`/`familyShareEach` honor the involved count (thread `familyExcluded`); routed through `SplitModeSelector.splitPreviewLabel`.
- [x] Step 59: Tests (`tests/test_split_bugfix.py` + updates) + docs (§5-A + USER_GUIDE) + full verification gate.

### Phase 14: Per-Expense Family Breakdown Isolation
*(DISPLAY-only intra-family rows. Decision: a member excluded from an expense contributes exactly 0 to that expense.)*
- [x] Step 60: `calculator.py::distribute_per_expense_net` — each expense's family net split EVENLY among only its participants (excluded ⇒ 0); `member_breakdown` restricted path rewritten; non-restricted path byte-identical (`round(net/size,2)`). (Settlement handling superseded by Step 63.)
- [x] Step 61: Tests — `TestDistributePerExpenseNet` + `TestBreakdownPerExpenseIsolation`.
- [x] Step 62: Docs (§5-A + USER_GUIDE) + full verification gate; cleared dev-trip junk settlements.
- [x] Step 63: CHRONOLOGICAL settlement replay — `distribute_chronological(events, roster)` replays the family's expenses + non-pending settlements in `paid_at`/`created_at` order; each settlement SCALES running positions toward 0 (full settle ⇒ 0; partial ⇒ proportional). Reads via `member_breakdown` → Balances rows + report Sheet 3b. No frontend change.

### Phase 15: Toast Manual Dismiss (UX)
*(Additive, frontend-only; triggers/messages/durations/auto-dismiss timer unchanged.)*
- [x] Step 64: Manual ✕ close on the shared `frontend/src/ui/Toast.tsx` (`IconButton name="close"`, `accessibilityLabel="Dismiss notification"`, ≥44px hit area, `colors.textMuted`); `dismiss` clears the auto-dismiss timer then runs the existing exit animation.

### Phase 16: Report (XLSX) Restructure
*(Report-layer ONLY — `backend/routes/reports.py` (openpyxl assembly) + `backend/services/report_builder.py` (pure builders). The report only DISPLAYS engine-computed values. Decision: reconcile via an explicit Settlements column; keep a Transactions journal → 4 tabs.)*
- [x] Step 65: Consolidate to 4 tabs (`Summary → Members & Families → Split Math → Transactions`). New pure builders (`mode_label`, `composition_label`/`trip_composition`, `entity_ledger_components`, `settle_adj_by_entity`, `build_summary_spend_rows`, `build_members_families_rows`, `build_split_math_rows`) reuse the SAME engine helpers as the ledger — `spend_summary.aggregate_spend`, `expense_shares.entity_shares_raw`, `_compute_balances` (`net_total` + chronological member breakdown), `build_per_capita_rows`/`build_per_family_rows`. Members & Families is hierarchical and foots exactly (`Net = Gross Spent − Share + Settlements`; Σ Paid = Σ Share, Σ Settlements = Σ Net = 0). Professional formatting (bold headers, frozen rows, currency format, subtotals). No frontend change.

### Phase 17: Tappable Per-Member Spend Drill-Down (Summary)
*(Additive, read-only. Reuses the category-drill-down fetch/filter pattern and the calculator-derived
`shares` already on the expense list; NO new endpoint, NO engine/settlement/report/Gmail change.
"Gross spend" = amount FRONTED (`spend_summary.aggregate_spend`: Σ positive `amount` by payer entity),
split-mode-independent, refunds excluded — the drill-down running total reconciles EXACTLY to the bar.
A member's per-expense `share` is DISPLAY-only and never summed into that total.)*
- [x] Step 66: Pure `frontend/src/memberSpend.ts::memberSpendHistory` (filter payer + positive amounts, attach each entity's own `shares` share, 2dp total == bar) + `src/__tests__/memberSpend.test.ts`.
- [x] Step 67: `SpendBarChart` gains optional `onBarPress`; each entity (name + bar) wrapped in ONE `TouchableOpacity`; zero-paid rows non-tappable. Summary tab routes to `/trip/[id]/member/[mid]`.
- [x] Step 68: New screen `frontend/app/trip/[id]/member/[mid].tsx` — header total (= bar), fronted-expense list (date/category/split_mode/amount + secondary "their share" caption), empty + loading states; rows open the expense editor. Reuses `Screen`/`Card`/`ListRow`/`EmptyState`/`AmountText`/`SkeletonCard`.
- [x] Step 69: Backend reconciliation guard in `backend/tests/test_spend_summary.py` (`TestDrilldownReconcilesToBar`: per-entity fronted sum == `aggregate_spend` paid, across PER_CAPITA + PER_FAMILY, family + individual payers; refunds/zero excluded both sides).
- [ ] Step 70: Docs (USER_GUIDE §6, done) + full verification gate — frontend jest/tsc/lint green + backend pure unit tests green; live-API pytest subset + commit still pending (needs a running server).

### Phase 18: Exploded Transactions Tab + PDF Report
*(Report-layer ONLY — `services/report_builder.py` (pure builder), `services/report_pdf.py` (new,
reportlab), `routes/reports.py` (openpyxl/route assembly), plus `frontend/src/api.ts` +
`reports.tsx`. Reuses `expense_shares.entity_shares_raw` + `calculator.allocate_within_family` — NO
forked split math, NO engine/settlement/RBAC/Gmail/auth change; Total Payable is the GROSS per-expense
share (settlement-independent). Decision: NAIVE per-member `round(share,2)` matches the hand-built
image-2 oracle exactly, incl. refund −85.71×7; totals reconcile Sum(Amount)=Sum(Total Payable)=pivot
Grand Total=63,100.)*
- [x] Step 71: Pure `build_expense_member_rows(expenses, members)` in `services/report_builder.py`
      (blocks of one row per trip member + alphabetical per-person pivot + grand totals) reusing
      `entity_shares_raw` / `allocate_within_family` / display-name helpers; oracle-reconciliation
      unit tests in `tests/test_report_builder.py::TestExplodedTransactions`.
- [x] Step 72: XLSX Transactions tab rewritten to the exploded layout in `routes/reports.py`
      (Sr No · Category · Description · Date · Amount · Split Mode · Paid By · Family · Person Name ·
      Total Payable; Amount/Mode/Paid By once per block; "-" for non-participants; right-side pivot;
      bold Grand Total). `_MONEY_FMT` renders negatives red/parenthesised.
- [x] Step 73: PDF report — `reportlab==4.5.1` (+ `pillow==12.2.0`) in `requirements.txt` (pure
      wheels, Render-safe), `services/report_pdf.py::build_report_pdf` (landscape Platypus table +
      pivot, repeating header, negatives red) from the SAME builder, and parallel
      `GET /trips/{id}/report.pdf` (same `?token=` auth as `report.xlsx`).
- [ ] Step 74: Frontend `api.ts::pdfUrl` + `reports.tsx` PDF button (`openReport(id,'pdf'|'xlsx')`);
      docs + full verification gate — frontend jest/tsc/lint green + backend pure unit tests green;
      live-API pytest subset + commit still pending (needs a running server).

### Phase 19: Header Profile Avatar (replaces the Logout icon)
*(Frontend-only, additive. The top-right header slot swaps the Logout icon for a circular Profile
avatar (person icon + 1–2 uppercase initials) that navigates to the existing `(tabs)` Profile route.
Logout is NOT removed — it stays on Profile via the unchanged Step-21 LogoutProvider/ConfirmModal/
authNav flow. No backend/auth/RBAC/split/report change.)*
- [x] Step 75: Pure `frontend/src/initials.ts` (single-string name → 1–2 uppercase initials: first+last
      token, else first 2 chars, else 1 char; trim/collapse whitespace; empty→'') + full-coverage
      `src/__tests__/initials.test.ts` (rules A/B/C + edge cases).
- [x] Step 76: `frontend/src/ProfileAvatarButton.tsx` — filled `colors.primary` circle, `user-round`
      icon + initials-below via `T`, IconButton-style Pressable (guarded haptics, web focus, ≥44px),
      tap → `router.navigate('/(tabs)/profile')`.
- [x] Step 77: Swap header `headerRight` in root `app/_layout.tsx` + `(tabs)/_layout.tsx` to
      `ProfileAvatarButton`; delete orphaned `src/LogoutButton.tsx`; Profile big avatar reuses
      `initials()`. Logout preserved on Profile (Step 21 unchanged); authNav/logout tests still green
      + full frontend gate (jest/tsc/lint).

### Phase 20: Partial Payments (Splitwise-style settlements)
*(Additive on a new `db.payments` collection + the existing greedy engine. A payment is a directed
money movement overlaid in `_compute_balances` (`net[from]+=amt, net[to]-=amt`) EXACTLY like a paid
settlement, so `minimize_transfers` re-derives the residual pairs and payments persist/offset the
RECOMPUTED balance after new expenses — NO forked split math, NO per-pair remap. "Paid"/"Partially
Paid" are DERIVED. The legacy `db.settlements` overlay is left UNTOUCHED (additive coexistence): legacy
paid rows keep netting; the app just stops using pending/mark-paid. Only the receiver (creditor's app
user) or a trip admin may record/edit/delete; the payer never self-records; amount `>0` and `<=` the
current suggested pair payable (no overpayment). No split-mode/GridFS/Gmail/auth/other-report-tab change.)*
- [x] Step 78: `models/payment.py` (`PaymentCreate`/`PaymentPatch`) + `db.payments` index in
      `server.py`; additive payments overlay in `utils/balances._compute_balances` AND the Phase-14
      breakdown call (`settlements + payments`); pure `services/payments.py::pair_blocks`/`payment_status`
      roll-up + `tests/test_payments_rollup.py` (pure).
- [x] Step 79: `routes/payments.py` CRUD (`GET`/`POST`/`PATCH`/`DELETE /trips/{id}/payments`) with
      server-side validation (amount `>0`, `<=` current pair payable, valid suggested pair; edit cap =
      residual + own amount); `can_record_payment` in `utils/permissions.py` + `_payment_or_403` in
      `utils/deps.py`; router registered in `server.py`; predicate unit tests in `test_payments_rollup.py`.
- [x] Step 80: Excel **Payments** tab (Payer | Payee | Amount({cur}) | Date & Time + bold Total) in
      `routes/reports.py` and the parallel PDF Payments section in `services/report_pdf.py`
      (`build_report_pdf(..., payments=)`); all existing tabs + `?token=` intact.
- [x] Step 81: settle-up rewrite (`app/trip/[id]/settle-up.tsx`: per-pair current payable, Partially
      Paid/Paid badges + progress, editable amount + "Max" hint + `ConfirmModal` guard-rail, payment
      log with date/time, receiver/admin edit/delete); pure `src/payments.ts` + `__tests__/payments.test.ts`;
      `src/api.ts` wrappers (`listPayments`/`recordPayment`/`editPayment`/`deletePayment`);
      `src/permissions.ts` `canRecordPayment` mirror. Frontend gate green (tsc + eslint + jest 248/248).
- [x] Step 82: full verification gate — live-API `tests/test_payments.py` **14/14 green** against a
      local Docker Mongo; full backend suite **581 passed / 2 skipped** (the only 2 fails are the
      pre-existing `test_auth` admin-login env caveat, unrelated to payments). `test_balances_reports`
      updated for the 5th "Payments" tab (+ a stale Phase-18 Transactions header assertion fixed).
      Frontend jest 248/tsc/lint green; docs (USER_GUIDE §7.2/§8/§9). Commit pending user go-ahead.

### Phase 21: Expenses Tab Date+Time Ordering
*(Frontend-only, DISPLAY-only. The pure helper `frontend/src/expenseSort.ts`
(`sortExpensesDesc`/`compareExpensesDesc`) already sorts the Expenses tab newest-first by each
expense's own date+time and is already wired at `app/trip/[id]/index.tsx` + the member drill-down
`app/trip/[id]/member/[mid].tsx`; NO engine/balance/settlement/report/RBAC/Gmail/auth change and NO
stored-data change — this only reorders how the list is presented. Storage is a `date` `"DD-MM-YY"`
field + an OPTIONAL `time` `"HH:MM"` (24h) field (two fields, not one datetime); `created_at` is a
tz-aware ISO stamp read by plain string slicing (no UTC/day shift). Contract, all descending, stable:
(1) calendar `date`, falling back to `created_at`'s date when missing/invalid; (2) time-of-day —
explicit `time`, else the row's `created_at` time-of-day (DECISION: date-only rows order by ENTRY
time, NOT a fabricated 23:59); (3) `created_at` ISO desc; (4) `id` desc. `sortExpensesDesc` returns a
new array and never mutates its input.)*
- [x] Step 83: Confirm the ordering contract is wired — Expenses tab (`index.tsx`) + member drill-down
      (`member/[mid].tsx`) already call `sortExpensesDesc`; current tab order is newest-first. No code
      change needed.
- [x] Step 84: Harden `src/__tests__/expenseSort.test.ts` — added the mixed same-day case (date-only vs
      timed rows; `created_at` time-of-day decides, not 23:59) and the unparseable-`time`-string
      fallback case. (Existing cases already cover date+time present, date-only fallback, mixed-date
      ordering, same date+time `created_at`→`id` tiebreaker, and missing/invalid date.)
- [x] Step 85: Docs (USER_GUIDE §5.2 — Expenses tab shows newest first by date+time) + full frontend
      gate green (jest 250/250, tsc clean, eslint clean).

### Phase 22: Exact-Amount Split (`split_mode = "EXACT"`)
*(Strictly additive third split mode, §5-C. The author assigns explicit per-person amounts (family
members and/or individuals) that MUST sum to the total — enforced in two layers (frontend Save-gate +
backend 422). Design: person-level input (`custom_amounts: {member_id -> amount}`, presence ⇒ involved,
absent ⇒ 0) rolls UP to the SAME `{entity_id: amount}` shape the two existing modes emit, so it flows
through `expense_shares.entity_shares_raw` → `_compute_balances` → `minimize_transfers` UNCHANGED; the
per-member family breakdown branches to the explicit amounts. All new fields optional; legacy rows and
PER_CAPITA §5-A / PER_FAMILY §5-B math byte-identical. EXACT ignores `family_participants`/
`weight_snapshots`; all reconciliation in integer cents, snapped largest-remainder so entity shares sum
exactly to the total. NOTE: the prompt's `calculator.distribute_per_expense_net` does not exist — the
Phase-14 breakdown is `member_breakdown.family_member_breakdown` + `calculator.distribute_chronological`
(extended with an optional per-member weight); two extra branch points also gained an EXACT arm
(`expense_shares.expense_share_breakdown`, `report_builder.build_expense_member_rows`) plus the
offline replica `income_migration.compute_net`.)*
- [x] Step 86: Model + pure validator — `SplitMode` += `"EXACT"` and optional `custom_amounts` on
      `models/expense.py`; new pure `services/custom_split.py::validate_exact_amounts(total, custom_amounts,
      valid_member_ids)` (keys ∈ person-level id space, amounts ≥ 0, ≥1 > 0, Σ == total ±0.01, then
      cent-snap) → normalized amounts or `ValueError`. No I/O. Unit tests in `tests/test_exact_split.py`.
- [x] Step 87: Pure resolver — `custom_split.resolve_exact_entity_shares(custom_amounts, members)`
      (person→entity rollup, cent-safe) + `exact_member_shares` (per-family per-member, absent ⇒ 0) +
      `valid_exact_member_ids`. Extensive unit tests.
- [x] Step 88: Wire EXACT into the share/ledger engine — third branch in `expense_shares.entity_shares_raw`,
      `utils/balances._compute_balances`, `member_breakdown.family_member_breakdown` (fam_share), and
      `income_migration.compute_net`, all calling `resolve_exact_entity_shares`. Ledger reconciliation
      tests (Σ entity_shares == total, family + individual payers).
- [x] Step 89: Wire EXACT into the per-member breakdown — `calculator.distribute_chronological` takes an
      optional per-event weight map (existing 3-tuples byte-identical); `family_member_breakdown` splits an
      EXACT expense's family net by the typed amounts (0-amount ⇒ 0), and `expense_shares.expense_share_breakdown`
      uses `exact_member_shares`. Breakdown equals typed amounts, foots to family net, settlement replay scales.
- [x] Step 90: Enforce the hard rule at the API — `routes/expenses.py` create + edit call the Step-86
      validator (`_validate_exact_or_422`) when the effective `split_mode == "EXACT"` and reject a
      mismatch with HTTP 422; persist normalized `custom_amounts` (PATCH merges over the stored doc;
      leaving EXACT drops stale amounts). `_expense_modify_or_403` RBAC unchanged. Live-API coverage in
      `tests/test_exact_split_api.py`.
- [x] Step 91: Reports — `report_builder` `_MODE_LABELS["EXACT"]="Exact"`, `build_split_math_rows` EXACT
      branch (per-entity rollup via `entity_shares_raw`), `build_expense_member_rows` family sub-split via
      `exact_member_shares`; XLSX (Split Math + Transactions tabs) + PDF render EXACT and reconcile
      (Σ amount == Σ payable). Pure tests in `tests/test_exact_split.py::TestReportBuilders`.
- [x] Step 92: Frontend pure helper `src/exactSplit.ts` (`reconcile`/`resolveEntityShares`/
      `splitRemainingEqually`, cent-safe) + `shared/exact-split-vectors.json` fixture asserted by BOTH
      `src/__tests__/exactSplit.test.ts` (17 jest) and `tests/test_exact_split.py::TestSharedVectors`.
- [x] Step 93: UI — third `[Exact]` pill in `SplitModeSelector`; reusable `src/ExactSplitEditor.tsx`
      (collapsible families w/ live subtotals, per-member checkbox+amount, reconciliation bar via
      `ProgressBar`, Save-gate, "split remaining equally", "not set" hint) replaces the Split-among list
      when EXACT in both add/edit expense; edit rehydrates `custom_amounts` via `buildExactRows`.
- [x] Step 94: `splitPreviewLabel` EXACT rollup ("Name cur X · …"); add/edit submit send
      `custom_amounts` + involved-entity `split_member_ids` through the generic `api()` (422 surfaced by
      the existing FastAPI error normalization); `SplitMode`/`split_mode` unions widened in
      `SplitModeSelector`/`expenseShares.ts`/`memberSpend.ts`. Frontend gate green (tsc, eslint,
      jest 267/267).
- [x] Step 95: Docs (CLAUDE.md §5-C + USER_GUIDE §5.1) + full verification gate. Backend: EXACT pure
      (`test_exact_split.py` 25) + live-API (`test_exact_split_api.py` 9) green; full suite **615 passed /
      2 skipped**, the only 2 failures the pre-existing `test_auth` admin-login env caveat (unrelated).
      Frontend: tsc clean, eslint 0 errors, jest 267/267. Live gate run against local Docker Mongo + a
      from-source uvicorn.
