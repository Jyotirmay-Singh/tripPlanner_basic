# Spec: Administrative Controls Member Tab  (Step 14)

## Overview
This step upgrades the **Members roster** inside the trip detail screen so it visibly communicates
**who holds power** and lets only those people use it. Today every trip member sees the same roster
with an always-on "Add member" row and per-row edit/delete buttons — but the Step 11 backend lock
already rejects member mutations from non-admins with `403`, so a plain member taps and gets an
error. Step 14 closes that gap on the client: it renders **crisp operational badges** ("Owner",
"Admin", "You") on each row, hides the mutation affordances from non-admins (read-only roster), and
introduces a **modal pathway** through which a designated admin can safely manage a member —
promote/demote their Trip Admin role and enter the family-configuration editor. This realizes
**Phase 4, Step 14 ("Administrative Controls Member Tab")** of the `CLAUDE.md` Roadmap and is the UI
counterpart to the Step 2/11 admin (RBAC) backend. The deeper retroactive-recalculation confirmation
on family size changes is **Step 15** and the broad transaction-screen RBAC hiding is **Step 17** —
both are intentionally out of scope here.

## Depends on
- **Step 2 (Trip RBAC Infrastructure)** — the trip document carries `owner_id` and an `admin_ids`
  string array (owner seeded as root admin); `GET /api/trips/{id}` returns both. The admin grant
  endpoints (`GET/POST/DELETE /api/trips/{id}/admins`) live in `backend/routes/trips.py`.
- **Step 11 (Member Administration Locks)** — `add_member`, `update_member`, `delete_member` are
  already gated by `_trip_admin_or_403`; this UI must mirror that gate so non-admins never tap into a
  guaranteed `403`.
- **Step 13 (Interactive Join Wizard UI)** — establishes the `Badge` + selectable-card visual
  pattern in `frontend/app/join-trip.tsx` that this step reuses for role badges.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. `owner_id`, `admin_ids: string[]`, and `members[]` (each with UUID `id` and an
optional `user_id` linking an app user) already exist on the trip document and are returned by
`GET /api/trips/{id}` under the standard `{"_id": 0}` projection. This step only changes how the
client renders and gates that existing data.

## Backend API & Services (FastAPI)
No backend changes. The endpoints this step consumes already exist and are the contract:

- **`GET /api/trips/{trip_id}`** — any trip member. Returns the full trip doc including `owner_id`
  and `admin_ids`. This is the single source the roster uses to compute badges and the current
  user's admin status (no extra round-trip needed for rendering).
- **`GET /api/trips/{trip_id}/admins`** — any trip member. Returns
  `{ owner_id, admin_ids: string[], admins: [{ user_id, id, name, email }] }` (`_admin_payload`).
  Optional for the manage modal if it prefers an enriched view; the trip doc alone is sufficient.
- **`POST /api/trips/{trip_id}/admins`** — **admin only** (`_trip_admin_or_403`).
  - Input: `{ "user_id": string }`. The user must already be a trip member (else `400 "User is not a
    member of this trip"`). Adds to `admin_ids` (`$addToSet`, idempotent). Returns the admin payload.
- **`DELETE /api/trips/{trip_id}/admins/{user_id}`** — **admin only**.
  - Removes from `admin_ids`. Rejects removing the root admin with `400 "Cannot remove the root
    admin"`. Returns the admin payload.
- **Family-config edit** continues through the existing **`PATCH /api/trips/{trip_id}/members/{member_id}`**
  (admin only) reached via the `edit-member` screen — unchanged here.

The UI must surface each endpoint's `detail` error string verbatim (the `api<T>()` wrapper already
normalizes FastAPI error bodies). No new routes, dependencies, or service functions.

