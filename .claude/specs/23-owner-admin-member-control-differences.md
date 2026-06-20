# Spec: Owner / Admin / Member Control Differences  (Step 23)

## Overview
Trip Expense Splitter has three implicit access tiers — **Owner** (the creator, `owner_id`),
**Admin** (`admin_ids`), and **Member** (anyone in `user_ids`) — but the boundaries between them are
inconsistent and, in one case, missing. Today `PATCH /api/trips/{id}` (`update_trip`) is gated only
by `_trip_or_404`, so **any plain member can rename the trip or change its budget/date/currency**;
and the admin-grant endpoints are gated by `_trip_admin_or_403`, so **any admin — not just the
owner — can promote or demote other admins**. Step 23 makes the three roles into a single, explicit
**capability matrix** that is defined once, enforced on the backend, and mirrored (as a UX
convenience only) on the client. It closes the trip-settings gap, makes admin management an
owner-only power, adds an owner-only **ownership transfer**, and gives the frontend a canonical
`roleOf`/capability layer so role badges and control visibility are derived from one source of
truth instead of ad-hoc `admin_ids.includes(...)` checks scattered across screens. This is a new
**Phase 7 (Post-Launch Bug Fixes & Hardening), Step 23** entry on the `CLAUDE.md` Roadmap (the
roadmap currently ends at Step 22); it builds directly on the RBAC infrastructure from Step 2 and the
member/expense locks from Steps 10–11.

## Depends on
- **Step 2 — Trip RBAC Infrastructure.** The trip document already carries `owner_id` (string) and
  `admin_ids` (string array, owner seeded as root admin); `GET /api/trips/{id}` returns both under the
  `{"_id": 0}` projection. `utils/deps.py` already has `is_trip_admin`, `_trip_or_404`, and
  `_trip_admin_or_403`.
- **Step 10 — Expense Modification Protection.** `can_modify_expense` / `_expense_modify_or_403`
  (creator-or-admin) define the expense tier of the matrix and are reused unchanged.
- **Step 11 — Member Administration Locks.** `add_member`/`update_member`/`delete_member` are already
  behind `_trip_admin_or_403`; they remain the "Admin" tier for member mutation.
- **Step 14 — Administrative Controls Member Tab.** Establishes the `manage-member` modal, the
  `Badge` component, and the roster role-badge pattern this step refines (admin toggle becomes
  owner-only; ownership-transfer action added).

## Data Model Changes (MongoDB/Pydantic)
No new collections or indexes. The trip document keeps its existing shape — `owner_id: str`,
`admin_ids: [str]`, `user_ids: [str]`, `members: [...]` — all UUID strings, never Mongo ObjectIds.

- **New Pydantic request model** in `backend/models/trip.py`:
  - `class OwnershipTransfer(BaseModel): user_id: str` — body for the transfer endpoint.
- **No change** to `TripIn` / `TripUpdate` / `AdminGrant`.
- **Document mutation (not a schema change):** ownership transfer reassigns the existing `owner_id`
  field and `$addToSet`s the new owner into `admin_ids`; the previous owner is **kept** in
  `admin_ids` (demoted Owner → Admin, never dropped to Member). No field is added or removed.

## Backend API & Services (FastAPI)

### New canonical role layer — `backend/utils/permissions.py` (new file)
Pure functions, no DB access (operate on an already-fetched trip dict). One source of truth for the
matrix, importable by routes and reusable in tests:

- `Role = Literal["owner", "admin", "member"]`
- `role_of(trip: dict, user_id: str) -> Optional[Role]` — `"owner"` if `user_id == trip["owner_id"]`,
  else `"admin"` if `user_id in trip["admin_ids"]`, else `"member"` if `user_id in trip["user_ids"]`,
  else `None` (not on the trip). Owner supersedes Admin.
- Capability predicates (each `(trip, user_id) -> bool`), expressed against `role_of`:
  - `can_view(trip, uid)` → role is not None
  - `can_manage_members(trip, uid)` → role in {owner, admin}
  - `can_edit_trip_settings(trip, uid)` → role in {owner, admin}
  - `can_modify_any_expense(trip, uid)` → role in {owner, admin}  *(creator-or-admin still handled by `can_modify_expense`)*
  - `can_manage_admins(trip, uid)` → role == owner
  - `can_transfer_ownership(trip, uid)` → role == owner
  - `can_delete_trip(trip, uid)` → role == owner

