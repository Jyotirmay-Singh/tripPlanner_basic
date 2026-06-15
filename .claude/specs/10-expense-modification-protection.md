# Spec: Expense Modification Protection  (Step 10)

## Overview
This step delivers **Phase 3, Step 10 — "Expense Modification Protection"** from the `CLAUDE.md`
Roadmap: tighten the expense **edit** (`PATCH`) and **delete** (`DELETE`) endpoints in
`backend/routes/expenses.py` so a request can only mutate an expense when the requesting user is
**either the record's creator** (`expense.created_by == user.id`) **or a designated Trip Admin**
(`user.id in trip.admin_ids`). Today both endpoints are gated only by trip **membership**
(`_trip_or_404`), which means any member of a trip can silently rewrite or destroy any other member's
expense — and because `update_one`/`delete_one` are issued without first loading the document, edits
to a non-existent expense return `200` with no effect instead of a `404`. This step introduces a
small, reusable authorization layer (built on the existing `is_trip_admin` helper from Step 2) that
loads the target expense, returns `404` when it is missing, and returns `403` when the caller is
neither its creator nor a trip admin — before any write occurs. It is the backend half of the RBAC
pairing whose frontend counterpart (hiding the edit/delete controls) is Step 17; this step makes the
server authoritative regardless of what the client renders.

## Depends on
- **Step 1 — Modularize Backend** (done): routes live in `backend/routes/expenses.py`; shared auth
  helpers live in `backend/utils/deps.py`. This step extends `deps.py` and `expenses.py` only.
- **Step 2 — Trip RBAC Infrastructure** (done): every trip carries `owner_id` and an `admin_ids`
  string array seeded with the owner as root admin, and `backend/utils/deps.py` already exposes
  `is_trip_admin(trip, user_id)` and `_trip_admin_or_403`. This step reuses `is_trip_admin` as the
  "admin" branch of the creator-or-admin check.
- **Expense `created_by` provenance** (already present): `add_expense` stamps every expense document
  with `created_by: user["id"]` (`backend/routes/expenses.py`). This step reads that field as the
  "creator" branch of the check.
- This step does **not** depend on Steps 11–20 (member-admin locks, join pipeline, or any frontend
  work). It is intentionally backend-only.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. No new collections, fields, or indexes. The authorization check reads only
fields that already exist: `created_by` on the Expense document and `admin_ids` on the Trip document.
All reads keep `{"_id": 0}` projections and documents keep UUID string `id`s (no ObjectIds).

Note on legacy data: expenses created before `created_by` was stamped may lack the field (value
`None`). For such records the creator branch is never satisfied, so **only a trip admin** can modify
them — the safe default. No backfill is performed in this step.

## Backend API & Services (FastAPI)

### New helpers — `backend/utils/deps.py`
Add a thin, reusable authorization layer next to the existing `_trip_or_404` / `is_trip_admin` /
`_trip_admin_or_403` helpers (no new module — these belong with the other trip/dep guards):

1. `async def _expense_or_404(trip_id: str, expense_id: str) -> dict`
   - `expense = await db.expenses.find_one({"id": expense_id, "trip_id": trip_id}, {"_id": 0})`
   - raise `HTTPException(404, "Expense not found")` when missing; otherwise return the expense dict.
   - Scoping the query by `trip_id` keeps an expense from one trip from being addressed via another
     trip's path.

2. `def can_modify_expense(trip: dict, expense: dict, user_id: str) -> bool`
   - pure predicate: `return expense.get("created_by") == user_id or is_trip_admin(trip, user_id)`.
   - kept pure (no `await`, no DB) so it is unit-testable in isolation and reusable by Step 17's
     parallel frontend logic if mirrored.

3. `async def _expense_modify_or_403(trip_id: str, expense_id: str, user_id: str) -> tuple[dict, dict]`
   - orchestrator used by both routes: `trip = await _trip_or_404(trip_id, user_id)` (enforces
     membership / 403 for non-members, 404 for missing trip) → `expense = await
     _expense_or_404(trip_id, expense_id)` → if `not can_modify_expense(trip, expense, user_id)` raise
     `HTTPException(403, "Only the expense creator or a trip admin can modify this expense")` →
     return `(trip, expense)`.
   - returning both lets the route reuse the already-loaded `trip` (e.g. for member validation on
     `PATCH`) without a second DB round-trip.

### Changed routes — `backend/routes/expenses.py`
- **`PATCH /trips/{trip_id}/expenses/{expense_id}` (`update_expense`)**: replace the bare
  `await _trip_or_404(...)` with `trip, expense = await _expense_modify_or_403(trip_id, expense_id,
  user["id"])`. The permission/existence check now runs **before** any `update_one`. The existing
  "no-op when no updates" early return must keep returning the already-loaded `expense` (it now exists
  for certain). Behaviour for an authorized caller is otherwise unchanged.
- **`DELETE /trips/{trip_id}/expenses/{expense_id}` (`delete_expense`)**: replace the bare
  `await _trip_or_404(...)` with `await _expense_modify_or_403(trip_id, expense_id, user["id"])`
  before the `delete_one`. A missing expense now returns `404` (previously a silent `200`), and an
  unauthorized caller returns `403` and the document is **not** deleted.
