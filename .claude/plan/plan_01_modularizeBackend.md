# Spec: Modularize Backend  (Step 01)

## Overview
Decompose the monolithic `backend/server.py` (815 lines) into cleanly decoupled
layers (`config`, `database`, `models/`, `utils/`, `routes/`) without changing
any runtime behavior or the HTTP API surface. This realizes CLAUDE.md Roadmap
**Phase 1 → Step 1** and unblocks all subsequent steps (RBAC, dual split modes,
`services/calculator.py`, etc.). `server.py` remains the ASGI entrypoint (a thin
assembler), so existing commands, tests, and deployment are untouched.

## Depends on
None. This is the first roadmap step.

## Key constraint
The tests in `backend/tests/` are **black-box HTTP integration tests** (they use
`requests` against `BASE_URL`, e.g. `test_auth.py:15`). They do **not** import
`server.py`. Therefore the refactor only needs to:
- keep the entrypoint `uvicorn server:app` working (so `server.py` stays and
  still exposes `app`), and
- preserve every `/api/...` path and response **byte-identical**.

An objective check: diff `GET /openapi.json` route list before vs. after — it
must be unchanged.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. The five Pydantic model groups are **moved verbatim** into
`models/` (no field changes). UUID `id` strings and `{"_id": 0}` projections are
preserved exactly. (RBAC `admin_ids`, `split_mode` enums, unique `linked_email`
belong to Steps 2–4 and are explicitly out of scope.)

## Backend API & Services (FastAPI)
No new or changed routes, inputs, outputs, status codes, or auth behavior. Each
existing endpoint is relocated to a per-domain `APIRouter()` and re-assembled
under the same `/api` prefix in `server.py`. Routing strategy:

- Each `routes/*.py` defines `router = APIRouter()` and keeps the **full path**
  in the decorator exactly as today (e.g. `@router.post("/auth/register")`,
  `@router.post("/trips/{trip_id}/members")`).
- `server.py` builds `api = APIRouter(prefix="/api")`, calls
  `api.include_router(<module>.router)` for each module, then
  `app.include_router(api)`. Net paths are identical (`/api/...`).

### Symbol → module migration map

| Destination | Symbols moved from `server.py` |
|---|---|
| `config.py` | `load_dotenv` of `backend/.env`, `logger`, `MONGO_URL`, `DB_NAME`, `JWT_SECRET`, `JWT_ALGORITHM`, `RESEND_API_KEY`/`SENDER_EMAIL`/`APP_URL`, `ADMIN_*` reads, `resend.api_key` setup, `CATEGORIES` |
| `database.py` | `client = AsyncIOMotorClient(...)`, `db` |
| `utils/common.py` | `gen_id`, `gen_trip_code`, `now_utc`, `iso` |
| `utils/security.py` | `hash_secret`, `verify_secret`, `create_token`, `decode_token` |
| `utils/deps.py` | `get_current_user`, `_trip_or_404` |
| `utils/balances.py` | `_weight_of_member`, `_compute_balances` |
| `models/auth.py` | `RegisterIn`, `LoginIn`, `ForgotIn`, `ResetPinIn` |
| `models/trip.py` | `TripIn`, `TripUpdate` |
| `models/member.py` | `MemberIn`, `MemberUpdate` |
| `models/expense.py` | `ExpenseIn`, `ExpenseUpdate` |
| `models/settlement.py` | `SettleIn` |
| `routes/auth.py` | `register`, `login`, `me`, `forgot_pin`, `reset_pin`, `forgot_password_alias` |
| `routes/trips.py` | `create_trip`, `list_trips`, `get_trip`, `update_trip`, `delete_trip`, `join_trip` |
| `routes/members.py` | `add_member`, `update_member`, `delete_member` |
| `routes/expenses.py` | `add_expense`, `list_expenses`, `update_expense`, `delete_expense` |
| `routes/balances.py` | `balances`, `settle` |
| `routes/reports.py` | `report`, `report_xlsx` |
| `routes/meta.py` | `get_categories` |
| `server.py` (kept, thin) | `app = FastAPI(...)`, `api` assembly, startup (indexes + admin seed), shutdown, CORS middleware |

> **Note:** `_trip_or_404` is placed in `utils/deps.py` next to `get_current_user`
> (both are access-guard helpers needing `db`) rather than in `utils/balances.py`.
> This keeps `utils/balances.py` purely the settlement math that migrates to
> `services/calculator.py` in Step 5, and avoids every route importing from a
> "balances" module just to guard access.

### Import / dependency graph (no cycles)
```
config        -> (stdlib + resend only)
database      -> config
utils/common  -> (stdlib only)
utils/security-> config
utils/deps    -> database, utils/security
utils/balances-> database
models/*      -> pydantic only
routes/*      -> models/*, utils/*, database, config
server        -> config, database, utils/*, routes/*
```
`config.py` calls `load_dotenv(Path(__file__).parent / '.env')` at import time so
env vars are loaded before any module reads them; `server.py` imports `config`
first. No `utils`/`models` module imports a `routes` module (prevents cycles).
`routes/reports.py` imports `_compute_balances` from `utils/balances.py` (not from
`routes/balances.py`) so routes never import routes.

