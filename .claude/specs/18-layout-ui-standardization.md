# Spec: Layout UI Audit & Standardization  (Step 18)

## Overview
This step delivers **Phase 6, Step 18 — "Layout UI Audit & Standardization"** from the `CLAUDE.md`
Roadmap. It has two coupled goals. First, **homogenize the design system** so every in-scope screen
draws its spacing, radii, colors, and typography from shared tokens instead of ad-hoc literals —
removing the recurring magic numbers (`paddingBottom: 120` duplicated across 7 screens, the form
`input` style block duplicated across ~11 screens with `paddingVertical: 14` / `fontSize: 16`) and the
one hardcoded color (`rgba(255,255,255,0.15)` on the trip header code chip, which renders wrong in
dark mode). Second, **surface the trip member composition** as a single canonical string on the Home
(dashboard) and trip Detail layouts reading exactly `[X] Individuals across [Y] Families & [Z]
Singles`, where `X` is the total number of human beings (per Section 5 of `CLAUDE.md`), `Y` is the
number of family entities, and `Z` is the number of standalone individuals. The composition math is
extracted into one pure, unit-tested helper so Home and Detail (and any future surface) share a single
source of truth, mirroring the pattern set by `frontend/src/permissions.ts` in Step 17.

## Depends on
- **Step 1 — Modularize Backend** (done): provides the route layout this spec reads from
  (`backend/routes/trips.py`). No backend change is required, but the spec relies on `GET /api/trips`
  returning full trip documents.
- **Step 2 — Trip RBAC Infrastructure** (done): `GET /api/trips/{id}` and the trip list both carry the
  full `members[]` array with `kind` (`individual` | `family`) and `family_members[]`, which is the
  raw data the composition helper consumes.
- **Step 16 / Step 17** (done): established the current shape of the trip Detail screen
  (`frontend/app/trip/[id]/index.tsx`) and the Home dashboard that this step restyles, and introduced
  the frontend test runner (`jest` + `jest-expo`, `frontend/jest.config.js`, `"test": "jest"`) that
  the new composition unit test reuses.
- Existing tokens in `frontend/src/theme.ts` (`COLORS`, `SPACING`, `RADIUS`) and the `T` typography
  component (`frontend/src/T.tsx`) — this step extends them, it does not replace them.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. No new collections, fields, or indexes. The composition string is computed
entirely on the client from data already on the wire: every trip document already includes
`members[]` with `kind` and `family_members[]`. All documents keep UUID string `id`s; all backend
reads keep their `{"_id": 0}` projections untouched.

## Backend API & Services (FastAPI)
No backend changes. The data needed by Home already exists in the existing response:
- `GET /api/trips` (`backend/routes/trips.py::list_trips`) returns the full trip documents for the
  user (`db.trips.find({"user_ids": user["id"]}, {"_id": 0})`), which **already includes** `members[]`.
  The current dashboard simply ignores that field; this step starts reading it. No new endpoint, no
  query change, no projection change.
- `GET /api/trips/{trip_id}` already returns `members[]` and is already consumed by the Detail screen.

The only required backend action is **regression verification** — run `pytest` to confirm nothing in
the existing suite regresses (this is a frontend-only change, so the suite must stay fully green).

## App Screens & UI (Expo React Native)
- **Create:** None (a pure shared helper module and its unit test are added under `frontend/src/` —
  see *Files to create*; neither is a screen/route).
