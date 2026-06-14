# Plan: Step 03 — Unique Family Mapping + Gmail-Only Identity & Google Sign-In

## Context
Roadmap **Step 3** ("Unique Family & **Domain** Mapping") originally scoped two things: (a) guarantee
unique member names within a trip, and (b) guarantee unique linked emails within a trip. The user has
expanded this step with a product decision: **the project is now gmail-only**. Concretely:

1. **Every email input** in the system must end in `@gmail.com`; anything else is rejected.
2. Add **"Sign in with Google"** (real Google OAuth) so users can connect with their Gmail account, in
   addition to the existing email + 4‑digit PIN auth.
3. Because the seeded admin (`admin@trip.app`) and **all ~25 backend tests** currently use `@trip.app`,
   the whole project (admin default + test fixtures/emails) migrates to `@gmail.com`.

This is a notably larger step than the original spec. It is grouped below into three workstreams. The
gmail-domain rule literally realizes the word "Domain" in the roadmap title; Google sign-in is the
"connect with the gmail account" the user asked for.

> ⚠️ **External prerequisite (user action, blocks OAuth end-to-end only):** Google OAuth requires
> OAuth 2.0 Client IDs from a Google Cloud project (Web + Android + iOS / Expo). I cannot create these.
> The code and the gmail-domain validation can be built and unit/HTTP-tested without them, but the live
> "Sign in with Google" button cannot be exercised until the client IDs are provided as env vars
> (`GOOGLE_CLIENT_ID` backend; `EXPO_PUBLIC_GOOGLE_*_CLIENT_ID` frontend).

## Decisions locked with the user
- "Connect with Gmail" = **both** gmail-domain validation **and** Google OAuth sign-in.
- Domain rule applies to **every** email input (register, login, forgot-PIN, member linked emails, and
  the email returned by Google).
- **Migrate** the seeded admin default and **all** test fixtures/emails to `@gmail.com` so `pytest`
  passes and the project is truly gmail-only.

---

## Workstream 1 — Member name & linked-email uniqueness (original spec)
Centralize the duplicate checks that are currently ad-hoc loops in `routes/members.py` and bypassed by
`routes/trips.py::join_trip`.

- **Create `backend/utils/members.py`**: `name_exists`, `email_exists`, `assert_unique_name`,
  `assert_unique_email` (case-insensitive, whitespace-normalized; cross-kind — an individual and a
  family may not share a name; `exclude_id` for self/merge exclusion). Email normalization is imported
  from `utils/email_rules.py` (Workstream 2) so there is one normalizer.
- **`backend/routes/members.py`**: replace inline dup-name loop (~L20-22) and dup-email loop (~L31-36)
  in `add_member`, and the self-excluding loops (~L73-75, ~L88-90) in `update_member`, with the helper
  calls. Honor the existing `merge_target` exclusion.
- **`backend/routes/trips.py::join_trip`**: in the auto-create-individual branch (`linked_family is
  None`), enforce name/email uniqueness; on a **name** collision, **disambiguate** the display name
  (e.g. `"<name> (<email-local-part>)"`, re-checked) instead of 400ing so a real user is never blocked
  from joining.

## Workstream 2 — Gmail-only domain enforcement (every email input)
Pydantic is **v2 (2.12.5)** and `email-validator==2.3.0` is already installed.

- **Create `backend/utils/email_rules.py`** — single source of truth:
  - `ALLOWED_EMAIL_DOMAIN = "gmail.com"`
  - `normalize_email(email) -> Optional[str]` (`lower().strip()`, `None` if blank)
  - `is_allowed_email(email) -> bool` (endswith `@gmail.com` after normalize)
  - `assert_gmail(email)` → `HTTPException(400, "Only @gmail.com email addresses are allowed")`
  - This module is pure/importable, so it is unit-testable in-process (important — see Verification).
