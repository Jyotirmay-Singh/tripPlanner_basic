# Spec: New Joiner Choices  (Step 12)

## Overview
This step refactors the trip invitation/join pipeline (`POST /api/trips/join`) from an implicit,
auto-deciding route into an explicit **contextual join API**. Today the route accepts only `{code}`
and silently guesses what to do (link to a family if one carries the joiner's email, otherwise add a
standalone individual). Step 12 — "Complex Joining Context API" in the Roadmap (Phase 3) — makes the
joiner's intent a first-class, typed payload: the incoming profile can arrive as a **clean individual**,
**link into an existing family entity**, or **initialize a brand-new family group**. It also adds a
read-only **join preview** endpoint that surfaces the trip summary plus the available family link
targets, so the Step 13 frontend wizard has the data it needs to render its choice screen. The change is
backend-only and fully backward compatible: a payload with no `mode` preserves the current auto-link
behavior so the existing `join-trip.tsx` screen and tests keep working.

## Depends on
- **Step 2 (Trip RBAC Infrastructure)** — `admin_ids` / `_trip_admin_or_403` already exist; join must
  remain self-service (exempt from the admin lock) while every other member mutation stays admin-only.
- **Step 3 (Unique Family & Domain Mapping)** — `assert_unique_name` / `assert_unique_email` in
  `utils/members.py` must be honored when a joiner creates a new family or claims a member slot.
- **Step 11 (Member Administration Locks)** — establishes that member mutation endpoints are
  admin-gated; this step deliberately carves the join route out of that lock (code = authorization).

## Data Model Changes (MongoDB/Pydantic)
No MongoDB document schema changes. Member docs already carry every field used here
(`id`, `name`, `kind`, `family_members`, `email`, `user_id`), and trips already carry `user_ids` /
`admin_ids`. No new indexes.

New **request-only** Pydantic models (no persisted shape), in a new `backend/models/join.py`:

- `JoinRequest`
  - `code: str` (required; normalized to upper/trim server-side)
  - `mode: Optional[Literal["individual", "family", "new_family"]] = None`
    - `None` → legacy auto behavior (email auto-link, else individual) for backward compatibility.
  - `family_id: Optional[str] = None` — required when `mode == "family"`; the member `id` (UUID string)
    of the existing family entity to link into.
  - `family_name: Optional[str] = None` — required when `mode == "new_family"`; display name of the new
    family unit (normalized/validated like `MemberIn.name`).
  - `family_members: List[str] = []` — optional additional human names inside the new family
    (only honored when `mode == "new_family"`).
- `JoinPreviewRequest`
  - `code: str` (required)

All `id` values stay UUID strings; all reads use the `{"_id": 0}` projection.

## Backend API & Services (FastAPI)
All routes live on the existing `/api` router in `backend/routes/trips.py`. Auth via
`get_current_user`. **RBAC note:** join + preview are intentionally *not* gated by `_trip_admin_or_403`
— possession of the valid trip `code` is the authorization, and a joiner may only create/link **their
own** membership, never mutate other members.

### 1. `POST /api/trips/join` (refactor)
Body: `JoinRequest`. Resolve the trip by `code` (404 if not found). If `user["id"]` is already in
`trip["user_ids"]`, return the trip unchanged (idempotent), regardless of `mode`.

Branch on `mode`:
- **`None` (legacy):** unchanged current logic — if a family member has the joiner's email and an open
  `user_id` slot, link to it; otherwise push a new individual (with the existing duplicate-name
  disambiguation `Name (local-part)`).
- **`"individual"`:** push a new `kind="individual"` member for the joiner (name = `user["name"]` with
  the same duplicate-name disambiguation), `email = user email`, `user_id = user id`; add user to
  `user_ids`.
- **`"family"`:** require `family_id`; locate that member. Validate it exists and `kind == "family"`
  (else `400`/`404`). If its `user_id` slot is already claimed by another account → `400`
  ("This family is already linked to another account"). Otherwise set `members.$.user_id = user id`;
  if the family's `email` is empty, stamp the joiner's email **only after** `assert_unique_email`
  passes (on conflict, link without stamping). Add user to `user_ids`. Per CLAUDE.md "App User Identity
  Mapping", the joiner keeps their own App User ID for auth but is mathematically counted inside the
  family unit. Do **not** push a separate individual member (avoids double-counting).
- **`"new_family"`:** require `family_name`. Run `assert_unique_name` and (if email present)
  `assert_unique_email`. Push a new `kind="family"` member: `name = family_name`,
  `family_members = body.family_members`, `email = user email`, `user_id = user id`; add user to
  `user_ids`.

Return the refreshed trip doc (`{"_id": 0}` projection), matching today's return shape.

