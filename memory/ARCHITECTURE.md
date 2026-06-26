# Trip Splitter — Architecture

A codebase map for new developers (human or AI). For setup/commands see `../CLAUDE.md`. For end-user
behavior see `../USER_GUIDE.md`. For product scope see `PRD.md`.

## 1. Overview

Trip Splitter is a mobile app (Expo/React Native, file-based routing via `expo-router`) backed by a
single-file FastAPI service (`backend/server.py`) and MongoDB (via Motor). Users register with an
email + 4-digit PIN, create "trips" (each with a unique 6-character join code), add "members" who can
be individuals or families, log expenses (a signed amount — positive is spending, negative is money
coming back to the group) against those members, and the app computes per-member net balances and a
minimum-transaction settlement plan. It can export an XLSX report per trip.

## 2. Backend structure (`backend/server.py`)

Everything lives in one file, organized into `# ---------- Name ----------` sections, in this order:

- **Setup** (lines ~28-50) — logging, env vars (`MONGO_URL`, `DB_NAME`, `JWT_SECRET`, `RESEND_API_KEY`,
  `SENDER_EMAIL`, `APP_URL`), Mongo client/db handle, FastAPI `app` + `APIRouter(prefix="/api")`
  (`api`), and the global `CATEGORIES` list (`Travel, Accommodation, Local Transportation,
  Local Sightseeing, Food, Shopping, Other`).
- **Utils** (~53-110) — `hash_secret`/`verify_secret` (bcrypt for both password and PIN),
  `create_token`/`decode_token` (JWT, `HS256`, 30-day expiry), `get_current_user` (FastAPI dependency
  that reads `Authorization: Bearer <jwt>`), `gen_trip_code` (6-char A-Z0-9), `gen_id` (UUID4 string),
  `now_utc`/`iso` (datetime helpers). Every doc uses string `id` fields (not Mongo `_id`); all reads
  project `{"_id": 0}`.
- **Models** (~113-195) — Pydantic request bodies: `RegisterIn`, `LoginIn`, `ForgotIn`, `ResetPinIn`,
  `TripIn`/`TripUpdate`, `MemberIn`/`MemberUpdate`, `ExpenseIn`/`ExpenseUpdate`, `SettleIn`.
- **Auth** (~200-299) — `/auth/register`, `/auth/login` (password OR PIN), `/auth/me`,
  `/auth/forgot-pin` + `/auth/reset-pin` (token-based, emailed via Resend or logged), and a
  backward-compat alias `/auth/forgot-password` → `forgot_pin`.
- **Trips** (~302-396) — `_trip_or_404` (membership check helper), CRUD on `db.trips`
  (`POST/GET/PATCH/DELETE /trips[/{id}]`), and `/trips/join` (join-by-code, with email-based
  auto-linking — see §4).
- **Members** (~399-509) — members are an **embedded array on the trip document** (`trip.members`,
  not a separate collection). `POST/PATCH/DELETE /trips/{id}/members[/{id}]` handle add/edit/delete,
  duplicate name/email checks, family-merge-in-place, and the "keep original split vs re-split"
  weight-snapshot logic (see §4).
- **Expenses** (~512-584) — `_weight_of_member` (the core split-weight function), CRUD on
  `db.expenses` (`POST/GET/PATCH/DELETE /trips/{id}/expenses[/{id}]`), category validation, member-id
  validation, and the budget-over-limit confirmation flow (`force` query param).
- **Balances / Settle Up** (~587-670) — `_compute_balances` (the settlement engine, see §4),
  `GET /trips/{id}/balances`, `POST /trips/{id}/settle` (writes to `db.settlements`).
- **Reports** (~669-774) — `GET /trips/{id}/report` (JSON summary) and
  `GET /trips/{id}/report.xlsx` (4-sheet Excel via `openpyxl`, streamed back).
- **Meta** (~775-780) — `GET /meta/categories` (returns the `CATEGORIES` list).
- **Startup/Shutdown** (~781-815) — creates indexes (`users.email` unique, `trips.code` unique,
  `expenses (trip_id, created_at)`), seeds the admin user from `ADMIN_EMAIL`/`ADMIN_PASSWORD`/
  `ADMIN_PIN`, mounts the router, and adds permissive CORS (`allow_origins=["*"]`).