- **Apply `assert_gmail` at every route entry** (keeps the codebase's `HTTPException(400, ...)` idiom and
  clean messages the frontend already surfaces), right after the existing `.lower().strip()`:
  - `routes/auth.py`: `register` (L21), `login` (L43), `forgot_pin` (L67).
  - `routes/members.py`: `add_member` and `update_member` (only when the linked email is non-empty —
    preserve "empty string clears the link").
  - (`create_trip`/`join_trip` derive email from an already-gmail user, so no extra check needed.)
- **Admin seed migration** — `backend/server.py` startup: change default `ADMIN_EMAIL` from
  `admin@trip.app` → `admin@gmail.com`; log a warning (do not crash) if a configured `ADMIN_EMAIL` is
  non-gmail. Update `backend/.env` accordingly (and the CLAUDE.md env note if it pins a value).
- **Frontend client-side validation** (UX; backend remains source of truth):
  - **Create `frontend/src/validation.ts`**: `isGmail(email)` + a shared error string, reusing the
    `colors.owing` token (the app has no dedicated `danger` color) and `T` `caption` variant for inline
    messages; must respect light/dark via `ThemeContext`.
  - Add inline gmail checks + error display before submit in: `(auth)/register.tsx`, `(auth)/login.tsx`,
    `(auth)/forgot.tsx`, `(auth)/pin-login.tsx`, `trip/[id]/add-member.tsx`, `trip/[id]/edit-member.tsx`.

## Workstream 3 — "Sign in with Google" (OAuth)
Flow: frontend obtains a Google **ID token** → backend **verifies** it → enforces `@gmail.com` →
find-or-create user → issues our own app JWT via existing `create_token(user_id, email)`.

**Backend**
- **New dep**: `google-auth` (+ `requests` if not already a runtime dep) in `backend/requirements.txt`.
- **`backend/config.py`**: add `GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")` (optionally a
  comma-list `GOOGLE_CLIENT_IDS` to accept web/iOS/Android audiences).
