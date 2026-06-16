# Spec: Interactive Join Wizard UI  (Step 13)

## Overview
This step builds the **frontend** join experience that consumes the contextual `/trips/join`
API delivered in Step 12. Today `frontend/app/join-trip.tsx` is a single-field screen that posts
only a `code` (legacy auto-link behavior). This step replaces it with a guided, multi-step wizard:
the user enters a trip code, the app validates it via the read-only `POST /api/trips/join/preview`
endpoint, then presents three clear choices — **"Join as Individual"**, **"Join existing Family"**
(a dynamic picker of the trip's families), or **"Create New Family Lineage"** (name + member
roster) — before submitting the matching `mode` payload to `POST /api/trips/join`. This realizes
Step 13 ("Interactive Join Wizard UI") in the Phase 4 Join Pipeline of the `CLAUDE.md` Roadmap and
is the UI counterpart to the Step 12 backend, surfacing the individual / family-link / new-family
join contexts to end users.

## Depends on
- **Step 12 (Complex Joining Context API)** — `POST /api/trips/join` (contextual `mode` payload) and
  `POST /api/trips/join/preview` (read-only family/trip context). Both are merged and live in
  `backend/routes/trips.py` with payload models in `backend/models/join.py`.
- **Step 3 (Unique Family & Domain Mapping)** — backend enforces unique family names and unique
  linked emails per trip; the wizard surfaces those errors but does not re-implement the rules.
- **Step 2 (Trip RBAC Infrastructure)** — joining via code is self-service; no admin role required.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. The wizard consumes the existing Step 12 `JoinRequest` /
`JoinPreviewRequest` models and the trip document shape unchanged. UUID `id` strings and `{"_id": 0}`
projections on the backend remain exactly as-is.

## Backend API & Services (FastAPI)
No backend changes. Both endpoints already exist and are the contract for this step:

- **`POST /api/trips/join/preview`** — auth required (any logged-in user; code is the authorization).
  - Input: `{ "code": string }`
  - Output:
    ```jsonc
    {
      "trip": { "id", "name", "code", "travel_date", "currency", "member_count" },
      "already_member": boolean,
      "matched_family": { "id", "name" } | null,   // a family whose linked email == this user's email and is unclaimed
      "families": [ { "id", "name", "size": int, "linked": bool } ]
    }
    ```
  - `404 "Trip not found"` for an unknown code.

- **`POST /api/trips/join`** — auth required. Idempotent if already a member (returns the trip).
  - Input: `{ "code", "mode"?, "family_id"?, "family_name"?, "family_members"? }`
    - `mode: "individual"` → joins as a standalone individual (never auto-links).
    - `mode: "family"` → requires `family_id`; links the user into that existing family entity.
      Backend rejects with `400` if the family is already linked to another account.
    - `mode: "new_family"` → requires `family_name`; optional `family_members: string[]` roster.
      Backend enforces unique family name + gmail-only / unique linked email.
    - `mode` omitted → legacy auto behavior (email auto-link else new individual). The wizard always
      sends an explicit `mode`, but the "recommended" matched-family path maps to `mode: "family"`.
  - Output: the full updated trip document.
  - Error mapping the wizard must surface verbatim from `detail`: `400 "family_id is required..."`,
    `404 "Family not found"`, `400 "Target member is not a family"`,
    `400 "This family is already linked to another account"`, `400 "family_name is required..."`,
    plus Step 3 uniqueness/gmail errors for `new_family`.

## App Screens & UI (Expo React Native)
- **Modify (in place):** `frontend/app/join-trip.tsx` — refactor the single-field screen into a
  staged wizard. Keep the same route name (`join-trip`) and `testID="jt-code"` / `testID="jt-submit"`
  on the code-entry step so existing navigation entry points (`dashboard.tsx`, `trips.tsx`) and any
  current tests keep working. The wizard has two logical stages within one screen:
  1. **Stage 1 — Code entry & validation.** 6-character uppercase code input (reuse current styling).
     On continue, call `/trips/join/preview`. On `404`, show inline error. If `already_member` is
     true, route straight to `/trip/{id}`. Otherwise advance to Stage 2 showing the resolved trip
     name / member count as a confirmation header.
  2. **Stage 2 — Choose how to join.** Three selectable cards/segments:
     - **Join as Individual** → submits `{ code, mode: "individual" }`.
     - **Join existing Family** → reveals a dynamic picker built from `preview.families`. Each row
       shows family name + `size` ("4 members") and is disabled with a "Linked" badge when
       `linked === true`. Selecting one enables submit with `{ code, mode: "family", family_id }`.
       If `matched_family` is present, surface it at the top as a **Recommended** pre-selection.
     - **Create New Family Lineage** → reveals a family-name input plus a comma-separated member
       roster field (mirror the pattern in `trip/[id]/add-member.tsx`). Submits
       `{ code, mode: "new_family", family_name, family_members }`.
  - Provide a visible **Back** affordance from Stage 2 to Stage 1, and a busy/disabled state on the
    submit button during the in-flight request. On success route to `/trip/{trip.id}` via
    `router.replace`.
