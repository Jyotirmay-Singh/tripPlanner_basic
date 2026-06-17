# Spec: RBAC-Driven Component Hiding  (Step 17)

## Overview
This step delivers **Phase 5, Step 17 — "RBAC-Driven Component Hiding"** from the `CLAUDE.md`
Roadmap: condition the visibility of the **transaction update (edit) and delete** controls in the
Expo app on the current user's role, so a member only sees those controls for an expense they are
allowed to mutate — namely an expense **they created** (`expense.created_by == user.id`) **or any
expense if they are a trip admin** (`user.id in trip.admin_ids`, which always includes the owner via
Step 2). Today the backend already rejects unauthorized edits/deletes with `403`
(`_expense_modify_or_403`, Step 10), but the frontend still renders the inline trash button on every
expense row and the **Save changes / Delete transaction** buttons on the edit screen for everyone —
so a non-creator non-admin can tap a control only to hit a server error. This step closes that
UX gap by mirroring the server's `can_modify_expense` predicate on the client and hiding (not just
disabling) the update/delete affordances when the rule is not satisfied. It is the frontend
counterpart to the backend protection landed in Step 10; the server remains the sole authority.

## Depends on
- **Step 2 — Trip RBAC Infrastructure** (done): every trip carries `owner_id` and an `admin_ids`
  string array (owner seeded as root admin). `GET /api/trips/{id}` already returns both, and the trip
  detail screen already reads `trip.admin_ids` to compute `meIsAdmin`/`isOwner`.
- **Step 10 — Expense Modification Protection** (done): the authoritative `creator OR trip admin`
  rule lives server-side in `can_modify_expense` / `_expense_modify_or_403`. This step's client
  predicate must mirror that rule exactly (including the legacy-row behaviour where a missing
  `created_by` falls through to admin-only).
- **Step 16 — Dual Split Mode Selector** (done): established the current shape of `add-expense.tsx`
  and `edit-expense.tsx` that this step modifies.
- **`created_by` provenance** (already present): `add_expense` stamps every expense with
  `created_by: user["id"]`, and `GET /api/trips/{id}/expenses` returns it (projection strips only
  `_id`). The client already receives this field — it is simply unused today.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. No new collections, fields, or indexes. The client reads only fields that
already exist on the wire: `created_by` on each expense, and `owner_id` / `admin_ids` on the trip.
All documents keep UUID string `id`s; all backend reads keep their `{"_id": 0}` projections. No
backfill of legacy `created_by`.

## Backend API & Services (FastAPI)
No backend changes. The endpoints already expose everything the client needs and already enforce
RBAC authoritatively:
- `GET /api/trips/{trip_id}` — returns `owner_id` and `admin_ids`.
- `GET /api/trips/{trip_id}/expenses` — returns `created_by` on every row.
- `PATCH` / `DELETE /api/trips/{trip_id}/expenses/{expense_id}` — already gated by
  `_expense_modify_or_403` (creator-or-admin → `200`; otherwise `403`; missing → `404`).

The only required backend action is **regression verification** (run `pytest`) to confirm the
contracts this UI relies on — `created_by` in the list response and the `403`/`404` matrix on
edit/delete — still hold. The existing `backend/tests/test_expense_rbac.py` already covers the
server-side matrix; do not weaken it.

## App Screens & UI (Expo React Native)
- **Create:** None (a tiny shared predicate module is added under `frontend/src/` — see *Files to
  create*; it is not a screen).
- **Modify:**
  - `frontend/app/trip/[id]/index.tsx` (Expenses tab):
    - Add `created_by?: string | null` to the local `Expense` type.
    - Derive a per-row predicate `canModify(e) = canModifyExpense(e, user?.id, trip)` reusing the
      already-computed `meIsAdmin` semantics (creator OR admin).
    - **Hide** the inline delete trash (`expense-del-${e.id}`) on rows the user may not modify. The
      row itself stays tappable so anyone can open the transaction (the edit screen governs whether
      it is editable).
  - `frontend/app/trip/[id]/edit-expense.tsx`:
    - Extend the local `Trip` type to include `owner_id: string` and `admin_ids: string[]`, and the
      local `Expense` type to include `created_by?: string | null`.
    - Read the current user via `useAuth()` and store the loaded expense's `created_by` (e.g. in a
      `createdBy` state set during fetch).
    - Compute `canModify` once the trip + expense are loaded. When **false** (decision: *hide
      buttons only* — inputs stay interactive, since with no Save button there is no save path):
      - **Hide** the `ee-save` (Save changes) and `ee-delete` (Delete transaction) buttons.
      - Show a theme-aware caption, `testID="expense-readonly-note"`, reading e.g. *"Only the
        person who added this transaction or a trip admin can edit it."*
      - The form inputs/selectors are **not** disabled in this step; gating the two action buttons
        removes the only mutation path. (Full `editable={false}`/`pointerEvents` lock-down was
        considered and deliberately deferred.)
    - When `canModify` is **true**, behaviour is exactly as today.