- **Modify:**
  - `frontend/app/trip/[id]/index.tsx` (Detail):
    - Replace the existing header subtitle line `{totalPeople} people · {N} members` with the
      canonical composition string from `compositionLabel(trip.members)` →
      e.g. `13 Individuals across 4 Families & 2 Singles`. Keep the existing `people` Ionicon and the
      `colors.primaryText` styling.
    - Swap the hardcoded `rgba(255,255,255,0.15)` on the `codeChip` style for the new theme-aware
      `colors.overlayOnPrimary` token (fixes the chip being near-invisible / wrong on the light-teal
      dark-mode primary card).
    - Replace the inline `paddingBottom: 120` on the `ScrollView` content container with
      `LAYOUT.scrollBottomInset`, and the inline tab-label `fontSize: 12` with the shared control/label
      sizing already centralized (use `T variant="caption"` styling rather than a raw inline size).
  - `frontend/app/(tabs)/dashboard.tsx` (Home):
    - Widen the local `Trip` type to include `members: Member[]` (already returned by `/trips`).
    - On each recent-trip card, add a second caption line under the existing
      `{travel_date} · {currency} · Code {code}` line rendering `compositionLabel(t.members)`.
    - Replace `paddingBottom: 120` with `LAYOUT.scrollBottomInset`.
  - `frontend/app/(tabs)/trips.tsx` (Trips tab — decision: include for visual consistency with Home,
    since the cards are near-identical):
    - Widen the local `Trip` type to include `members: Member[]` and render `compositionLabel(t.members)`
      as a caption line on each trip card.
    - Replace `paddingBottom: 120` with `LAYOUT.scrollBottomInset`.
  - `frontend/app/(tabs)/reports.tsx`, `frontend/app/(tabs)/add.tsx`,
    `frontend/app/trip/[id]/category/[name].tsx`, `frontend/app/trip/[id]/settle-up.tsx`:
    - Replace the duplicated `paddingBottom: 120` scroll inset with `LAYOUT.scrollBottomInset`. No
      other behavioural change.
  - **Form screens** (`(auth)/login.tsx`, `(auth)/register.tsx`, `(auth)/forgot.tsx`,
    `(auth)/reset.tsx`, `(auth)/pin-login.tsx`, `create-trip.tsx`, `join-trip.tsx`,
    `trip/[id]/add-expense.tsx`, `trip/[id]/edit-expense.tsx`, `trip/[id]/add-member.tsx`,
    `trip/[id]/edit-member.tsx`, `trip/[id]/edit.tsx`):
    - Replace the repeated literal `input` StyleSheet block
      (`paddingHorizontal: SPACING.md, paddingVertical: 14, borderRadius: RADIUS.md, borderWidth: 1,
      fontSize: 16`) so its magic numbers come from the new shared `CONTROL` token
      (`CONTROL.paddingY`, `CONTROL.fontSize`, `CONTROL.radius`). Screen-specific extras (e.g. PIN
      `letterSpacing`, the large amount input `fontSize: 44`) stay as-is — only the shared base metrics
      are tokenized. This is a mechanical, render-identical refactor.

## State & API Integration
No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`. Home already
calls `api<Trip[]>('/trips')` and Detail already calls `api<Trip>('/trips/{id}')`; both responses
already contain `members[]`. The only state change is widening the dashboard's local `Trip` TypeScript
type to include the `members` field it already receives.

## Files to change
- `frontend/src/theme.ts` — add the `LAYOUT` token (`screenPadding`, `scrollBottomInset`), the
  `CONTROL` token (shared form-input metrics: `paddingY`, `fontSize`, `radius`), and a theme-aware
  `overlayOnPrimary` color in **both** the `light` and `dark` schemes.
- `frontend/app/trip/[id]/index.tsx` — composition string in header; `overlayOnPrimary` chip;
  `LAYOUT.scrollBottomInset`; tokenized tab label.
- `frontend/app/(tabs)/dashboard.tsx` — widen `Trip` type; composition string on trip cards;
  `LAYOUT.scrollBottomInset`.
- `frontend/app/(tabs)/trips.tsx` — widen `Trip` type; composition string on trip cards;
  `LAYOUT.scrollBottomInset`.
- `frontend/app/(tabs)/reports.tsx` — `LAYOUT.scrollBottomInset`.
- `frontend/app/(tabs)/add.tsx` — `LAYOUT.scrollBottomInset`.
- `frontend/app/trip/[id]/category/[name].tsx` — `LAYOUT.scrollBottomInset`.
- `frontend/app/trip/[id]/settle-up.tsx` — `LAYOUT.scrollBottomInset`.
- `frontend/app/(auth)/login.tsx`, `frontend/app/(auth)/register.tsx`,
  `frontend/app/(auth)/forgot.tsx`, `frontend/app/(auth)/reset.tsx`,
  `frontend/app/(auth)/pin-login.tsx`, `frontend/app/create-trip.tsx`,
  `frontend/app/join-trip.tsx`, `frontend/app/trip/[id]/add-expense.tsx`,
  `frontend/app/trip/[id]/edit-expense.tsx`, `frontend/app/trip/[id]/add-member.tsx`,
  `frontend/app/trip/[id]/edit-member.tsx`, `frontend/app/trip/[id]/edit.tsx` — tokenize the shared
  `input` style via `CONTROL`.
- `CLAUDE.md` — after the work is tested and committed, flip Roadmap **Step 18** from `- [ ]` to
  `- [x]`.

## Files to create
- `frontend/src/composition.ts` — a pure, theme-agnostic helper. Exports:
  - `tripComposition(members)` → `{ individuals, families, singles }` where `families` = count of
    `kind === 'family'`, `singles` = count of `kind === 'individual'`, and `individuals` =
    `Σ max(1, family_members.length)` over families **plus** one per single (the total-human count of
    Section 5). The `max(1, …)` guard matches the existing `totalPeople` logic in Detail so an empty
    family still counts as one human.
  - `compositionLabel(members)` → a string of the form `"{X} Individuals across {Y} Families & {Z}
    Singles"` with grammatical singular/plural for each segment. **Decision: empty segments are
    omitted** — a families-only trip reads `"8 Individuals across 2 Families"` (no `& 0 Singles`), and
    a trip with no families reads just `"{X} Individuals"` (the breakdown would only restate the human
    count). An empty trip reads `"0 Individuals"`.
