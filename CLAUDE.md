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
* `GOOGLE_CLIENT_ID`: OAuth 2.0 client ID used to verify Google ID tokens for `POST /api/auth/google`

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
- [ ] Step 11: Member Administration Locks. Protect member/family mutation endpoints to ensure exclusively authenticated Trip Admins can execute modifications.
- [ ] Step 12: Complex Joining Context API. Refactor the invitation code route (`/join`) to handle contextual payloads mapping whether the incoming profile is arriving as a clean individual, linking into a family entity, or initializing a new group structure.

### Phase 4: Join Pipeline & Member Administration (Frontend)
- [ ] Step 13: Interactive Join Wizard UI. Build out a clear navigation step processing trip code validations. Prompt user with clear selection triggers: "Join as Individual", "Join existing Family [Dynamic Picker]", or "Create New Family Lineage".
- [ ] Step 14: Administrative Controls Member Tab. Upgrade the Members roster interface. Implement crisp operational badges distinguishing Admins, and open modal pathways to allow designated admins to safely alter family configurations.
- [ ] Step 15: Structural Recalculation Prompt. Attach a UI confirmation trigger upon family size adjustment saving operations. Prompt: "Apply updates retroactively to prior expenses or apply to future items only?", firing the Phase 2 backend recalculation route when accepted.

### Phase 5: Transaction Interfaces (Frontend)
- [ ] Step 16: Dual Split Mode Selector. Integration of a visible segmented control element inside Add/Edit transaction screens supporting toggles between [Per Person] and [Per Family]. Drive active form sub-label state changes detailing simulated pricing splits dynamically.
- [ ] Step 17: RBAC-Driven Component Hiding. Condition the visibility states of transaction update and deletion elements based on current identity roles (validating creator token flags or trip admin criteria).

### Phase 6: Core Presentation Layer & Media Handling (Frontend)
- [ ] Step 18: Layout UI Audit & Standardization. Homogenize typography scales, layout padding grids, and color tokens across all interfaces. Update Home and Detail layouts to compute exact strings reading: `[X] Individuals across [Y] Families & [Z] Singles`.
- [ ] Step 19: Ubiquitous Global Session Drop. Leverage Expo Router layout configurations (`_layout.tsx`) utilizing `screenOptions` mappings to anchor the shared application `LogoutButton` element into the persistent top-right header layout frame universally across all screens.
- [ ] Step 20: Photo Asset Acquisition & Gallery Pipeline. Wire up `expo-image-picker` actions to intercept receipt images. Embed a download trigger on the target transaction asset modal consuming `expo-media-library` configurations to safely write files back into the phone’s local camera roll gallery.