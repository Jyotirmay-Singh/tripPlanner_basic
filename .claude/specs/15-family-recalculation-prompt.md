# Spec: Structural Recalculation Prompt  (Step 15)

## Overview
When a trip admin edits a member in a way that changes the member's **effective per-capita weight**
(growing/shrinking a family roster, or switching a member between `individual` and `family`), the app
must ask how that change should affect already-recorded `PER_CAPITA` expenses *before* saving. This
realizes **Step 15** of the Roadmap: attach a UI confirmation trigger on family-size adjustment saves
that prompts *"Apply updates retroactively to prior expenses or apply to future items only?"* and
fires the Phase 2 backend recalculation route (Step 8) with the chosen option. The backend
re-allocation engine and its `reweight_past` toggle are already complete and tested; this step
delivers the **frontend confirmation experience** that drives it, replacing the temporary native
`Alert` already in `edit-member.tsx` with a properly themed confirmation modal and a correct trigger.

## Depends on
- **Step 4** — `split_mode` enum (`PER_CAPITA` | `PER_FAMILY`) on expenses.
- **Step 6 / Step 7** — Per-capita and per-family calculation logic.
- **Step 8** — Retroactive Family Re-allocation Routine (`services/reallocation.py`,
  `run_member_update_with_reallocation`, and the `reweight_past` field on `MemberUpdate`). This is the
  backend route Step 15 fires.
- **Step 11** — Member administration RBAC (only trip admins reach the edit-member screen).
- **Step 13 / Step 14** — Join wizard and the admin Members tab (`manage-member.tsx` → `edit-member.tsx`),
  which provide the entry point where this prompt appears.

## Data Model Changes (MongoDB/Pydantic)
**No data model changes.** The backend contract already exists:
- `MemberUpdate.reweight_past: Optional[bool] = True` (`backend/models/member.py`).
- `PATCH /api/trips/{trip_id}/members/{member_id}` already consumes `reweight_past` and calls
  `run_member_update_with_reallocation` atomically.
- Expense documents already carry `weight_snapshots` and the backend-managed `weight_frozen` arrays
  used by the re-allocation engine. All UUID `id` conventions and `{"_id": 0}` projections are
  untouched by this step.

## Backend API & Services (FastAPI)
**No backend changes.** Step 15 is purely a frontend step that consumes the existing
`PATCH /api/trips/{trip_id}/members/{member_id}` endpoint with the `reweight_past` flag. The
semantics the frontend must honor:
- `reweight_past: true`  → **Apply retroactively**: past `PER_CAPITA` expenses are re-split at the
  new weight (size-freeze pins removed; partial-family overrides preserved).
- `reweight_past: false` → **Future items only**: past `PER_CAPITA` expenses are pinned (frozen) at
  the member's OLD weight; only expenses created after the edit use the new weight.

Existing backend tests that already cover this contract and must continue to pass:
`backend/tests/test_reallocation.py`, `backend/tests/test_reallocation_api.py`,
`backend/tests/test_member_rbac.py`.

## App Screens & UI (Expo React Native)
- **Create:** `frontend/src/ConfirmModal.tsx` — a small reusable, theme-aware confirmation modal
  component (built on RN `Modal`) that renders a title, a body message, and a vertical stack of
  action buttons (each with a label, optional `variant: 'primary' | 'default' | 'cancel'`, and an
  `onPress`). It must read all colors from `useTheme()` (`colors.surface`, `colors.border`,
  `colors.primary`, `colors.primaryText`, `colors.textMain`, `colors.textMuted`, overlay scrim) and
  use the shared `SPACING` / `RADIUS` tokens and the `T` typography component. This replaces the
  un-themeable native `Alert` for the recalculation decision.
- **Modify:** `frontend/app/trip/[id]/edit-member.tsx` —
  - Replace the existing native `Alert`-based "Apply to past expenses?" flow with the new
    `ConfirmModal`, using the exact required copy.
  - Broaden the trigger from "family_members length changed" to **any effective per-capita weight
    change** for a member that participates in at least one past `PER_CAPITA` expense. Effective
    weight = `family_members.length` when `kind === 'family'`, else `1`. This covers family grow,
    family shrink, `family → individual`, and `individual → family`.
  - Restrict the "has past expenses" check to `PER_CAPITA` expenses where the member is a
    participant (paid-by or in `split_member_ids`, including the empty `split_member_ids` =
    "split among all" case), since `PER_FAMILY` expenses are size-independent and recalc is a no-op.
  - The three modal actions map to: **Apply retroactively** → `save(true)`; **Future items only** →
    `save(false)`; **Cancel** → dismiss without saving. Name/email-only edits, or weight changes
    with no qualifying past expenses, save directly with `reweight_past: true` and no prompt.