## 3. Data model (MongoDB collections)

### `users`
| field | notes |
|---|---|
| `id` | UUID string, primary key used everywhere (not `_id`) |
| `email` | lowercased, unique index |
| `name` | display name |
| `password_hash`, `pin_hash` | bcrypt; password is optional/legacy, PIN is the primary credential |
| `role` | `"user"` or `"admin"` (admin seeded on startup) |
| `created_at` | ISO string |

### `trips`
| field | notes |
|---|---|
| `id` | UUID string |
| `code` | 6-char unique join code (`gen_trip_code`) |
| `name`, `travel_date` (DD-MM-YY), `budget` (optional), `currency` | trip metadata |
| `owner_id` | user id of creator; only owner can delete the trip |
| `user_ids` | array of user ids with access (membership check via `_trip_or_404`) |
| `members` | **embedded array** of member sub-documents (see below) — not a separate collection |
| `created_at` | ISO string |

**Member sub-document** (inside `trips.members[]`):
| field | notes |
|---|---|
| `id` | UUID string, referenced by expenses (`paid_by_member_id`, `split_member_ids`) |
| `name`, `kind` (`"individual"` \| `"family"`) | |
| `family_members` | list of name strings (only for `kind == "family"`); split weight = `max(1, len(family_members))` |
| `email` | optional; used to auto-link an app user on join (see §4) |
| `user_id` | set when this member corresponds to an app user (the trip creator, or someone who joined via code) |

### `expenses`
| field | notes |
|---|---|
| `id`, `trip_id` | |
| `amount` | signed real (non-zero); **positive = expense, negative = money back to the group** (mirror split) |
| `category` (must be in `CATEGORIES`), `description`, `date` (DD-MM-YY) | |
| `paid_by_member_id` | member id who paid |
| `split_member_ids` | member ids to split among; **empty = split among ALL current trip members** |
| `weight_snapshots` | optional `{member_id: weight}` override — used for (a) partial-family splits and (b) preserving historical weights after a family's size changes (see §4) |
| `receipt_base64` | optional base64 image, stored inline on the document |
| `created_by`, `created_at` | |

### `settlements`
| field | notes |
|---|---|
| `id`, `trip_id` | |
| `from_member_id`, `to_member_id`, `amount` | a recorded "X paid Y amount Z"; applied as a permanent adjustment in `_compute_balances` |
| `created_at`, `created_by` | |

### `password_reset_tokens`
| field | notes |
|---|---|
| `token` (random urlsafe), `user_id`, `kind` (`"pin"`) | |
| `expires_at` (1 hour), `used` (bool) | |

## 4. Core flows

### Auth (password + PIN + JWT)
1. `POST /auth/register` — email lowercased/uniqueness-checked, PIN must be 4 digits, password is
   optional (a random one is generated if omitted since PIN is primary). Both are bcrypt-hashed.
   Returns a 30-day JWT (`create_token`) + user object.
2. `POST /auth/login` — accepts `{email, password}` OR `{email, pin}`; verifies against the matching
   hash and returns a fresh JWT.
3. Every protected route depends on `get_current_user`, which decodes the bearer JWT and loads the
   user (stripping `password_hash`/`pin_hash`).
4. `POST /auth/forgot-pin` — always returns `{ok: true}` (no email enumeration); if the user exists, a
   1-hour token is stored in `password_reset_tokens` and emailed via Resend (or just logged if
   `RESEND_API_KEY` is unset — see `USER_GUIDE.md` §11). `POST /auth/reset-pin` consumes the token and
   sets a new `pin_hash`. `/auth/forgot-password` is a back-compat alias to `forgot-pin`.

### Joining a trip & avoiding double-counting (`POST /trips/join`)
- Look up the trip by `code`. If the user is already in `user_ids`, return as-is.
- Else, scan `trip.members` for a **family** member whose `email` matches the joining user's email
  and that has no `user_id` yet → link the user to that family member in place (`$push user_ids`,
  `$set members.$.user_id`). This is how "you" can be pre-added as part of a family by someone else.