- **`backend/models/auth.py`**: add `GoogleAuthIn(BaseModel) { id_token: str }`.
- **`backend/routes/auth.py`**: new `POST /api/auth/google`:
  1. `google.oauth2.id_token.verify_oauth2_token(id_token, google.auth.transport.requests.Request(),
     GOOGLE_CLIENT_ID)`; on failure → `HTTPException(401, "Invalid Google token")`.
  2. Extract `email`/`name`; `assert_gmail(email)` (rejects Google Workspace/custom domains → 400).
  3. Find user by email; if absent, create with `auth_provider: "google"` and **placeholder**
     `password_hash`/`pin_hash` (random, like register's password fallback at L28) so the existing
     PIN/password login paths never KeyError.
  4. Return `{access_token, user}` shaped exactly like `login`/`register` (reuse `create_token`).
- Reuses the existing `users.email` unique index (find-or-create is consistent with it).

**Frontend**
- **New deps** (via `npx expo install`): `expo-auth-session`, `expo-web-browser`, `expo-crypto`.
- **`frontend/.env`**: `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` / `_IOS_CLIENT_ID` / `_ANDROID_CLIENT_ID`.
- **`frontend/src/AuthContext.tsx`**: add `signInWithGoogle(idToken)` → `POST /auth/google`, then the
  same `setToken` + `SAVED_EMAIL_KEY` + `setUser` sequence used by `signIn`/`register`.
- **`(auth)/register.tsx` & `(auth)/login.tsx`**: add a "Sign in with Google" button using
  `expo-auth-session/providers/google` `useIdTokenAuthRequest`; on success pass the `id_token` to
  `signInWithGoogle`. Show backend errors via the existing `Alert.alert` pattern.

## Workstream 4 — Test migration (required for green pytest)
- **`backend/tests/conftest.py`**: admin `admin@trip.app` → `admin@gmail.com`; `test_user`
  `test_{uuid}@trip.app` → `test_{uuid}@gmail.com`.
- Replace `@trip.app` → `@gmail.com` in `test_auth.py`, `test_trips.py`, `test_rbac.py` (the files that
  register users). `test_members/expenses/balances/meta` only use the fixture — no change.
- **New `backend/tests/test_member_uniqueness.py`** (original-spec coverage): duplicate individual name,
  duplicate family name, cross-kind name collision, duplicate linked email, update self-exclusion, join
  disambiguation.
- **New `backend/tests/test_email_domain.py`**: register/login/forgot with non-gmail → 400; gmail
  accepted; member add/update with non-gmail linked email → 400; empty linked email still clears.
- **Google OAuth tests** (the suite is black-box HTTP against a live server, so Google verification can't
  be monkeypatched in-process for the endpoint): (a) **unit-test** `is_allowed_email`/`assert_gmail`
  directly by importing `utils/email_rules.py`; (b) **HTTP-test** `POST /auth/google` with a bogus
  `id_token` → 401. Full happy-path Google login is verified manually once client IDs exist.

---

## New dependencies
- **Backend** (`requirements.txt`): `google-auth` (+ `requests` if missing). `email-validator` already
  present.
- **Frontend** (`package.json` via `npx expo install`): `expo-auth-session`, `expo-web-browser`,
  `expo-crypto`.

## Files to create
- `backend/utils/email_rules.py`
- `backend/utils/members.py`
- `backend/tests/test_member_uniqueness.py`
- `backend/tests/test_email_domain.py`
- `frontend/src/validation.ts`

## Files to change
- Backend: `models/auth.py`, `models/member.py`, `routes/auth.py`, `routes/members.py`,
  `routes/trips.py`, `config.py`, `server.py`, `requirements.txt`, `.env`.
- Backend tests: `tests/conftest.py`, `tests/test_auth.py`, `tests/test_trips.py`, `tests/test_rbac.py`.
- Frontend: `src/AuthContext.tsx`, `app/(auth)/register.tsx`, `app/(auth)/login.tsx`,
  `app/(auth)/forgot.tsx`, `app/(auth)/pin-login.tsx`, `app/trip/[id]/add-member.tsx`,
  `app/trip/[id]/edit-member.tsx`, `.env`, `package.json`.
- Docs: `CLAUDE.md` — flip Step 3 `[ ]`→`[x]` after green tests + commit; note the gmail rule and new
  `GOOGLE_*` env vars in the env section.

## Rules / constraints
- Members stay embedded in `trip.members[]`; keep `gen_id()` UUIDs and `{"_id": 0}` projections intact;
  no Mongo unique index across array elements (enforced application-side).
- One email normalizer (`utils/email_rules.py`) reused by member uniqueness — no duplicate logic.
- Don't weaken RBAC (member writes still gated by `_trip_or_404`; admin-only locks are Step 11).
- Frontend uses existing theme tokens (`colors.owing` for errors) and supports light/dark.
- Keep scope to this step; don't rename the stored `email` field or touch the split/settlement engine.

## Verification
Backend tests hit a **live server** (`conftest.BASE_URL` default `http://localhost:8000`), so:
1. `cd backend && uvicorn server:app --reload` (against a disposable test DB).
2. `pytest` (full suite green) and specifically `pytest tests/test_member_uniqueness.py
   tests/test_email_domain.py`.
3. Manual API checks: register/login/forgot with a non-gmail address → **400**; with `@gmail.com` → OK;
   add a member with a non-gmail linked email → **400**; `PATCH` member `email:""` still clears.
4. `POST /api/auth/google` with a garbage `id_token` → **401**.
5. **Google end-to-end (after client IDs configured)**: `cd frontend && yarn start`; tap "Sign in with
   Google", complete Google consent with a `@gmail.com` account → logged in; attempt with a non-gmail
   Google Workspace account → rejected with the gmail-only message.
6. `yarn lint` clean.

## Out of scope / flagged
- Creating the Google Cloud OAuth client (user-provided env vars; blocks only the live OAuth button).
- Migrating any pre-existing non-gmail production accounts (fresh/dev DB assumed; admin reseeds as
  gmail on an empty DB).
- Admin-only member mutation locks (Roadmap Step 11).