## App Screens & UI (Expo React Native)
- **Modify:** `frontend/app/trip/[id]/index.tsx` — the **`members` tab** only:
  - Extend the local `Trip` type with `admin_ids: string[]` (already present on the API response).
  - Compute `meIsAdmin = !!user && (trip.admin_ids ?? []).includes(user.id)` and a helper
    `roleOf(member)` returning `'owner' | 'admin' | null` from `member.user_id` vs `trip.owner_id` /
    `trip.admin_ids` (only members with a `user_id` can hold a role).
  - **Badges** on every member row, using a small reusable `Badge` (see "Files to create"):
    "Owner" (root admin — `member.user_id === trip.owner_id`), "Admin" (in `admin_ids`, not owner),
    and the existing **You** marker promoted to a badge for consistency. Owner supersedes Admin (show
    one role badge). Use theme tokens for colors (e.g. `colors.primary` for Owner, `colors.owed` for
    Admin, `colors.textMuted` for You) — no hardcoded hex.
  - **RBAC gating (member-tab scope):**
    - Render the "Add member or family" row (`trip-add-member`) **only when `meIsAdmin`**.
    - For non-admins, render a **read-only roster**: no add row, no per-row manage affordance, plus a
      single muted hint line (`testID="members-readonly-note"`) such as "Only trip admins can add or
      change members."
    - Remove the always-on inline pencil/trash from each row and replace them with a **single manage
      affordance** (`testID="member-manage-{id}"`, e.g. an `ellipsis-horizontal`/`settings-outline`
      icon) shown **only when `meIsAdmin`**, which opens the new manage modal.
- **Create:** `frontend/app/trip/[id]/manage-member.tsx` — an admin-only **modal** route
  (`router.push({ pathname: '/trip/[id]/manage-member', params: { id, mid } })`). It is the modal
  pathway that lets a designated admin safely alter a member's configuration:
  - Loads the trip (`GET /trips/{id}`) and resolves the target member by `mid`; derives `owner_id`,
    `admin_ids`, and the member's `user_id`.
  - **Header:** member name + current role badge(s).
  - **Trip role section** (only when the member has a `user_id`, i.e. is an app user):
    - If the member is the **owner**: show a non-interactive "Owner · root admin" row stating the
      root admin cannot be demoted.
    - Else a toggle/button: **"Make admin"** (`testID="mm-make-admin"`) → `POST /trips/{id}/admins
      { user_id }`, or **"Remove admin"** (`testID="mm-remove-admin"`) → `DELETE
      /trips/{id}/admins/{user_id}`. Reflect the new state on success; surface backend `400`/`403`
      errors inline.
    - Members **without** a `user_id` (manually-added individuals/families) show a muted note that
      only app users who have joined can become admins.
  - **Family configuration section:** a **"Edit member & family details"** button
    (`testID="mm-edit-details"`) routing to the existing `edit-member` screen
    (`/trip/[id]/edit-member?mid=...`). (The retroactive re-allocation prompt that fires on a family
    size change is **Step 15** and lives in/around `edit-member`; this step only provides the
    entry pathway.)
  - **Busy/disabled** state on every action button during in-flight requests; no double-submit. On
    role change, either re-fetch the trip or update local state so badges stay consistent when the
    user returns to the roster (the roster already reloads via `useFocusEffect`).
- **Register** the new screen in `frontend/app/_layout.tsx` as a `Stack.Screen` with
  `presentation: 'modal'` and `title: 'Manage Member'`, matching the existing `edit-member` entry.

## State & API Integration
- **No changes to `frontend/src/api.ts`** — all four endpoints are reachable through the existing
  `api<T>()` wrapper, which already attaches the bearer token and normalizes `detail` errors.
- **No changes to `AuthContext`/`ThemeContext`** — read `useAuth().user.id` to compute admin status
  and `useTheme()` for tokens only.
- **No new `AsyncStorage` caching.** Manage-modal state lives in component `useState`; the roster
  re-reads via its existing `useFocusEffect(load)` when the modal is dismissed.

## Files to change
- `frontend/app/trip/[id]/index.tsx` — `members` tab: add `admin_ids` to the `Trip` type, role
  badges, admin-only gating of the add row + per-row manage affordance, read-only note for
  non-admins.
- `frontend/app/_layout.tsx` — register the `trip/[id]/manage-member` modal screen.
- `CLAUDE.md` — flip `- [ ] Step 14` to `- [x] Step 14` upon completion (per the Section 6 AGENT
  DIRECTIVE).

## Files to create
- `frontend/app/trip/[id]/manage-member.tsx` — admin-only modal: role promote/demote + family-config
  entry pathway.
- `frontend/src/Badge.tsx` — small shared role/label badge component extracted from the inline
  `Badge` pattern in `join-trip.tsx` (props: `label`, `color`), reused by the roster and the modal.
  *(Optional but recommended; if not extracted, replicate the existing inline badge styling instead —
  do not hardcode new colors.)*
- `.claude/specs/14-admin-controls-member-tab.md` — this spec (already created).