- **Create:** none required. (If the implementer prefers to extract the family picker into a small
  reusable component, place it under `frontend/src/` — but this is optional and must not change
  behavior of other screens.)

## State & API Integration
- No changes to `frontend/src/api.ts` are required — both endpoints are reachable through the
  existing `api<T>()` wrapper, which already normalizes FastAPI `detail` error strings.
- No changes to `AuthContext` or `ThemeContext`; the wizard reads `useTheme()` for tokens only.
- No new `AsyncStorage` caching. Preview/selection state lives in component `useState` for the
  duration of the wizard and is discarded on unmount.
- Reuse `frontend/src/validation.ts` (`isGmail`, `GMAIL_ONLY_MESSAGE`) for client-side hinting only
  in the new-family path; the backend remains the source of truth for gmail/uniqueness enforcement.

## Files to change
- `frontend/app/join-trip.tsx` — refactor single-field screen into the two-stage wizard.

## Files to create
- (Optional) `frontend/src/FamilyPicker.tsx` — only if the implementer extracts the family list row
  UI into a shared component. Not required to satisfy this step.
- `.claude/specs/13-interactive-join-wizard.md` — this spec (already created).

## New Dependencies
No new dependencies. The wizard uses existing primitives (`react-native`, `expo-router`,
`@expo/vector-icons` Ionicons, `react-native-safe-area-context`) already present in the app.

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5 of
  `CLAUDE.md`. (This screen does not compute splits, but a user joining an existing family must be
  treated mathematically as an integrated member of that family unit per the "App User Identity
  Mapping" rule — the wizard must therefore send `mode: "family"` with the correct `family_id`, not
  create a duplicate individual.)
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact — no backend
  edits in this step, so do not touch them.
- Enforce Role-Based Access Control (RBAC) on the backend before executing destructive edits/deletes.
  Joining is intentionally self-service (code = authorization); do not add admin gating to `/join`.
  Do not introduce any new client-side trust assumptions — always surface the server's error `detail`.
- Follow the frontend design system tokens (`SPACING`, `RADIUS`, `COLORS` via `useTheme()`); support
  dynamic light/dark mode through `ThemeContext`. Reuse the `T` typography component and the existing
  pill/segment patterns from `add-member.tsx` rather than hardcoding colors or font sizes.
- Preserve the `join-trip` route name and the `jt-code` / `jt-submit` testIDs; add new `testID`s for
  the mode selection (e.g. `jt-mode-individual`, `jt-mode-family`, `jt-mode-new_family`), the family
  picker rows (`jt-family-<id>`), and the new-family inputs (`jt-family-name`, `jt-family-members`).
- Keep changes strictly scoped to this step; do not refactor unrelated screens, the API wrapper, or
  any backend code.

## Definition of Done
- [ ] `cd backend && pytest` passes — the Step 12 `tests/test_join.py` suite (preview + all four join
      modes, idempotency, and error paths) still passes green, confirming the API contract the wizard
      depends on is intact.
- [ ] Entering a valid trip code in the wizard and pressing continue calls `/trips/join/preview` and
      advances to the mode-selection stage showing the correct trip name and member count.
- [ ] Entering an unknown/invalid code surfaces the backend `404 "Trip not found"` message inline
      without crashing or advancing.
- [ ] Re-joining a trip you already belong to (preview `already_member: true`) routes directly to
      `/trip/{id}` instead of showing the choices.
- [ ] **Join as Individual** creates a standalone individual member and lands on the trip screen;
      the new member appears in the trip roster.
- [ ] **Join existing Family** lists the trip's families with member counts, disables families where
      `linked === true` with a "Linked" badge, pre-selects the `matched_family` as Recommended when
      present, and on submit links the user into the chosen family (no duplicate individual created).
- [ ] Attempting to select/submit an already-linked family surfaces the backend
      `400 "This family is already linked to another account"` message gracefully.
- [ ] **Create New Family Lineage** with a unique name + comma-separated roster creates a new family
      member; a duplicate family name or non-gmail/duplicate email surfaces the backend error verbatim.
- [ ] Light and dark mode both render correctly using only `ThemeContext` tokens (no hardcoded hex).
- [ ] `cd frontend && yarn lint` passes for the modified screen.
- [ ] The wizard's submit button shows a disabled/busy state during the in-flight request and cannot
      double-submit.