- Otherwise, append a brand-new individual member with `user_id` = the joining user.
- Symmetric logic exists in `add_member`: if you add a **family** whose email matches an existing
  individual app-user member, that individual is converted **in place** into the family (same `id`,
  so past expenses still apply) instead of creating a duplicate.

### Expense splitting (individual vs family, weights, `split_family_count`)
- `_weight_of_member(m)`: individuals → weight `1`; families → `max(1, len(family_members))`.
- On `POST /trips/{id}/expenses`, `split_member_ids` defaults to *all* trip members if empty.
- The frontend's "Split among N of M" control (add-expense screen) is implemented via
  `weight_snapshots: {member_id: N}` sent on the expense — this overrides that member's weight for
  *this expense only* (this is the `split_family_count` concept referenced in the PRD/UI).
- A budget check runs only for `kind == "expense"` and only if `trip.budget` is set: it sums existing
  expense amounts + the new one; if over budget and `force` is not `true`, it returns
  `{requires_confirmation: true, warning: "..."}` instead of saving — the frontend then re-submits with
  `?force=true` if the user confirms.

### Balance settlement (`_compute_balances`)
For each member, `net` starts at 0. For every `kind == "expense"` document:
- `total_weight` = sum of each split member's weight (from `weight_snapshots` if present, else
  `_weight_of_member`).
- `per_unit = amount / total_weight`; each split member's `net` is debited `per_unit * their_weight`.
- The payer's `net` is credited the full `amount`.

Then every `settlements` record is applied: `from_member_id.net += amount`,
`to_member_id.net -= amount` (a settlement is "X gave Y money", reducing what X is owed / increasing
what Y is owed back, i.e. moving both toward zero).

All nets are rounded to 2 decimals. A **greedy minimum-transfer algorithm** then pairs the largest
debtor with the largest creditor repeatedly (`transfers` list) until everyone is within 0.01 of zero.
The response also includes `per_person` (per-member and, for families, per-person-within-family net
figures used by the UI's family breakdown).

### Reports (XLSX)
`GET /trips/{id}/report.xlsx?token=<jwt>` — auth is via a **query-param JWT** (not a header) so the
link can be opened directly by the device's browser/download manager. Builds an `openpyxl` workbook
in-memory with 4 sheets — *Summary*, *By Category*, *Per Member*, *Per Family Person*, *Transactions*
— and streams it back as `StreamingResponse` with a `Content-Disposition: attachment` header.

## 5. Frontend (`frontend/`)

Expo SDK 54, `expo-router` file-based routing rooted at `frontend/app/`.

### Route map
- `app/index.tsx` — splash/redirect: waits for `AuthContext`'s `user` to resolve, then routes to
  `(tabs)/dashboard` or `(auth)/login`.
- `app/_layout.tsx` — root `Stack`, wraps everything in `GestureHandlerRootView` →
  `SafeAreaProvider` → `ThemeProvider` → `AuthProvider`; declares all modal/stack screens
  (trip detail, add/edit member, add/edit expense, settle-up, edit trip, category drill-down,
  create-trip, join-trip) and renders `LogoutButton` in the header when signed in.
- `app/(auth)/_layout.tsx` + screens: `login` (PIN-based, remembers last email via
  `AuthContext.savedEmail`), `register` (name+email+PIN, password optional/unused by UI),
  `pin-login` (alternate quick-login), `forgot` (calls `/auth/forgot-pin`), `reset` (calls
  `/auth/reset-pin`, can prefill `token` from a deep link param).
- `app/(tabs)/_layout.tsx` + screens — bottom tab bar:
  - `dashboard.tsx` — aggregates each trip's `/balances`, finds "your" member by `user_id`, and shows
    net "you owe / you're owed" plus a recent-trips list.
  - `trips.tsx` — full trip list, "New" and "Join a trip with code" entry points.
  - `add.tsx` — pick a trip → jumps to `trip/[id]/add-expense`.
  - `reports.tsx` — per-trip "XLSX" button that opens `report.xlsx?token=...` via `Linking.openURL`.
  - `profile.tsx` — user info, dark-mode `Switch` (via `ThemeContext.toggle`), sign out.
- `app/create-trip.tsx`, `app/join-trip.tsx` — modals for creating/joining trips.
- `app/trip/[id]/index.tsx` — the trip detail screen; tabs are **client-side state**, not routes:
  `summary` (You-card, budget bar, mini-stats, `DonutChart` by category),
  `expenses` (list with delete + tap-to-edit), `balances` (per-member net + family breakdown +
  suggested transfers), `members` (list + add/edit/delete).
- `app/trip/[id]/add-member.tsx` / `edit-member.tsx` — member create/edit; `edit-member` implements the
  "keep original split vs re-split with new members" prompt (`reweight_past` flag, see §4) and blocks
  deleting members that have expenses or are linked to an app user.
- `app/trip/[id]/add-expense.tsx` / `edit-expense.tsx` — the expense form: kind toggle, amount,
  description, category chips, date, paid-by radio list, split checkboxes with per-family "split
  among N of M" chips (→ `weight_snapshots`), optional receipt via `expo-image-picker` (base64), and
  the budget-warning confirm/`force=true` retry.
- `app/trip/[id]/settle-up.tsx` — lists `balances.transfers`, "Mark paid" → `POST /trips/{id}/settle`.
- `app/trip/[id]/edit.tsx` — edit trip name/date/budget/currency.
- `app/trip/[id]/category/[name].tsx` — drill-down into one category's transactions (reached by
  tapping a `DonutChart` slice/legend row).