## App Screens & UI (Expo React Native)
No frontend changes.

## State & API Integration
No changes to `frontend/src/api.ts`, contexts, or AsyncStorage. The API base URL
and all paths are unchanged.

## Files to change
- `backend/server.py` — reduced to a thin assembler (app, `/api` router includes,
  startup/shutdown, CORS). No behavior change.
- `CLAUDE.md` — flip Roadmap Step 1 checkbox to `[x]` once verified.

## Files to create
- `backend/config.py`
- `backend/database.py`
- `backend/models/__init__.py`, `models/auth.py`, `models/trip.py`,
  `models/member.py`, `models/expense.py`, `models/settlement.py`
- `backend/utils/__init__.py`, `utils/common.py`, `utils/security.py`,
  `utils/deps.py`, `utils/balances.py`
- `backend/routes/__init__.py`, `routes/auth.py`, `routes/trips.py`,
  `routes/members.py`, `routes/expenses.py`, `routes/balances.py`,
  `routes/reports.py`, `routes/meta.py`

## New Dependencies
No new dependencies. All imports (`fastapi`, `motor`, `bcrypt`, `PyJWT`,
`resend`, `openpyxl`, `pydantic`, `starlette`, `python-dotenv`) already exist in
`backend/requirements.txt`.

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined
  in Section 5 of `CLAUDE.md` — N/A for this step (no split-mode logic exists yet),
  but do not break the existing single split calculation in `_compute_balances`.
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact.
- Enforce Role-Based Access Control (RBAC) on the backend before executing
  destructive edits/deletes — N/A: no RBAC exists yet (Step 2+); preserve existing
  `_trip_or_404` membership checks exactly as-is.
- Follow the frontend design system tokens; support dynamic light/dark mode via
  `ThemeContext` — N/A, no frontend changes in this step.
- Keep changes strictly scoped to this step; do not refactor unrelated code.
- **Pure move, zero behavior change.** Copy function bodies verbatim; only adjust
  imports and the router object name (`api` → per-module `router`).
- Keep `server:app` as the ASGI entrypoint so `uvicorn server:app --reload` and
  all tests work unchanged.
- Preserve every `/api/...` path, HTTP method, status code, and the `{"_id": 0}`
  projections / UUID `gen_id()` usage exactly.
- Keep `report.xlsx` taking the JWT via the `token` **query param** (browser link),
  not a header.
- Keep startup index creation + admin seeding and shutdown `client.close()`.
- Do **not** introduce `services/`, RBAC `admin_ids`, `split_mode` enums, unique
  `linked_email`, or any Step 2+ feature. Strictly scoped to Step 1.
- Follow existing style (section spacing, helper naming with leading `_`).

## Definition of Done
1. **Baseline first:** with the *current* `server.py` running against MongoDB,
   run `pytest` and record the pass/skip/fail set (some legacy tests already
   skip/fail — see Out of scope). This is the bar to match.
2. `uvicorn server:app --reload` boots cleanly from `backend/`; startup logs index
   creation and admin seeding; no import errors.
3. `GET /openapi.json` route+method set is **identical** to the baseline (objective
   proof the API surface is unchanged).
4. `pytest` produces the **same or better** results than the baseline — no *new*
   failures across `test_auth`, `test_trips`, `test_members`, `test_expenses`,
   `test_balances_reports`, `test_meta`.
5. Smoke checks pass: admin login (`POST /api/auth/login` password + PIN),
   `GET /api/meta/categories` returns the 7 categories, create-trip →
   add-member → add-expense → `GET /api/trips/{id}/balances` returns expected math.
6. `server.py` contains no route/model/business logic — only app assembly,
   router includes, startup/shutdown, and CORS.
7. CLAUDE.md Roadmap **Step 1** checkbox flipped `- [ ]` → `- [x]` and committed.

## Verification (how to run end-to-end)
Tests are HTTP integration tests, so a live server + MongoDB are required.

```bash
# 1. backend/.env must have MONGO_URL, DB_NAME, JWT_SECRET, ADMIN_* set
cd backend
uvicorn server:app --reload            # terminal A (serves on :8000)

# 2. point every test file at the local server
export EXPO_PUBLIC_BACKEND_URL=http://localhost:8000   # PowerShell: $env:EXPO_PUBLIC_BACKEND_URL="http://localhost:8000"
pytest                                  # terminal B

# 3. objective surface diff (run before refactor, save; run after, compare)
curl -s http://localhost:8000/openapi.json | jq -S '.paths | keys'
```

## Out of scope (pre-existing, do NOT fix here)
- `test_auth.py::test_reset_password_flow` targets the old `/api/auth/reset-password`
  + `new_password` and reads `/var/log/supervisor/backend.err.log` (Linux path);
  the live API is `/auth/reset-pin`. It already skips/fails independent of this
  refactor — leave it for a later cleanup step.
- Deprecated `@app.on_event("startup"|"shutdown")` is kept as-is (migrating to
  lifespan handlers is a separate concern).