## State & API Integration
- No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`.
- The trip detail screen already calls `useAuth()` and loads the trip (with `admin_ids`) and the
  expense list (with `created_by`); no new requests are introduced there.
- The edit-expense screen gains a `useAuth()` call and widens the existing `GET /trips/{id}` and
  `GET /trips/{id}/expenses` response types it already fetches — no new endpoints, no extra calls.

## Files to change
- `frontend/app/trip/[id]/index.tsx` — type `created_by`, compute `canModify`, hide the per-row
  delete control when not authorized.
- `frontend/app/trip/[id]/edit-expense.tsx` — widen `Trip`/`Expense` types, read `useAuth()`,
  compute `canModify`, hide Save/Delete and render read-only + note when not authorized.
- `CLAUDE.md` — after the work is tested and committed, flip Roadmap **Step 17** from `- [ ]` to
  `- [x]`.

## Files to create
- `frontend/src/permissions.ts` — a small, pure, theme-agnostic helper mirroring the backend
  `can_modify_expense`:
  `canModifyExpense(expense: { created_by?: string | null }, userId: string | undefined, trip: { admin_ids?: string[] | null }): boolean`
  → `return !!userId && (expense.created_by === userId || (trip.admin_ids ?? []).includes(userId))`.
  Kept pure so both screens share one source of truth and it is unit-testable.
- `frontend/src/__tests__/permissions.test.ts` — jest unit tests covering the full creator/admin/
  owner/member/undefined-user/legacy/null-admin_ids matrix.
- `frontend/jest.config.js` — `module.exports = { preset: 'jest-expo' }` (the predicate is pure TS,
  so the preset transforms it cleanly).
- `.claude/specs/17-rbac-driven-component.md` — this spec document.

## New Dependencies
Frontend **dev** dependencies only (net-new test infra — the project had no test runner):
`jest`, `jest-expo`, `@types/jest`, plus a `"test": "jest"` script in `frontend/package.json`.
No runtime/production dependencies and no backend dependencies. The UI itself still uses only
existing `react-native`, `expo-router`, `@expo/vector-icons`, the `useAuth()`/`useTheme()` contexts,
and `theme.ts` tokens.

## Rules for Implementation
- **Mirror the server rule exactly.** The client predicate must equal `can_modify_expense`:
  `creator OR trip admin`, where a missing `created_by` (legacy rows) yields creator=false so only an
  admin sees the controls. Do **not** invent a looser client rule. Hiding a control is a UX nicety,
  **not** a security boundary — the backend (`_expense_modify_or_403`, Step 10) stays authoritative
  and must not be weakened.
- Gate only the **update and delete** affordances. Do **not** hide the ability to open/view a
  transaction, and do **not** touch the trip-level edit/delete buttons (already gated by `isOwner`)
  or member-admin controls (Step 14) — they are out of scope.
- Read identity from `useAuth()` (`user?.id`) and roles from the already-loaded trip
  (`trip.owner_id` / `trip.admin_ids`); do not refetch or add new endpoints.
- Respect the strict dual split-mode logic (`PER_CAPITA` vs `PER_FAMILY`) from Section 5 of
  `CLAUDE.md`: this step changes only control visibility and must not alter how an authorized edit
  computes or sends `split_mode`, `split_member_ids`, or `weight_snapshots`.
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) remain intact — no
  backend edits expected.
- Follow the frontend design system tokens (`SPACING`, `RADIUS`, `colors.*`) and support dynamic
  light/dark mode via `ThemeContext` (read `colors` from `useTheme()`; no hardcoded hex). The
  read-only note must be theme-aware.
- Keep changes strictly scoped to Step 17. Do not refactor unrelated transaction-form code, and do
  not start Step 18 (layout audit) or any other roadmap step here.

## Definition of Done
- [ ] `frontend/src/permissions.ts` exists, exporting a pure `canModifyExpense(expense, userId, trip)`
      that returns `true` iff `expense.created_by === userId` **or** `userId` is in `trip.admin_ids`,
      and `false` for an undefined `userId`.
- [ ] **Expenses tab (creator):** a member sees the inline delete (trash) control only on expenses
      they created; it is hidden on expenses created by others.
- [ ] **Expenses tab (admin/owner):** a trip admin (incl. the owner) sees the inline delete control
      on **every** expense regardless of creator.
- [ ] **Expenses tab (plain member):** a non-admin who created none of the listed expenses sees no
      inline delete controls; rows are still tappable to open the transaction.
- [ ] **Edit screen (authorized):** when the current user is the creator or a trip admin, the edit
      screen renders the form as editable and shows both **Save changes** (`ee-save`) and **Delete
      transaction** (`ee-delete`) exactly as today; saving and deleting still work end to end.
- [ ] **Edit screen (unauthorized):** when the user is neither creator nor admin, `ee-save` and
      `ee-delete` are **not rendered** and the `expense-readonly-note` caption is shown. (Per the
      "hide buttons only" decision, inputs remain interactive — removing the buttons removes the
      only mutation path.)
- [ ] **Predicate unit tests:** `cd frontend && yarn test` runs `src/__tests__/permissions.test.ts`
      and the full `canModifyExpense` matrix (creator, admin, owner, member, undefined user, legacy
      row, null `admin_ids`) passes.
- [ ] Legacy expense with no `created_by`: only an admin sees edit/delete controls (mirrors the
      backend safe default); a plain member does not.
- [ ] Hiding is purely client-side and does not change any request: an authorized edit/delete still
      sends the same `PATCH`/`DELETE` payloads, and the server still returns `403` if a forged client
      were to call the endpoint while unauthorized (backend authority unchanged).
- [ ] Light and dark mode both render the read-only note and the gated rows correctly (toggle theme
      from Profile).
- [ ] `cd backend && pytest` passes with no regressions — specifically
      `pytest tests/test_expense_rbac.py tests/test_expenses.py tests/test_rbac.py` are green,
      proving the `created_by` list field and the `403`/`404` edit-delete matrix the UI relies on
      still hold.
- [ ] `cd frontend && yarn lint` passes for the changed/created files (including the new test file).
- [ ] `CLAUDE.md` Roadmap **Step 17** checkbox flipped to `- [x]` in the implementation commit.