### `src/` shared modules
- `api.ts` — `api<T>(path, {method, body, auth})` thin fetch wrapper: prefixes
  `${EXPO_PUBLIC_BACKEND_URL}/api`, attaches `Authorization: Bearer <token>` from AsyncStorage when
  `auth !== false`, normalizes FastAPI `detail` error shapes into `Error.message` (+ `.status`/`.data`).
  Also exports `getToken`/`setToken` (AsyncStorage-backed) and `xlsxUrl()`.
- `AuthContext.tsx` — holds `user` (`undefined` = loading, `null` = signed out), `savedEmail`
  (AsyncStorage, for the "remember me" quick-PIN login), and `signIn`/`register`/`signOut`/`refresh`.
- `ThemeContext.tsx` + `theme.ts` — light/dark `COLORS` (Organic & Earthy palette per
  `design_guidelines.json`), `SPACING`/`RADIUS` tokens, `CATEGORIES` and `CURRENCIES` constants, mode
  persisted in AsyncStorage and toggled from Profile.
- `T.tsx` — typed `<Text>` wrapper with variants (`h1`/`h2`/`h3`/`body`/`label`/`caption`/`money`) that
  applies theme colors; used everywhere instead of raw `Text`.
- `DonutChart.tsx` — SVG donut chart (`react-native-svg`) with a tappable-slice legend; exports
  `paletteForMode(mode)` used by the trip summary.
- `LogoutButton.tsx` — header sign-out button with a confirmation alert.

## 6. Cross-cutting conventions & gotchas

- **IDs**: everything uses app-generated UUID4 strings (`gen_id()`) stored in an `id` field; Mongo's
  `_id` is always stripped via `{"_id": 0}` projections. Don't rely on `_id`.
