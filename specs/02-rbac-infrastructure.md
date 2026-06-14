# Spec: Trip RBAC Infrastructure  (Step 02)

## Overview
This step lays the **Role-Based Access Control foundation** for trips, matching Roadmap
Phase 1 → Step 2 in `CLAUDE.md`. Today a trip document only distinguishes the `owner_id`
(used solely to gate trip deletion) from the flat `user_ids` membership array — there is no
concept of a *trip administrator*. This step introduces an explicit `admin_ids` string array
on every trip, guarantees the creating user is seeded as the **root admin** (and can never be
demoted), backfills the field onto pre-existing trips, and ships a reusable admin-check
dependency plus the minimal admin-management endpoints needed to grow/shrink the admin set.
It deliberately does **not** wire enforcement into expense or member mutation routes — those
are Steps 10 and 11 — so the infrastructure here is purely the schema, the seeding rule, the
helper dependency, and the promote/demote API.

## Depends on
- **Step 1 — Modularize Backend** (`- [x]` complete). The spec relies on the modular layout
  (`models/`, `routes/`, `utils/deps.py`) produced by that refactor.

## Data Model Changes (MongoDB/Pydantic)
Trip documents are UUID-keyed (`id`), stored in `db.trips`, queried with `{"_id": 0}` projections.

**Trip document — new field**
- `admin_ids: List[str]` — app-user UUIDs who hold admin rights on the trip.
  - On create: initialized to `[owner_id]` (the creator is the root admin).
  - The **root admin** is the existing `owner_id`. There is no new `root_admin_id` field; the
    invariant is simply `owner_id ∈ admin_ids` at all times and `owner_id` cannot be demoted.
  - Every admin is, by definition, also in `user_ids` (cannot be admin without membership).

**Pydantic models (`backend/models/trip.py`)**
- Add `AdminGrant(BaseModel)` with `user_id: str` — request body for promoting a member.
- No change to `TripIn` / `TripUpdate` (admins are managed via dedicated endpoints, not free-form
  trip PATCH, to avoid privilege escalation through the generic update route).

**Backfill / migration**
- On startup (`server.py`), backfill any trip missing `admin_ids` (or with an empty array) by
  setting `admin_ids = [owner_id]`. Idempotent — uses a filtered `update_many`.

**Indexes**
- No new indexes required (`admin_ids` membership checks are in-memory on an already-fetched trip
  doc; no query filters on `admin_ids`).

## Backend API & Services (FastAPI)

**New dependency helpers (`backend/utils/deps.py`)**
- `is_trip_admin(trip: dict, user_id: str) -> bool` — pure predicate:
  `user_id in trip.get("admin_ids", [])`. (Robust to legacy docs via `.get` default.)
- `async def _trip_admin_or_403(trip_id: str, user_id: str) -> dict` — fetches the trip via the
  same path as `_trip_or_404`, enforces membership, then raises `HTTPException(403, "Admin
  privileges required")` if the user is not in `admin_ids`. Returns the trip doc. This is the
  reusable guard that Steps 10/11 will consume; it is created here but **not yet attached** to
  expense/member routes.

**Changed route (`backend/routes/trips.py`)**
- `POST /api/trips` (`create_trip`) — add `"admin_ids": [user["id"]]` to the inserted document.
  Response now includes `admin_ids`.

**New routes (`backend/routes/trips.py`)** — all require an existing trip admin (`_trip_admin_or_403`):
- `GET  /api/trips/{trip_id}/admins`
  - RBAC: any trip member (`_trip_or_404`).
  - Returns `{ "owner_id": str, "admin_ids": [str], "admins": [ {id, name, email, user_id} ] }`
    where `admins` is resolved from the trip's `members` array by matching `user_id`.
- `POST /api/trips/{trip_id}/admins`  body `AdminGrant`
  - RBAC: trip admin only (`_trip_admin_or_403`).
  - Validates the target `user_id` is in `trip.user_ids` (must be a member first) → else
    `400 "User is not a member of this trip"`.
  - Adds to `admin_ids` via `$addToSet` (idempotent). Returns the updated admin payload.