`utils/deps.py::is_trip_admin` is re-expressed in terms of (or kept consistent with) `role_of`; a new
dependency is added there (deps.py is the DB-touching FastAPI layer, permissions.py stays pure):

- `async def _trip_owner_or_403(trip_id, user_id) -> dict` — fetches via `_trip_or_404`, raises
  `HTTPException(403, "Only the trip owner can perform this action")` unless `role_of(trip, uid) == "owner"`.

### Changed routes — `backend/routes/trips.py`
- **`PATCH /api/trips/{trip_id}` (`update_trip`)** — **gap fix.** Swap `_trip_or_404` →
  `_trip_admin_or_403`. Owner + admins may edit settings; a plain member now gets `403 "Admin
  privileges required"`. Inputs/outputs otherwise unchanged.
- **`POST /api/trips/{trip_id}/admins` (`add_admin`)** — **tighten to owner-only.** Swap
  `_trip_admin_or_403` → `_trip_owner_or_403`. Body `{ user_id }` unchanged; still `400` if the target
  is not in `user_ids`; still `$addToSet` (idempotent); returns `_admin_payload`.
- **`DELETE /api/trips/{trip_id}/admins/{user_id}` (`remove_admin`)** — **tighten to owner-only.** Swap
  to `_trip_owner_or_403`. Still rejects removing the root admin with `400 "Cannot remove the root
  admin"`. Returns `_admin_payload`.
- **`DELETE /api/trips/{trip_id}` (`delete_trip`)** — already owner-only via an inline
  `trip["owner_id"] != user["id"]` check; re-express it through `_trip_owner_or_403` (or
  `can_delete_trip`) for consistency. Behavior unchanged (still `403`).

### New route — `backend/routes/trips.py`
- **`POST /api/trips/{trip_id}/transfer-ownership`** — **owner only** (`_trip_owner_or_403`).
  - Input: `OwnershipTransfer { user_id: str }`.
  - Validation: `user_id` must be in `trip["user_ids"]` else `400 "User is not a member of this
    trip"`; transferring to the current owner is a `400 "Already the owner"` (no-op guard).
  - Effect (single `update_one`): `$set owner_id = user_id`, `$addToSet admin_ids = user_id`. The
    previous owner stays in `admin_ids` (Owner → Admin). 
  - Output: the refreshed `_admin_payload(trip)` (now reporting the new `owner_id`).

`_admin_payload` is unchanged and already returns `{ owner_id, admin_ids, admins[] }`, which is enough
for the client to recompute everyone's role after any of these calls.

### RBAC summary (the enforced matrix)
| Capability | Owner | Admin | Member |
|---|---|---|---|
| View trip / expenses / balances / reports | ✓ | ✓ | ✓ |
| Create expense | ✓ | ✓ | ✓ |
| Edit / delete **own** expense | ✓ | ✓ | ✓ |
| Edit / delete **any** expense | ✓ | ✓ | ✗ |
| Add / edit / delete members & families | ✓ | ✓ | ✗ |
| Edit trip settings (name / date / budget / currency) | ✓ | ✓ | ✗ *(was: anyone)* |
| Promote / demote admins | ✓ | ✗ *(was: any admin)* | ✗ |
| Transfer ownership | ✓ | ✗ | ✗ |
| Delete trip | ✓ | ✗ | ✗ |

## App Screens & UI (Expo React Native)
- **Modify: `frontend/app/trip/[id]/index.tsx`** — replace the local ad-hoc role logic (`isOwner`,
  `meIsAdmin`, inline `roleOf`) with imports from `src/permissions.ts`. Gate the **`trip-edit`
  pencil** (`index.tsx:168`) behind `canEditTripSettings(trip, user?.id)` — it is currently shown to
  everyone, which is the visible side of the backend gap. Keep the existing member-tab gating
  (`add member` row, per-row `member-manage-{id}`) but source it from `canManageMembers`.