- **Members are embedded**, not a collection — updates use positional `$` operators
  (`{"members.$.field": ...}` with a filter on `members.id`). Any new member field must be added in
  three places: `MemberIn`/`MemberUpdate` models, the relevant trip endpoints, and the frontend
  `Member` types in each screen that declares one locally (there's no shared type file).
- **`split_member_ids: []` means "everyone currently on the trip"**, evaluated at read/compute time —
  so adding a member after an expense was created will retroactively include them in that expense's
  split unless `weight_snapshots`/explicit `split_member_ids` were set.
- **`weight_snapshots` is overloaded**: it's used both for the "split among N of M family members"
  per-expense override (set by `add-expense.tsx`) and for "freeze this member's old weight" when a
  family's size changes and the user chooses "keep original split" (set by `update_member`). Both
  paths write to the same dict.
- **`CATEGORIES` is duplicated**: defined in `backend/server.py` and again in `frontend/src/theme.ts`.
  Keep them in sync manually — there's no shared source of truth.
- **No shared TypeScript types**: `Member`/`Trip`/`Expense`/`Balances` types are redefined locally
  in nearly every screen file. Expect drift; check the actual API response shape in `server.py`
  rather than trusting a screen's local type.
- **report.xlsx auth is a query param**, not a header — required because it's opened via
  `Linking.openURL`/browser download, not `fetch`. The handler has a vestigial unused `_unused`
  parameter.
- **Money is rounded to 2 decimals** server-side in balances/reports, but raw floats are stored;
  rounding errors are handled by treating `|net| < 0.01` as zero in `_compute_balances`.
- **CORS is wide open** (`allow_origins=["*"]`, `allow_credentials=False`) — fine for a Bearer-token
  API, but don't add cookie-based auth without revisiting this.
- **Currency is per-trip with no conversion** — all amounts in a trip are assumed to be the same
  currency; switching a trip's currency does not convert existing amounts.
- **Receipts** are stored as base64 strings directly inside expense documents — large images will
  bloat `expenses` documents (no size limit enforced server-side; frontend picks at `quality: 0.4`).
- **Dates are free-text `DD-MM-YY` strings**, not real date types — sorting (`by_date` in reports) is
  lexicographic, which only happens to work because the format is fixed-width and chronological within
  a year boundary isn't guaranteed for cross-year trips.

## 7. Known issues / TODOs / tech debt

- `backend/.env` and `frontend/.env` are **committed to git** and contain live-looking secrets
  (`JWT_SECRET`, `RESEND_API_KEY`). Treat as already exposed; see `../CLAUDE.md`.
- `ExpenseUpdate.force` exists on the model but `update_expense` never re-runs the budget-over-limit
  check on edits (only `add_expense` does) — editing an expense's amount can silently push a trip over
  budget with no warning.
- The forgot/reset-PIN end-to-end flow is marked as test-skipped (`test_reports/iteration_1.json`):
  "could not parse token from backend logs reliably" — covered manually via `memory/test_credentials.md`.
- `root README.md` is a placeholder (`# Here are your Instructions`) with no real content.
- From `memory/PRD.md`, explicitly out of scope for MVP: live FX conversion, push notifications, PDF
  export/share, role-based access beyond owner-only delete, offline sync.

## 8. Directory & key-file map

```
backend/
  server.py            # entire API (see §2)
  requirements.txt
  .env                  # MONGO_URL, DB_NAME, JWT_SECRET, ADMIN_*, RESEND_*, APP_URL
  tests/
    conftest.py         # api_client / admin_token / test_user fixtures, hits EXPO_PUBLIC_BACKEND_URL
    test_auth.py
    test_trips.py
    test_members.py
    test_expenses.py
    test_balances_reports.py
    test_meta.py

frontend/
  app/
    index.tsx            # splash → redirect to (tabs) or (auth)
    _layout.tsx           # root Stack + providers
    (auth)/               # login, register, pin-login, forgot, reset
    (tabs)/                # dashboard, trips, add, reports, profile (+ _layout = bottom tabs)
    create-trip.tsx
    join-trip.tsx
    trip/[id]/
      index.tsx            # trip detail (summary/expenses/balances/members/ai tabs)
      add-expense.tsx
      edit-expense.tsx
      add-member.tsx
      edit-member.tsx
      edit.tsx              # edit trip metadata
      settle-up.tsx
      category/[name].tsx   # per-category drill-down
  src/
    api.ts               # fetch wrapper + token storage
    AuthContext.tsx
    ThemeContext.tsx
    theme.ts              # COLORS / SPACING / RADIUS / CATEGORIES / CURRENCIES
    T.tsx                  # themed <Text>
    DonutChart.tsx
    LogoutButton.tsx
  .env                   # EXPO_PUBLIC_BACKEND_URL etc.
  app.json, package.json, tsconfig.json, eslint.config.js

memory/
  PRD.md                 # product spec / MVP scope
  test_credentials.md    # admin + test user creds, auth endpoint cheatsheet
  ARCHITECTURE.md         # this file

design_guidelines.json   # color/typography tokens (source for src/theme.ts)
USER_GUIDE.md            # end-user documentation
test_result.md           # testing protocol + agent communication log
test_reports/            # iteration_1.json + pytest output
CLAUDE.md                 # dev commands + architecture summary for AI agents
```