Reallocation note: joining only affects **future** expenses; it must NOT trigger the Step 8
`run_member_update_with_reallocation` routine (the joiner had no prior ledger entries).

### 2. `POST /api/trips/join/preview` (new)
Body: `JoinPreviewRequest`. Resolve trip by `code` (404 if not found). Returns a read-only context
object for the join wizard:
```json
{
  "trip": { "id", "name", "code", "travel_date", "currency", "member_count" },
  "already_member": true,
  "matched_family": { "id", "name" } ,
  "families": [ { "id", "name", "size", "linked": false } ]
}
```
- `already_member`: whether `user["id"]` is in `trip["user_ids"]`.
- `matched_family`: the family whose `email` equals the joiner's email and whose `user_id` slot is open
  (the recommended link target), else `null`.
- `families`: every `kind == "family"` member, with `size` = `len(family_members)` and `linked` =
  whether the slot is already claimed (used to disable already-taken families in the picker).

No `services/` changes. (The greedy settlement and per-capita/per-family math in
`services/calculator.py` are untouched by this step.)

## App Screens & UI (Expo React Native)
No app screen changes in this step. The interactive Join Wizard UI that consumes the new `mode` payload
and the `/join/preview` endpoint is **Step 13** and is intentionally out of scope here. The existing
`frontend/app/join-trip.tsx` continues to work because a `mode`-less payload hits the legacy branch.

## State & API Integration
No required changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`. The
existing `api('/trips/join', { method: 'POST', body: { code } })` call remains valid against the
refactored route (legacy branch). Any typed `JoinRequest` / preview helpers are deferred to Step 13.

## Files to change
- `backend/routes/trips.py` — refactor `join_trip` to accept `JoinRequest` and branch on `mode`; add the
  `POST /api/trips/join/preview` route.
- `CLAUDE.md` — flip Step 12 from `[ ]` to `[x]` once complete, tested, and committed.

## Files to create
- `backend/models/join.py` — `JoinRequest`, `JoinPreviewRequest` Pydantic models.
- `backend/tests/test_join.py` — integration tests for the new join modes and preview endpoint.

## New Dependencies
No new dependencies.

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) in Section 5 of `CLAUDE.md`:
  a `"family"` link or `"new_family"` create changes head/entity counts for **future** expenses only and
  must never silently re-weight past expenses (that is the admin-driven Step 8 flow).
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact; do not introduce
  Mongo ObjectIds.
- Enforce RBAC correctly: join/preview are self-service (trip code is the authorization) and a joiner may
  only create or link **their own** membership; every other member mutation endpoint stays behind
  `_trip_admin_or_403`. Do not loosen the Step 11 locks.
- Honor Step 3 uniqueness: `assert_unique_name` for `new_family`, `assert_unique_email` before stamping
  any email. All emails must pass `assert_gmail` (Gmail-only identity).
- Keep full backward compatibility: a payload without `mode` must behave exactly as the current route
  (so existing `test_trips.py::test_join_trip_with_code` / `test_join_trip_invalid_code` still pass).
- Follow frontend design system tokens and dynamic light/dark via `ThemeContext` for any future UI
  (N/A this step — no UI work here).
- Keep changes strictly scoped to Step 12; do not refactor unrelated routes, the calculator, or the
  member admin endpoints.

## Definition of Done
- [ ] `backend/models/join.py` defines `JoinRequest` (with `mode`, `family_id`, `family_name`,
      `family_members`) and `JoinPreviewRequest`, with name normalization matching `MemberIn`.
- [ ] `POST /api/trips/join` accepts the typed payload and correctly handles all four paths
      (legacy/`None`, `individual`, `family`, `new_family`), returning the refreshed trip doc.
- [ ] `POST /api/trips/join/preview` returns the trip summary, `already_member`, `matched_family`, and
      the `families` link-candidate list; returns `404` for an unknown code.
- [ ] Linking into an already-claimed family returns `400`; creating a `new_family` with a duplicate
      name returns `400`; an invalid code returns `404` on both routes.
- [ ] Joining is idempotent: a user already in `user_ids` gets the trip back unchanged for any `mode`.
- [ ] Joining never triggers `run_member_update_with_reallocation` (past expenses untouched).
- [ ] New `backend/tests/test_join.py` covers: individual join, new_family join (with members + user
      link), family link (slot open), family link conflict (`400`), new_family duplicate name (`400`),
      invalid code (`404`), idempotent re-join, legacy no-`mode` backward compat, and preview
      (matched_family + families + `404`).
- [ ] `cd backend && pytest` passes (full suite green, including the existing `test_trips.py` join tests
      that send a `mode`-less payload).
- [ ] `CLAUDE.md` Roadmap Step 12 is flipped to `[x]` in the same commit that completes the work.
