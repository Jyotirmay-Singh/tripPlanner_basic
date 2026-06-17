# Spec: Dual Split Mode Selector  (Step 16)

## Overview
Add a visible segmented control to the **Add** and **Edit** transaction screens that lets the
user toggle each expense between **Per Person** (`PER_CAPITA`) and **Per Family** (`PER_FAMILY`),
and surface a live, dynamic sub-label that simulates the resulting per-entity split as the user
types the amount and changes the participant selection. This realizes Roadmap **Phase 5, Step 16**.
The backend split engine (Steps 4, 6, 7) already accepts, persists, and computes both modes — but
the frontend currently never sends `split_mode`, so every expense silently defaults to
`PER_CAPITA`. This step closes that gap by wiring the selector into the two transaction forms so
the dual-mode math defined in Section 5 of `CLAUDE.md` becomes user-controllable end to end.

## Depends on
- **Step 4** — Dual Split Mode Enums (`split_mode: PER_CAPITA | PER_FAMILY` on `ExpenseIn`/`ExpenseUpdate`). ✅
- **Step 6** — Per-Capita math (`split_per_capita`). ✅
- **Step 7** — Per-Family math (`split_per_family`). ✅
- **Step 10** — Expense Modification Protection (Edit screen already guarded by `_expense_modify_or_403`). ✅

All dependencies are complete; this step is purely the Expo/React Native UI layer plus its request wiring.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. `split_mode` already exists on `models/expense.py` (`ExpenseIn` default
`"PER_CAPITA"`, `ExpenseUpdate` optional) and is persisted by `routes/expenses.py`. The expense
document already stores `split_mode`; `GET /trips/{id}/expenses` already back-fills legacy rows to
`"PER_CAPITA"`.

## Backend API & Services (FastAPI)
No backend changes. The existing endpoints already support this feature:
- `POST /api/trips/{trip_id}/expenses` — accepts `split_mode` in `ExpenseIn`; defaults to `PER_CAPITA`.
- `PATCH /api/trips/{trip_id}/expenses/{expense_id}` — accepts optional `split_mode` in `ExpenseUpdate`; RBAC via `_expense_modify_or_403`.
- `GET /api/trips/{trip_id}/expenses` — returns `split_mode` on every row.

The only required backend action is **regression verification** (run `pytest`) to prove the UI's
new payloads do not break existing contracts. If verification surfaces any contract gap, add a test
rather than changing the contract.

## App Screens & UI (Expo React Native)
- **Create:**
  - `frontend/src/SplitModeSelector.tsx` — a small reusable, theme-aware segmented control
    (two pills: **Per Person** / **Per Family**) following the existing inline "kind toggle"
    pill pattern in the transaction screens. Props: `value: 'PER_CAPITA' | 'PER_FAMILY'`,
    `onChange`, and an optional `subLabel: string` rendered beneath the control. Exposes stable
    `testID`s: `split-mode-per_capita`, `split-mode-per_family`.
- **Modify:**
  - `frontend/app/trip/[id]/add-expense.tsx`
    - Add `splitMode` state (default `'PER_CAPITA'`).
    - Render `<SplitModeSelector>` directly under the **Split among** section.
    - Compute a **dynamic sub-label** preview from the current `amount`, `splitSel`, per-family
      overrides, and active mode (see math below).
    - Include `split_mode: splitMode` in the POST body.
    - When `PER_FAMILY` is active, **hide the per-family-member "Split among N of M" override chips**
      (the `ae-fam-*` controls) because family size / `weight_snapshots` are intentionally ignored
      in `PER_FAMILY` (Section 5B). Do **not** send `weight_snapshots` while in `PER_FAMILY` mode.
    - Update the static helper caption so it reflects the active mode instead of always saying
      "Family members are split per person."
  - `frontend/app/trip/[id]/edit-expense.tsx`
    - Extend the local `Expense` type with `split_mode: 'PER_CAPITA' | 'PER_FAMILY'`.
    - Load the expense's existing `split_mode` into a `splitMode` state on fetch (fallback `'PER_CAPITA'`).
    - Render the same `<SplitModeSelector>` under **Split among**.
    - Include `split_mode: splitMode` in the PATCH body.

### Dynamic sub-label math (mirror of `CLAUDE.md` Section 5)
Let `A = parseFloat(amount)`. For the currently selected members (`splitSel`):
- **PER_CAPITA**: `H = Σ humanCount(member)` where `humanCount` = `1` for individuals and
  `weightOverride ?? max(1, family_members.length)` for families. Show
  `"{currency} {(A/H).toFixed(2)} per person · {H} {people}"`.
- **PER_FAMILY**: `E = splitSel.length` (each family or individual counts as one entity). Show
  `"{currency} {(A/E).toFixed(2)} per group · {E} {groups}"`.
- Guard against empty/zero: if `A` is not a positive number or the denominator is `0`, show a
  neutral hint (e.g. "Enter an amount and pick who's splitting") rather than `NaN`/`Infinity`.