- **Modify: `frontend/app/trip/[id]/manage-member.tsx`** —
  - Show the **"Make admin" / "Remove admin"** toggle only when the **current user is the owner**
    (`canManageAdmins(trip, me)`), matching the backend tightening. A non-owner admin viewing the
    modal sees a muted note: "Only the trip owner can change admin roles." Backend `403` is still
    surfaced inline if forced.
  - Add an **owner-only "Transfer ownership"** action (`testID="mm-transfer-ownership"`) shown when
    the viewer is the owner and the target member is a **joined app user** (`member.user_id`) who is
    **not** already the owner. It routes through the themed **`ConfirmModal`** ("Make {name} the
    owner? You will become an admin.") and on confirm calls `POST /trips/{id}/transfer-ownership
    { user_id }`, then refreshes local state / pops back so badges update.
  - The owner's own row keeps the existing non-removable "Owner · root admin" state.
- **Modify: `frontend/app/trip/[id]/edit.tsx`** — no gating logic needed (entry is hidden in
  `index.tsx` and the backend enforces), but surface a `403` from the `PATCH` cleanly via the existing
  `toast` (it already catches and toasts `e.message`); confirm the error path reads the server
  `detail`.
- **No new screens.** Ownership transfer reuses the existing `manage-member` modal and `ConfirmModal`.

## State & API Integration
- **`frontend/src/permissions.ts`** — extend the existing module (keep `canModifyExpense` exactly as
  is) with the client mirror of the matrix:
  - `export type Role = 'owner' | 'admin' | 'member';`
  - `export type RoleTrip = { owner_id?: string | null; admin_ids?: string[] | null; user_ids?: string[] | null };`
  - `roleOf(trip, userId): Role | null` (owner > admin > member > null; undefined user → null).
  - `canManageMembers`, `canEditTripSettings`, `canManageAdmins`, `canTransferOwnership`,
    `canDeleteTrip` — thin predicates over `roleOf`, each tolerant of `undefined` user and
    missing/null arrays (mirrors the defensive style already in `canModifyExpense`).
  - These are **UX-only** mirrors; the backend stays authoritative. The header comment must say so.
- **No change to `frontend/src/api.ts`** — all four endpoints (existing three + new transfer) go
  through the existing `api<T>()` wrapper, which attaches the bearer token and normalizes FastAPI
  `detail` errors. The new POST uses `{ method: 'POST', body: { user_id } }`.
- **No change to `AuthContext` / `ThemeContext`** — read `useAuth().user.id` for role computation and
  `useTheme()` for tokens only.
- **No new `AsyncStorage` caching.** Role is always derived from the freshly-loaded trip doc /
  `_admin_payload`; modal state stays in component `useState`.

## Files to change
- `backend/models/trip.py` — add `OwnershipTransfer` model.
- `backend/utils/deps.py` — add `_trip_owner_or_403`; keep `is_trip_admin` consistent with
  `role_of`.
- `backend/routes/trips.py` — gate `update_trip` (admin); tighten `add_admin`/`remove_admin` (owner);
  re-express `delete_trip` owner check; add `transfer_ownership` route.
- `frontend/src/permissions.ts` — add `Role`, `roleOf`, and the capability predicates.
- `frontend/app/trip/[id]/index.tsx` — import role helpers; gate the `trip-edit` button; route
  member-tab gating through `canManageMembers`.
- `frontend/app/trip/[id]/manage-member.tsx` — owner-only admin toggle + owner-only transfer action
  via `ConfirmModal`.
- `frontend/src/__tests__/permissions.test.ts` — add cases for `roleOf` and the new predicates.
- `CLAUDE.md` — add the **Phase 7, Step 23** roadmap line and flip `- [ ]` → `- [x]` on completion
  (per the Section 6 AGENT DIRECTIVE).

## Files to create
- `backend/utils/permissions.py` — pure role/capability layer (`Role`, `role_of`, predicates).
- `backend/tests/test_role_control.py` — backend matrix coverage (see Definition of Done).
- `.claude/specs/23-owner-admin-member-control-differences.md` — this spec.

## New Dependencies
No new dependencies. Backend uses existing FastAPI/Motor/Pydantic; frontend uses existing
`expo-router`, `ConfirmModal`, `Badge`, and the `ui/` design-system primitives.

## Rules for Implementation
- Respect the strict dual split-mode logic (`PER_CAPITA` vs `PER_FAMILY`) from Section 5 of
  `CLAUDE.md`. Per the **App User Identity Mapping** rule, role changes (promote / demote / transfer)
  must touch **only** `owner_id` / `admin_ids` — never `members[]`, `family_members`, `user_ids`
  membership, or any split basis. Changing who is owner/admin must not alter any balance.
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) stay intact; documents keep `id`
  string UUIDs, never ObjectIds.
- **Enforce RBAC on the backend before every destructive edit/delete.** The new
  `utils/permissions.py` is the single definition; routes call the `deps.py` guards
  (`_trip_admin_or_403`, `_trip_owner_or_403`). Client predicates are a UX convenience and must never
  be the only check — always surface the server's `detail` on rejection.
- The **owner can never be demoted** (`DELETE /admins/{owner}` stays `400`); after a transfer the
  **previous owner remains an admin** (kept in `admin_ids`), and the new owner is added to
  `admin_ids`.
- Follow the frontend design-system tokens (`SPACING`, `RADIUS`, colors via `useTheme()`); support
  dynamic light/dark mode through `ThemeContext`. Reuse `T`, `Badge`, `Button`, `Card`, and
  `ConfirmModal` rather than hardcoding colors/sizes. Preserve existing testIDs (`trip-edit`,
  `member-manage-{id}`, `mm-make-admin`, `mm-remove-admin`, `mm-edit-details`) and add the new
  `mm-transfer-ownership`.
- Keep changes strictly scoped to this step. Do not refactor unrelated routes/screens, do not change
  the trip-document shape beyond the `owner_id`/`admin_ids` mutation, and do not alter the Step 10
  expense rule or Step 11 member locks beyond routing them through the shared matrix.

## Definition of Done
A reviewer can verify each item by running the backend API and the Expo app.

- [ ] `cd backend && pytest` passes the **full** suite. Existing `tests/test_rbac.py` (admin
      grant/revoke, owner-not-removable — all driven by the owner token) and `tests/test_member_rbac.py`
      stay green after the owner-only tightening.
- [ ] New `backend/tests/test_role_control.py` passes and covers the matrix:
  - [ ] A plain member gets `403` from `PATCH /trips/{id}` (settings); an admin and the owner get `200`.
  - [ ] A **non-owner admin** gets `403` from `POST /trips/{id}/admins` and `DELETE
        /trips/{id}/admins/{uid}`; the **owner** gets `200` for both.
  - [ ] `POST /trips/{id}/transfer-ownership` by the owner moves `owner_id` to the target, keeps the
        old owner in `admin_ids`, and adds the new owner to `admin_ids`; afterwards the **new** owner
        can manage admins and the **old** owner (now a plain admin) gets `403` from the admin
        endpoints.
  - [ ] Transfer to a non-member returns `400`; transfer by a non-owner returns `403`.
  - [ ] `utils/permissions.py::role_of` and predicates unit-tested for owner/admin/member/None and
        owner-supersedes-admin precedence.
- [ ] In the running app, a **plain member** no longer sees the `trip-edit` pencil on the trip detail
      header; the **owner and admins** still do (verified in light and dark mode).
- [ ] In `manage-member`, the **admin toggle** appears only to the **owner**; a non-owner admin sees
      the "Only the trip owner can change admin roles" note; the backend `403` is surfaced inline if
      forced.
- [ ] The owner can **transfer ownership** to another joined app user via the `ConfirmModal`; on
      success the new owner shows the **Owner** badge, the previous owner shows the **Admin** badge,
      and the `trip-edit` / admin controls follow the new roles.
- [ ] `cd frontend && yarn lint` passes, and `frontend/src/__tests__/permissions.test.ts` (extended
      with `roleOf` + predicate cases) passes under the existing jest setup.
- [ ] `CLAUDE.md` gains the Phase 7 **Step 23** line, flipped to `[x]`, with the work committed on
      `feature/owner-admin-member-control-differences`.
