# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Trip Expense Splitter — a mobile app (Expo/React Native) + FastAPI/MongoDB backend for tracking trip
expenses, splitting costs between individuals and families, settling balances, and exporting reports.
See `USER_GUIDE.md` for full feature documentation and `memory/PRD.md` for the product spec.

## Architecture

### Backend (`backend/server.py`)
Single-file FastAPI app (no internal package structure). Sections are marked with `# ---------- Name ----------`
comments and appear in this order: Setup → Utils → Models (Pydantic) → Auth → Trips → Members →
Expenses → Balances/Settle Up → Reports → AI → Startup.

- All routes are registered on an `APIRouter(prefix="/api")` which is mounted on `app` at the bottom of the file.
- Mongo access via Motor (`AsyncIOMotorClient`); collections are accessed directly as `db.<collection>` (e.g. `db.users`, `db.trips`, `db.expenses`).
- Auth: bcrypt-hashed password + 4-digit PIN, JWT bearer tokens (30-day expiry, `HS256`, secret from `JWT_SECRET`). `get_current_user` dependency decodes the `Authorization: Bearer <token>` header.
- IDs are UUID strings (`gen_id()`), not Mongo ObjectIds — documents store `id` and queries use `{"_id": 0}` projections to strip Mongo's internal id.
- A trip's `user_ids` array tracks which app users can access it; `_trip_or_404` enforces membership.
- Members are either individuals or families (`family_members: []`); `_weight_of_member` determines the per-member split weight, and expenses can override the family weight per-transaction via `split_family_count`.
- Balance/settle-up logic lives in `_compute_balances` — a greedy minimum-transaction settlement algorithm.
- XLSX reports (`report.xlsx`) are built in-memory with `openpyxl` and streamed back; this endpoint takes the JWT as a `token` query param (not a header) since it's opened via a browser link.
- AI features (`/api/ai/categorize`, `/api/trips/{id}/ai-insights`) call Claude Sonnet 4.5 via `emergentintegrations`, gated by `EMERGENT_LLM_KEY`.
- On startup, indexes are created and an admin user is seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_PIN` env vars if it doesn't exist.
- Forgot-PIN flow sends email via Resend (`RESEND_API_KEY`); if not configured, the reset token is logged instead (see `memory/test_credentials.md` / `USER_GUIDE.md` §11).

### Frontend (`frontend/`)
Expo SDK 54 app using `expo-router` (file-based routing under `frontend/app/`).

- Route groups: `(auth)` for login/register/forgot/reset/pin-login, `(tabs)` for the bottom-tab nav (dashboard, trips, add, reports, profile), and `trip/[id]/*` for trip detail, member/expense add-edit modals, settle-up, and category drill-down.
- Shared logic lives in `frontend/src/`:
  - `api.ts` — thin fetch wrapper; reads `EXPO_PUBLIC_BACKEND_URL`, attaches the bearer token from AsyncStorage, normalizes FastAPI error responses, and builds the XLSX download URL.
  - `AuthContext.tsx` — session state, sign in/up/out, remembers last-used email for quick PIN login.
  - `ThemeContext.tsx` / `theme.ts` — light/dark color schemes, persisted via AsyncStorage, toggled from Profile.
  - `DonutChart.tsx`, `T.tsx`, `LogoutButton.tsx` — shared UI components used across screens.
- All screens read the backend base URL from `process.env.EXPO_PUBLIC_BACKEND_URL` (set in `frontend/.env`); there is no localhost fallback baked into the app itself.

## Commands

### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --reload          # run the API (loads backend/.env via python-dotenv)
pytest                                # run all tests
pytest tests/test_auth.py             # run one test file
pytest tests/test_auth.py::TestAuth::test_register_success   # run one test
```
Backend tests (`backend/tests/`) are `requests`-based integration tests that hit a live server at
`EXPO_PUBLIC_BACKEND_URL` (falls back to the deployed preview URL in `conftest.py` if unset) — point
this at a locally running backend to test against local code. Tests that depend on the seeded admin
account or specific data will `pytest.skip` if that precondition isn't met.

### Frontend
```bash
cd frontend
yarn install
yarn start      # expo start — scan QR with Expo Go
yarn android / yarn ios / yarn web
yarn lint       # expo lint
```

## Required environment variables

- `backend/.env`: `MONGO_URL`, `DB_NAME`, `JWT_SECRET`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_PIN`, `EMERGENT_LLM_KEY` (AI features), `RESEND_API_KEY`/`SENDER_EMAIL`/`APP_URL` (password-reset email).
- `frontend/.env`: `EXPO_PUBLIC_BACKEND_URL` (API base URL the app talks to).

Note: both `.env` files are currently committed to this repo and contain live-looking secrets
(JWT signing secret, Resend API key, Emergent LLM key). Treat any values found there as already
exposed — don't propagate them elsewhere, and prefer rotating/relocating to a non-tracked file when
making related changes.