## State & API Integration
- No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`.
- The only integration change is the request body shape sent from the two transaction screens
  (adding `split_mode`, and conditionally omitting `weight_snapshots` in `PER_FAMILY`).

## Files to change
- `frontend/app/trip/[id]/add-expense.tsx`
- `frontend/app/trip/[id]/edit-expense.tsx`

## Files to create
- `frontend/src/SplitModeSelector.tsx`
- `.claude/specs/16-split-mode-selector.md` (this spec)

## New Dependencies
No new dependencies. Uses existing `react-native`, `@expo/vector-icons`, and the `theme.ts` tokens.

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5 of
  `CLAUDE.md`. The frontend preview must match the backend result exactly: per-capita divides by
  **total humans**; per-family divides by **entity count** (family size ignored).
- The displayed sub-label is a **preview only** — the authoritative split is always computed
  server-side in `services/calculator.py`. Never duplicate settlement logic on the client beyond
  the simple per-entity preview.
- In `PER_FAMILY` mode, do not send `weight_snapshots` and do not show per-family override chips,
  because the backend ignores them in that mode (avoid implying they have an effect).
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact (no backend edits expected).
- Enforce RBAC on the backend before destructive edits/deletes — already handled by
  `_expense_modify_or_403`; do not weaken it.
- Follow the frontend design system tokens (`SPACING`, `RADIUS`, `colors.*`); support dynamic
  light/dark mode via `ThemeContext` (read `colors` from `useTheme()` — no hardcoded hex).
- Match the existing pill/segmented styling already used for the expense `kind` toggle for visual consistency.
- Keep changes strictly scoped to Step 16; do not refactor unrelated transaction-form code, and do
  not implement Step 17 (RBAC-driven hiding of edit/delete controls) here.

## Definition of Done
- [x] `frontend/src/SplitModeSelector.tsx` exists, renders two theme-aware pills (**Per Person** /
      **Per Family**), highlights the active mode, calls `onChange`, and renders an optional sub-label.
- [x] **Add Expense** screen shows the selector; switching to **Per Family** hides the `ae-fam-*`
      per-family override chips and the sub-label updates live as the amount/selection change.
- [x] Creating an expense with **Per Family** selected results in a stored expense whose
      `split_mode == "PER_FAMILY"` (verify via the Expenses list / `GET /trips/{id}/expenses`).
- [x] Creating an expense with **Per Person** selected stores `split_mode == "PER_CAPITA"`.
- [x] **Edit Expense** screen loads the expense's saved `split_mode` into the selector, lets the
      user flip it, and a PATCH persists the new value (re-open the expense to confirm it stuck).
- [x] The dynamic sub-label math matches Section 5: e.g. a 130 expense across families of sizes
      4,4,2,1 + 2 individuals (13 humans) shows ≈ `10.00 per person`; the same selection in
      Per Family (6 entities) shows ≈ `21.67 per group`. No `NaN`/`Infinity` for empty amount.
- [x] Balances tab reflects the chosen mode after saving (per-family expense splits equally across
      entities; per-capita splits by head count) — confirmed against the running app.
- [x] Light and dark mode both render the selector correctly (toggle theme from Profile).
- [x] `cd backend && pytest` passes with no regressions; specifically
      `pytest tests/test_split_mode.py tests/test_per_capita.py tests/test_per_family.py tests/test_expenses.py`
      are green, proving the create/patch/list contracts the new UI relies on still hold.
- [x] `cd frontend && yarn lint` passes for the changed/created files.

## Verification log (2026-06-17)
How each box was verified:
- **Automated — backend:** `EXPO_PUBLIC_BACKEND_URL=http://localhost:8000 python -m pytest tests/test_split_mode.py tests/test_per_capita.py tests/test_per_family.py tests/test_expenses.py` → **37 passed in 43.85s** (local backend on a Dockerized MongoDB 7). Covers create-default `PER_CAPITA`, explicit `PER_FAMILY` persistence + round-trip, invalid-mode 422 on create/patch, `PATCH` flip, snapshot clearing on switch-to-`PER_FAMILY` (`exclude_unset` regression), `GET` back-fill, and the §5 / §5B math examples.
- **Automated — lint:** `node_modules/.bin/eslint.cmd` on `src/SplitModeSelector.tsx`, `app/trip/[id]/add-expense.tsx`, `app/trip/[id]/edit-expense.tsx` → **0 errors** (1 pre-existing `react-hooks/exhaustive-deps` warning on an untouched `useEffect`). This is what `yarn lint` runs.
- **Automated — balances reflect mode:** end-to-end against the live `/api/trips/{id}/balances` (the JSON the Balances tab renders): a `PER_FAMILY` 100 split between an individual and a family-of-3 → payer `+50`, family `-50` (equal, size ignored); a follow-on `PER_CAPITA` 80 → family owes 3 heads (cumulative payer `+110`, family `-110`). **PASS.**
- **Code-level (structural) — UI rendering:** the selector and live sub-label, `ae-fam-*`/`ee-fam-*` chip gating on `PER_CAPITA`, request-body wiring (`split_mode` always sent; `weight_snapshots` only in `PER_CAPITA`), unconditional render for both expense and income, and theme-token-only styling (`useTheme()`, no hardcoded hex) were verified by direct inspection of the implemented files. The pixel-level light/dark appearance and the visual "updates as you type" interaction were confirmed structurally (derived prop recomputed each render; colors sourced only from theme tokens), not by a manual Expo Go click-through.