## State & API Integration
- **`frontend/src/api.ts`** — no change; the existing `api()` PATCH wrapper already carries
  `reweight_past` in the JSON body.
- **Contexts** — no `AuthContext` / `ThemeContext` API changes; `ConfirmModal` *consumes*
  `ThemeContext` via the existing `useTheme()` hook.
- **AsyncStorage** — no caching changes.
- Local component state in `edit-member.tsx`: add modal-visibility state (and the computed
  old/new weight + change summary) so the modal can render the size delta (e.g. "2 → 4") in its body.

## Files to change
- `frontend/app/trip/[id]/edit-member.tsx` — swap native Alert for `ConfirmModal`; broaden trigger to
  any per-capita weight change; scope the past-expense check to `PER_CAPITA` participation.
- `CLAUDE.md` — flip Step 15 from `- [ ]` to `- [x]` after implementation is tested and committed.

## Files to create
- `frontend/src/ConfirmModal.tsx` — reusable theme-aware confirmation modal component.
- `.claude/specs/15-family-recalculation-prompt.md` — this spec.

## New Dependencies
**No new dependencies.** Uses React Native's built-in `Modal`, the existing `ThemeContext`,
`theme.ts` tokens, and the `T` component.

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) from Section 5 of
  `CLAUDE.md`: the prompt is only relevant to `PER_CAPITA` expenses; `PER_FAMILY` is size-independent,
  so a weight change with only `PER_FAMILY` past expenses must **not** prompt.
- Map the user's choice correctly: **Apply retroactively** = `reweight_past: true`, **Future items
  only** = `reweight_past: false`. Do not invert these.
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact (backend
  untouched).
- RBAC: rely on the existing server-side admin enforcement on `PATCH .../members/{id}`
  (`_trip_admin_or_403`); the screen is already admin-gated by Step 14. Do not weaken it.
- Follow the frontend design system tokens and support dynamic light/dark mode via `ThemeContext`
  in the new modal — no hard-coded colors.
- Preserve existing `testID`s on the edit-member screen (`em-name`, `em-family`, `em-email`,
  `em-save`, `em-delete`) and add stable `testID`s for the modal and its three actions
  (e.g. `recalc-modal`, `recalc-retro`, `recalc-future`, `recalc-cancel`).
- Keep changes strictly scoped to this step; do not refactor unrelated screens or the backend.

## Definition of Done
- [ ] `frontend/src/ConfirmModal.tsx` exists, reads exclusively from `useTheme()`/`SPACING`/`RADIUS`,
      and renders correctly in both light and dark mode.
- [ ] Editing a family in `edit-member.tsx` and **changing its size** (e.g. 2 → 4) when it has past
      `PER_CAPITA` expenses opens the themed modal with the required copy: title "Apply to past
      expenses?" and a body asking whether to apply updates retroactively to prior expenses or apply
      to future items only, showing the size delta.
- [ ] Switching a member's kind in a way that changes weight (`family → individual` or
      `individual → family`) with qualifying past `PER_CAPITA` expenses also opens the modal.
- [ ] Tapping **Apply retroactively** sends `reweight_past: true`; verify in the running app that a
      past per-capita expense's split is recalculated at the new size (balances change accordingly).
- [ ] Tapping **Future items only** sends `reweight_past: false`; verify the past expense's split is
      unchanged while a newly added expense uses the new size.
- [ ] Tapping **Cancel** dismisses the modal and performs no PATCH (member unchanged).
- [ ] Name/email-only edits, and weight changes against a member with no qualifying past
      `PER_CAPITA` expenses, save directly with **no** prompt.
- [ ] `cd frontend && yarn lint` passes with no new errors.
- [ ] `cd backend && pytest` passes fully — confirming the unchanged backend re-allocation contract
      (`test_reallocation.py`, `test_reallocation_api.py`, `test_member_rbac.py`) still holds.