- `frontend/src/__tests__/composition.test.ts` — jest unit tests covering: the Section 5 worked
  example (families sized 4,4,2,1 + 2 singles → `13 Individuals across 4 Families & 2 Singles`),
  singular pluralization (`1 Individual across 1 Family`, `... & 1 Single`), the omit-zero cases
  (families-only → no `& 0 Singles`; singles-only → `N Individuals`), an empty trip (`0 Individuals`),
  a family with an empty `family_members` array (counts as 1 human), and `null`/`undefined` members.
- `.claude/specs/18-layout-ui-standardization.md` — this spec document.

## New Dependencies
No new dependencies. The composition helper is pure TypeScript; the unit test reuses the existing
`jest` / `jest-expo` setup added in Step 17. No new runtime, dev, or backend packages.

## Rules for Implementation
- **Composition math must follow Section 5 of `CLAUDE.md` exactly.** `X` (Individuals) is the total
  number of human beings = `Σ family sizes + number of singles`; `Y` = number of families; `Z` =
  number of singles. Do **not** conflate "Individuals" with "members/entities". An empty family counts
  as one human (`max(1, len)`), consistent with the existing `totalPeople` computation.
- This step is **presentation-only**. It must **not** change how expenses are split, how balances are
  computed, or anything about the `PER_CAPITA` vs `PER_FAMILY` dual split-mode logic (Section 5). No
  edits to settlement/calculator code.
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) remain intact — no
  backend edits are expected at all.
- Enforce RBAC unchanged: this step touches no destructive edit/delete path, so the Step 10/11/17
  guards must remain exactly as they are.
- Follow the frontend design-system tokens and support dynamic light/dark mode via `ThemeContext`:
  read colors from `useTheme()` and never reintroduce raw hex/rgba in screen code — the new
  `overlayOnPrimary` token must be defined per scheme so the chip is correct in **both** modes.
- Token refactors must be **render-identical** where no fix is intended: `LAYOUT.scrollBottomInset`
  must equal the current `120`, and `CONTROL` must equal the current `14` / `16` / `RADIUS.md` so the
  form screens look pixel-identical after the sweep. The only deliberate visual change is the dark-mode
  code-chip color and the new composition strings.
- Keep changes strictly scoped to Step 18. Do **not** start Step 19 (move `LogoutButton` into a
  universal header via `_layout.tsx` `screenOptions`) or Step 20 (image picker / media library). Do
  not restructure routing or refactor unrelated logic.

## Definition of Done
- [ ] `frontend/src/composition.ts` exists exporting pure `tripComposition` and `compositionLabel`,
      with no imports from React/theme (theme-agnostic, unit-testable).
- [ ] **Detail header:** `frontend/app/trip/[id]/index.tsx` renders the composition string in the trip
      header (replacing the old `N people · M members` line). For a trip with families sized 4,4,2,1 and
      2 standalone individuals it reads exactly `13 Individuals across 4 Families & 2 Singles`.
- [ ] **Home + Trips cards:** `frontend/app/(tabs)/dashboard.tsx` and `frontend/app/(tabs)/trips.tsx`
      show the same composition string under each trip card, computed from the `members[]` already
      returned by `GET /api/trips` (no new API call), and both local `Trip` types include `members`.
- [ ] **Pluralization & edges (omit-zero):** singular forms at count 1 (`1 Individual across 1
      Family`); a families-only trip omits the singles segment (`8 Individuals across 2 Families`); a
      singles-only trip reads `3 Individuals`; an empty trip reads `0 Individuals`; an
      empty-`family_members` family counts as one human.
- [ ] **Token centralization:** `frontend/src/theme.ts` exports `LAYOUT` (with
      `scrollBottomInset === 120`) and `CONTROL` (with `paddingY === 14`, `fontSize === 16`,
      `radius === RADIUS.md`); every former `paddingBottom: 120` literal across the 7 scroll screens and
      every duplicated `input` style block across the form screens now references these tokens, and the
      screens render pixel-identically to before.
- [ ] **Color token:** `overlayOnPrimary` is defined for both `light` and `dark` schemes and the trip
      header code chip uses it; there is no remaining hardcoded `rgba(255,255,255,0.15)` in
      `trip/[id]/index.tsx`. The chip is clearly visible on the primary header card in **both** light
      and dark mode (toggle theme from Profile to verify).
- [ ] **Unit tests:** `cd frontend && yarn test` runs `src/__tests__/composition.test.ts` and the full
      matrix (Section 5 example, singular forms, empty trip, empty-family, null/undefined input) passes.
- [ ] `cd frontend && yarn lint` passes for all changed/created files.
- [ ] `cd backend && pytest` passes with no regressions (frontend-only change; the suite must stay
      fully green).
- [ ] `CLAUDE.md` Roadmap **Step 18** checkbox is flipped to `- [x]` in the implementation commit.
