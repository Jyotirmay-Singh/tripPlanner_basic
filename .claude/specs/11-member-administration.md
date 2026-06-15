# Spec: Member Administration Locks  (Step 11)

## Overview
This feature locks down member and family **mutation** endpoints so that only
authenticated **Trip Admins** can add, edit, or delete members/families within a
trip. It is the natural follow-on to Step 10 (Expense Modification Protection):
Step 10 gated expense edits/deletes to the creator-or-admin; Step 11 extends the
same Role-Based Access Control (RBAC) posture to the member roster, which is more
sensitive because changing a family's size retroactively re-allocates every past
`PER_CAPITA` expense (Step 8). Without this lock, any plain trip member could
rewrite the cost-allocation basis for everyone. This corresponds to **Phase 3,
Step 11** of the Implementation Roadmap in `CLAUDE.md`.

## Depends on
- **Step 1** — Modularized backend (`routes/`, `utils/`, `services/`).
- **Step 2** — Trip RBAC infrastructure (`admin_ids`, owner seeded as root admin,
  `is_trip_admin`, `_trip_admin_or_403` in `utils/deps.py`).
- **Step 3** — Unique family/email validation (`utils/members.py`), preserved.
- **Step 8** — Retroactive re-allocation routine (`services/reallocation.py`),
  invoked from `update_member`; remains intact behind the new lock.
- **Step 10** — Expense Modification Protection (establishes the RBAC test +
  dependency pattern this step mirrors).

## Data Model Changes (MongoDB/Pydantic)
No data model changes. The `admin_ids` array and `owner_id` already exist on the
trip document (Step 2) and `members[]` already carry `id`/`user_id` UUID strings.
This step only changes **who** may call the existing mutation routes.

## Backend API & Services (FastAPI)
All routes live in `backend/routes/members.py`. The change is to replace the
membership-only guard `_trip_or_404(trip_id, user["id"])` with the admin guard
`_trip_admin_or_403(trip_id, user["id"])` (already defined in `utils/deps.py`) on
the three **mutation** endpoints:

| Method | Route | Current guard | New guard | Behavior |
|--------|-------|---------------|-----------|----------|
| `POST` | `/api/trips/{trip_id}/members` | `_trip_or_404` (member) | `_trip_admin_or_403` (admin) | Non-admin member → `403`; non-member → `403`; missing trip → `404` |
| `PATCH` | `/api/trips/{trip_id}/members/{member_id}` | `_trip_or_404` | `_trip_admin_or_403` | Same; member-not-found still → `404` *after* the admin check passes |
| `DELETE` | `/api/trips/{trip_id}/members/{member_id}` | `_trip_or_404` | `_trip_admin_or_403` | Same; "has expenses" `400` still applies after admin check |

- **Unchanged (intentionally NOT locked):**
  - `POST /api/trips/join` (`routes/trips.py`) — self-service join pushes a member
    for the *joining* user, who can never be an admin yet. Locking it would make
    joining impossible. The richer join payload handling belongs to **Step 12**;
    do not touch it here.
  - Any `GET`/read routes — viewing the roster stays open to all trip members.
- **Error contract:** `_trip_admin_or_403` raises `403 "Admin privileges required"`
  for a non-admin member and reuses `_trip_or_404` semantics underneath (`404`
  trip-not-found, `403` not-a-member). Keep these status codes exact for tests.
- **Ordering guarantee:** the admin check must run **before** any "member not
  found" (`404`) or "member has expenses" (`400`) logic, so an unauthorized caller
  never learns roster details (no information leak).

## App Screens & UI (Expo React Native)
No screen creation in this step. The full admin-aware Members roster UI (badges,
admin-only modals) is **Step 14** (Phase 4) and the RBAC-driven component hiding
is **Step 17** (Phase 5); both are out of scope here.

- **Create:** none.
- **Modify:** none required for Definition of Done. (Optional, only if trivially
  in-scope: ensure existing add/edit/delete member screens already surface backend
  `403` errors via the normalized error path in `frontend/src/api.ts`. Do **not**
  build new gating UI — that is Step 17.)

## State & API Integration
No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or
`AsyncStorage`. The existing thin fetch wrapper already normalizes FastAPI error
bodies, so a `403` from a locked endpoint propagates to the caller unchanged.

## Files to change
- `backend/routes/members.py` — swap `_trip_or_404` → `_trip_admin_or_403` in
  `add_member`, `update_member`, `delete_member`; update the import on line 6 to
  pull in `_trip_admin_or_403`.
- `CLAUDE.md` — flip `- [ ] Step 11` to `- [x] Step 11` upon completion (per the
  AGENT DIRECTIVE in Section 6).

## Files to create
- `backend/tests/test_member_rbac.py` — integration tests proving admin-only
  access to member mutation endpoints (mirrors `tests/test_expense_rbac.py`).

## New Dependencies
No new dependencies. Reuses existing FastAPI, Motor, pytest, and `requests`.

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined
  in Section 5 of `CLAUDE.md`. The reallocation triggered by `update_member`
  (Step 8) must continue to work unchanged once the lock passes.
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain
  intact — do not alter how members/trips are read or written, only the guard.
- Enforce RBAC on the backend **before** executing destructive edits/deletes; the
  admin check must precede `404`/`400` member-state checks.
- Reuse the existing `_trip_admin_or_403` dependency — do **not** write a new
  permission helper or duplicate the admin logic.
- Do **not** lock `POST /trips/join` or any read endpoint; joining and viewing
  remain open to non-admins.
- Follow the frontend design system tokens and dynamic light/dark mode via
  `ThemeContext` if any UI error-surfacing tweak is made (none expected).
- Keep changes strictly scoped to this step; do not refactor unrelated code,
  member-merge logic, or the reallocation service internals.

## Definition of Done
A specific, testable checklist:

- [ ] `add_member`, `update_member`, and `delete_member` in
  `backend/routes/members.py` use `_trip_admin_or_403`; the import is updated.
- [ ] Trip **owner/root admin** can still add a member (`POST` → `200`).
- [ ] Trip **owner/admin** can edit a member (`PATCH` → `200`) and delete a member
  with no expenses (`DELETE` → `200`).
- [ ] A **promoted admin** (added via `POST /trips/{id}/admins`) can add/edit/
  delete members (`200`).
- [ ] A **non-admin trip member** is blocked from add/edit/delete (`403`), and the
  roster is verifiably unchanged after the rejected call.
- [ ] A **non-member** (never joined) is blocked from all three (`403`).
- [ ] Admin check precedes resource checks: a non-admin targeting a **missing
  member id** still gets `403` (not `404`); an admin targeting a missing member id
  gets `404`.
- [ ] Self-service `POST /trips/join` still works for a non-admin user (`200`) —
  i.e., joining was not accidentally locked (regression guard).
- [ ] New tests added in `backend/tests/test_member_rbac.py` covering every bullet
  above.
- [ ] `cd backend && pytest` passes the full suite (new `test_member_rbac.py` plus
  all existing tests — confirm no regression in `test_members.py`,
  `test_member_uniqueness.py`, `test_reallocation_api.py`, `test_rbac.py`).
- [ ] `CLAUDE.md` Step 11 checkbox flipped to `[x]` and the work committed on
  `feature/member-administration`.