## New Dependencies
No new dependencies. Uses existing primitives only (`react-native`, `expo-router`,
`@expo/vector-icons` Ionicons, `react-native-safe-area-context`) already in the app.

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5 of
  `CLAUDE.md`. This screen does not compute splits, but per the **App User Identity Mapping** rule an
  app user who is part of a family keeps their own `user_id` (for auth/admin) while being treated
  mathematically as an integrated family member — so granting/removing the Trip Admin role must
  **never** alter `members[]`, `family_members`, or any split basis. Admin role lives **only** in
  `admin_ids`.
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact — no backend
  edits in this step, so do not touch them.
- Enforce RBAC on the backend before destructive edits/deletes. The backend (`_trip_admin_or_403`)
  remains the source of truth; the client gating is a UX convenience, **not** a security boundary.
  Always surface the server's `detail` on a rejected call rather than assuming the client check is
  sufficient. Do not weaken or bypass any backend guard.
- The **root admin (owner) must not be demotable** in the UI — hide/disable "Remove admin" for the
  owner and still surface the backend `400 "Cannot remove the root admin"` if it is ever attempted.
- Only members with a `user_id` (joined app users) may be promoted to admin; do not offer the role
  toggle for manually-added members.
- Follow the frontend design system tokens (`SPACING`, `RADIUS`, colors via `useTheme()`) and support
  dynamic light/dark mode through `ThemeContext`. Reuse the `T` typography component and the existing
  card/pill/badge patterns from `index.tsx` and `join-trip.tsx` rather than hardcoding colors/sizes.
- Keep the `trip/[id]/index` route name and the `trip-tab-members` testID intact so navigation entry
  points keep working. Add new testIDs (`member-manage-{id}`, `members-readonly-note`,
  `mm-make-admin`, `mm-remove-admin`, `mm-edit-details`). Preserve the existing `add-member` /
  `edit-member` routes and their testIDs.
- Keep changes strictly scoped to this step: do **not** build the Step 15 retroactive-recalc prompt
  beyond the existing behavior, do **not** add the Step 17 transaction-screen RBAC hiding, and do
  **not** refactor unrelated screens, the API wrapper, or any backend code.

## Definition of Done
- [ ] `cd backend && pytest` passes the full suite as a regression guard — `tests/test_rbac.py`
      (admin grant/revoke, owner-not-removable) and `tests/test_member_rbac.py` (admin-only member
      mutations) stay green, confirming the `/admins` and member-mutation contracts this UI relies on
      are intact (no backend code changes in this step).
- [ ] The `members` tab renders an **Owner** badge on the trip owner's row, an **Admin** badge on
      every other member whose `user_id` is in `admin_ids`, and a **You** badge on the current user's
      row, correctly in both light and dark mode (theme tokens only — no hardcoded hex).
- [ ] A **non-admin** trip member sees a **read-only roster**: no "Add member" row, no per-row manage
      affordance, and a visible muted note (`members-readonly-note`); they cannot reach any member
      mutation from this tab.
- [ ] An **admin** sees the "Add member" row and a manage affordance (`member-manage-{id}`) on each
      member row; tapping it opens the `manage-member` modal for the correct member.
- [ ] In the modal, an admin can **promote** a non-admin app-user member to admin (`POST
      /trips/{id}/admins`) and **demote** an admin (`DELETE /trips/{id}/admins/{user_id}`); returning
      to the roster shows the updated badge.
- [ ] The **owner** row in the modal shows a non-removable "Owner · root admin" state; attempting to
      remove the owner is prevented client-side and the backend `400 "Cannot remove the root admin"`
      is surfaced if forced.
- [ ] A manually-added member (no `user_id`) shows no admin toggle, only the muted "must join as an
      app user" note, and still exposes the **"Edit member & family details"** pathway to
      `edit-member`.
- [ ] **"Edit member & family details"** routes the admin into the existing `edit-member` screen for
      the selected member, leaving Step 15's recalculation prompt behavior unchanged.
- [ ] Action buttons in the modal show a disabled/busy state during in-flight requests and cannot
      double-submit; backend `detail` errors are surfaced inline.
- [ ] `cd frontend && yarn lint` passes for the modified and new screens.
- [ ] `CLAUDE.md` Step 14 checkbox flipped to `[x]` and the work committed on
      `feature/admin-controls-member-tab`.