- **`POST /trips/{trip_id}/expenses` (`add_expense`)**: unchanged. Any trip member may still create
  expenses; creation is not a "modification" of an existing record. `created_by` continues to be
  stamped exactly as today (it is what this step's creator-branch relies on).
- **`GET /trips/{trip_id}/expenses` (`list_expenses`)**: unchanged. Reads stay membership-gated.

### Routes & RBAC summary
- No new routes and no request/response **shape** changes for authorized callers. The only
  externally observable additions are the new `403` (non-creator non-admin) and `404` (missing
  expense) responses on the edit/delete paths.
- RBAC rule for `PATCH`/`DELETE` on an expense: **creator OR trip admin** (the trip owner is always a
  root admin via Step 2, so the owner can always edit/delete). This is deliberately looser than the
  admin-only lock used for member mutations (`_trip_admin_or_403`) — per the Roadmap wording, the
  creator retains control of their own expense.

## App Screens & UI (Expo React Native)
- **Create:** None.
- **Modify:** None in this step. Conditionally hiding the edit/delete buttons based on
  creator/admin identity is **Step 17 (RBAC-Driven Component Hiding)** and is explicitly out of
  scope here. This step only makes the server reject unauthorized mutations; the existing edit/delete
  screens continue to call the same endpoints and will simply surface the normalized `403` error
  message if a non-owner non-admin attempts a mutation.

## State & API Integration
No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`. `api.ts`
already normalizes FastAPI error bodies, so a `403`/`404` from these endpoints already propagates to
the caller as a readable error without modification. Surfacing it proactively in the UI is Step 17.

## Files to change
- `backend/utils/deps.py` — add `_expense_or_404`, `can_modify_expense`, and
  `_expense_modify_or_403` alongside the existing trip helpers.
- `backend/routes/expenses.py` — route `update_expense` and `delete_expense` through
  `_expense_modify_or_403`; remove their bare `_trip_or_404` calls (now performed inside the
  orchestrator).
- `CLAUDE.md` — after the work is tested and committed, flip Roadmap **Step 10** from `- [ ]` to
  `- [x]`.

## Files to create
- `backend/tests/test_expense_rbac.py` — integration tests (mirroring `test_expenses.py` /
  `test_rbac.py` style: `requests` against `BASE_URL`, using the `api_client` and `test_user`
  fixtures from `conftest.py`, second users registered ad hoc and joined via trip code) covering the
  creator-or-admin matrix.
- `.claude/specs/10-expense-modification-protection.md` — this spec document.

## New Dependencies
No new dependencies. No new Python packages and no frontend packages.

## Rules for Implementation
- Enforce RBAC on the backend **before** executing the destructive edit/delete: the permission and
  existence checks must run prior to any `update_one`/`delete_one`. Never mutate then check.
- The modify rule is **creator OR trip admin** (`expense.created_by == user.id or is_trip_admin(trip,
  user.id)`). Reuse the existing `is_trip_admin` helper from Step 2 — do not re-implement admin
  detection or read `admin_ids` directly in the route.
- Missing expense → `404`; member-but-not-creator-and-not-admin → `403`; non-member of the trip →
  `403` (preserved by `_trip_or_404`); missing trip → `404`. Keep these status codes exact.
- Scope the expense lookup by `trip_id` (`{"id": expense_id, "trip_id": trip_id}`) so an expense
  cannot be reached through the wrong trip's URL.
- Do not change `add_expense` or `list_expenses` access (any trip member may create/list). Creating
  an expense is not a protected modification.
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) must remain intact; no
  ObjectIds are introduced.
- Respect the strict dual split-mode logic (`PER_CAPITA` | `PER_FAMILY`) from Section 5 of
  `CLAUDE.md`: this step touches only access control and must not alter how an authorized edit stores
  `split_mode`, `split_member_ids`, `weight_snapshots`, or any calculation.
- Treat a legacy expense with no `created_by` as modifiable only by an admin (safe default); do not
  backfill or guess a creator.
- Keep changes strictly scoped to this step: do not touch the calculator, balances, reallocation,
  reports, member, or auth code, and do not refactor the unrelated parts of `expenses.py` or
  `deps.py`.

## Definition of Done
- [ ] `backend/utils/deps.py` exposes `_expense_or_404`, `can_modify_expense`, and
      `_expense_modify_or_403`; `update_expense` and `delete_expense` in `backend/routes/expenses.py`
      call `_expense_modify_or_403` and no longer call `_trip_or_404` directly.
- [ ] **Creator can edit/delete:** the user who created an expense can `PATCH` and `DELETE` it
      (`200`), unchanged from today.
- [ ] **Admin can edit/delete:** a trip admin (including the owner / root admin) who did **not**
      create an expense can `PATCH` and `DELETE` it (`200`).
- [ ] **Non-creator non-admin is blocked:** a plain trip member who is neither the creator nor an
      admin receives `403` on `PATCH` and on `DELETE`, and the expense is **unchanged / still
      present** afterward (verified by a follow-up `GET /trips/{id}/expenses`).
- [ ] **Non-member is blocked:** a user who is not in the trip's `user_ids` receives `403` (or `404`
      for a non-existent trip) and no mutation occurs.
- [ ] **Missing expense returns 404:** `PATCH`/`DELETE` against an unknown `expense_id` returns
      `404` (previously a silent `200`).
- [ ] New `backend/tests/test_expense_rbac.py` covers, at minimum: creator-edit-ok,
      creator-delete-ok, admin-(non-creator)-edit-ok, admin-(non-creator)-delete-ok,
      member-(non-creator non-admin)-edit-403, member-delete-403 (+ assert the expense survives),
      and missing-expense-404. Uses the `api_client`/`test_user` fixtures and registers/joins a
      second member via the trip `code` (mirroring `test_rbac.py`).
- [ ] No regression: `test_expenses.py`, `test_rbac.py`, `test_members.py`, `test_split_mode.py`,
      `test_per_capita.py`, `test_per_family.py`, `test_calculator.py`, `test_reallocation.py`,
      `test_balances_reports.py`, and `test_report_builder.py` still pass.
- [ ] `cd backend && pytest` is green across the whole suite (including the new test file).
- [ ] `CLAUDE.md` Roadmap **Step 10** checkbox flipped to `- [x]` in the implementation commit.