- `DELETE /api/trips/{trip_id}/admins/{user_id}`
  - RBAC: trip admin only (`_trip_admin_or_403`).
  - Rejects demoting the root admin: if `user_id == trip.owner_id` → `400 "Cannot remove the
    root admin"`.
  - `$pull` from `admin_ids`. Returns the updated admin payload.

No changes to the splitting/balances engine in this step.

## App Screens & UI (Expo React Native)
- **Create:** none.
- **Modify:** none required. This is a Phase-1 backend-infrastructure step; the admin
  management UI is Roadmap **Step 14 (Administrative Controls Member Tab)**. Trip GET responses
  will simply carry a new `admin_ids` array that future frontend steps consume.

## State & API Integration
- Optional (non-blocking) typing touch-up: extend the `Trip` shape in `frontend/src/api.ts`
  (or wherever the trip type is declared) to include `admin_ids: string[]` so future steps have
  the field typed. No behavioral change, no new calls. If the codebase has no explicit Trip TS
  interface, state so and skip — do not invent one.

## Files to change
- `backend/models/trip.py` — add `AdminGrant` model.
- `backend/utils/deps.py` — add `is_trip_admin` + `_trip_admin_or_403`.
- `backend/routes/trips.py` — set `admin_ids` on create; add 3 admin routes.
- `backend/server.py` — startup backfill of `admin_ids` for legacy trips.
- `CLAUDE.md` — flip Roadmap Step 2 checkbox `[ ]` → `[x]` once implemented, tested, committed.
- `backend/tests/test_trips.py` — extend with create assertion (`admin_ids == [owner_id]`)
  *(or add the new test file below)*.

## Files to create
- `backend/tests/test_rbac.py` — integration tests for the admin-management endpoints and the
  root-admin invariant (see Definition of Done).
- `plan/02-rbac-infrastructure.md` — this spec.

## New Dependencies
No new dependencies.

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5 of
  `CLAUDE.md` — untouched here; do not alter balance math.
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact; `admin_ids`
  holds app-user UUID strings, never Mongo ObjectIds.
- Enforce RBAC on the backend: admin-mutating routes must call `_trip_admin_or_403` before any
  write. The root admin (`owner_id`) must always remain in `admin_ids` and must be undemotable.
- A user must be a trip member (`user_ids`) before being promoted to admin.
- Follow the frontend design system tokens and dynamic light/dark mode via `ThemeContext` — N/A
  this step (no UI), but do not regress existing screens.
- Keep changes strictly scoped to Step 2. Do **not** attach the new admin guard to expense or
  member routes (Steps 10/11), and do not implement admin UI (Step 14).
- Keep the new admin routes registered on the existing `/api`-prefixed router; do not add a new
  router module.

## Definition of Done
- [ ] `POST /api/trips` returns a trip whose `admin_ids == [owner_id]`, and `owner_id` is the
      creating user's id.
- [ ] Startup backfill sets `admin_ids = [owner_id]` on any legacy trip lacking it (verifiable by
      inserting a trip doc without the field, restarting, and re-fetching).
- [ ] `GET /api/trips/{id}/admins` returns the owner plus resolved admin member records for any
      member; returns `403` for a non-member.
- [ ] `POST /api/trips/{id}/admins` promotes an existing member (admin caller) → target appears in
      `admin_ids`; promoting a non-member returns `400`; a non-admin caller returns `403`.
- [ ] `DELETE /api/trips/{id}/admins/{user_id}` demotes a non-root admin; attempting to demote the
      `owner_id` returns `400 "Cannot remove the root admin"`; a non-admin caller returns `403`.
- [ ] `is_trip_admin` / `_trip_admin_or_403` exist in `utils/deps.py` and are unit-exercised via
      the route tests; they are NOT yet referenced by expense/member routes.
- [ ] `cd backend && pytest` passes fully, including the new `tests/test_rbac.py` coverage for the
      promote/demote flows and the root-admin invariant.
- [ ] CLAUDE.md Roadmap Step 2 checkbox flipped to `[x]` in the same commit as the passing code.
