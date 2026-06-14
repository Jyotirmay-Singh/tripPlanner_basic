# Spec: Realize Per-Family Mode Math  (Step 07)

## Overview
This step delivers **Phase 2, Step 7 — "Realize Per-Family Mode Math"** from the `CLAUDE.md`
Roadmap: implement the complete, isolated, well-tested **entity-based division (`PER_FAMILY`)**
specified in Section 5(B) of `CLAUDE.md`. Today `backend/utils/balances.py::_compute_balances`
branches on `e["split_mode"]`, but the `PER_FAMILY` arm runs an **interim** weight-based loop (left
in place by Step 6) that divides by the *sum of member weights* — i.e. it still computes per-capita
math, which is **wrong** for per-family. Section 5(B) requires dividing by the **count of root
entities** (each selected family OR individual is exactly one entity, regardless of family size):
`E = (# selected families) + (# selected individuals)`, `C = amount / E`, and **every** entity owes
`C` flat. This step adds a pure `split_per_family` function to the existing
`backend/services/calculator.py` (created in Step 5, extended in Step 6), rewires the `PER_FAMILY`
branch of `_compute_balances` to call it, and removes the now-redundant interim `wt()` closure. The
`/balances`, `/settle`, and report response shapes are **unchanged**; only the numeric result for
`PER_FAMILY` expenses changes (to the correct Section 5B values).

## Depends on
- **Step 4 — Dual Split Mode Enums** (done): `split_mode` (`PER_CAPITA` | `PER_FAMILY`) persists on
  every expense and defaults to `PER_CAPITA`.
- **Step 5 — Isolate Mathematical Layer** (done): `backend/services/calculator.py` exists as a pure,
  dependency-free module; `_compute_balances` already imports from it.
- **Step 6 — Realize Per-Capita Mode Math** (done): created the explicit `split_mode` branch in
  `_compute_balances` and the `resolve_weights` / `split_per_capita` pure functions plus
  `tests/test_per_capita.py`. This step fills in the *other* branch of that seam.
- This step does **not** depend on Steps 8–20. Step 8 (retroactive re-allocation) and Step 9 (XLSX
  export) build on top of the now-complete dual-mode math.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. `split_mode` already persists on Expense documents/Pydantic models (Step 4),
and `PER_FAMILY` is already an accepted literal. No new fields, no new collections, no new indexes.
UUID `id` documents and `{"_id": 0}` projections are untouched. Note: `weight_snapshots` is **not**
consulted in `PER_FAMILY` math (family size is irrelevant to entity counting) — the field stays on
the model for the `PER_CAPITA` path and Step 8, but the per-family branch ignores it.

## Backend API & Services (FastAPI)

### New pure function — `backend/services/calculator.py`
Pure and synchronous (no `async`, no Motor/`database`, no FastAPI, no I/O), matching the existing
`minimize_transfers` / `split_per_capita` contracts so it stays unit-testable without a server.

- `split_per_family(amount: float, member_ids: list) -> dict`
  - Implements Section 5(B): `E = number of distinct selected entities`; `per_entity = amount / E`.
    Each selected entity (a family **or** an individual) owes `per_entity` **flat**, regardless of
    family size.
  - **Returns** `member_id -> share owed` (one non-negative float share per participating entity),
    mirroring `split_per_capita`'s return shape so the orchestrator treats both modes identically.
  - **De-duplicates** `member_ids` (preserving order) so a member id repeated in `split_member_ids`
    still counts as one entity and never inflates `E` or appears twice in the result.
  - **No intermediate rounding.** Shares are exact floats so `sum(shares) == amount` (within float
    epsilon); the existing single final `round(net, 2)` in `_compute_balances` remains the only
    rounding, preserving the balanced-ledger invariant (`sum(net) ≈ 0`).
  - **Family size and `weight_snapshots` are intentionally NOT used** — per-family math is purely a
    head-count of entities. This is the defining difference from `split_per_capita`.
  - **Edge cases:** empty `member_ids` → `{}` (caller skips the expense, matching the existing
    `if not shares: continue`); `E <= 0` → `{}`.

### Changed orchestrator — `backend/utils/balances.py::_compute_balances`
- Keep all current responsibilities: load trip with `{"_id": 0}`, seed `net`/`weight_map`, read
  expenses (`kind == "expense"`) with `{"_id": 0}`, apply settlements, `round(net, 2)` every entry,
  call `minimize_transfers(net)`, and return the **unchanged** shape
  `{net, transfers, members, currency, per_person}`.
- **Replace the interim `PER_FAMILY` branch** (the inline `wt()` closure + `total_weight` /
  `per_unit` loop) with:
  - `shares = split_per_family(e["amount"], split_ids)`; `if not shares: continue`; subtract each
    share from `net`; credit `net[paid_by_member_id] += e["amount"]`.
  - This is structurally identical to the `PER_CAPITA` arm (build `shares`, skip if empty, debit
    participants, credit payer) — only the share computation differs.
- The `PER_CAPITA` branch (`resolve_weights` + `split_per_capita`) is **untouched**.
- `split_ids` empty still means "split among all members" (`[m["id"] for m in members]`), unchanged.
- Import `split_per_family` alongside the existing `minimize_transfers, resolve_weights,
  split_per_capita` import.

### Routes & RBAC
No route signatures change. `GET /api/trips/{trip_id}/balances`, `POST /api/trips/{trip_id}/settle`,
`GET /api/trips/{trip_id}/report`, and the XLSX report keep calling `_compute_balances` unchanged.
Existing `_trip_or_404` membership enforcement stays as-is; **no new RBAC** is introduced
(creator/admin edit-protection is Step 10).

## App Screens & UI (Expo React Native)
- **Create:** None.
- **Modify:** None. This is backend-internal math; the `/balances` and report response shapes are
  identical, so dashboard, settle-up, reports, and category drill-down screens need no changes. The
  user-facing split-mode selector with live split-preview sub-labels is Step 16.

## State & API Integration
No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`. The API
contract (endpoints, request bodies, response shape) is unchanged; only the computed numbers for
expenses already stored as `PER_FAMILY` differ.

## Files to change
- `backend/services/calculator.py` — add the pure `split_per_family(amount, member_ids)` function
  next to `minimize_transfers`, `resolve_weights`, and `split_per_capita`.
- `backend/utils/balances.py` — replace the interim `PER_FAMILY` branch with `split_per_family`;
  remove the now-dead inline `wt()` closure / `total_weight` / `per_unit` code; add
  `split_per_family` to the `services.calculator` import.
- `CLAUDE.md` — after the work is tested and committed, flip Roadmap Step 7 from `- [ ]` to `- [x]`.

## Files to create
- `backend/tests/test_per_family.py` — **pure unit tests** (`from services.calculator import
  split_per_family`); no HTTP, no server, no `conftest.py` fixtures, mirroring `test_per_capita.py`.
- `.claude/specs/07-per-family-math.md` — this spec document.

## New Dependencies
No new dependencies (Python or frontend).

## Rules for Implementation
- Respect the strict dual split-mode logic in Section 5 of `CLAUDE.md`. Implement **only**
  `PER_FAMILY` (Section 5B) in this step; do **not** alter the `PER_CAPITA` (Section 5A) path
  shipped in Step 6.
- `PER_FAMILY` divides by the **count of entities**, NOT by summed weights/humans. Each selected
  family and each selected individual owes an **equal flat share** `amount / E`, regardless of
  family size. Family size and `weight_snapshots` must be ignored on this path.
- `split_per_family` MUST be pure: no `async`, no Motor/`database` import, no FastAPI, no network/DB
  I/O — operate only on plain dicts/lists, exactly like `split_per_capita` / `minimize_transfers`.
- No new intermediate rounding: shares stay exact floats and the single final `round(net, 2)` in
  `_compute_balances` remains the only rounding. Do not alter the balanced-ledger invariant
  (`sum(net) ≈ 0`).
- App-User identity mapping (Section 5): an app user who has joined a family is part of that
  family's single entity, NOT a separate individual entity; per-family counting must treat the
  family as one entity and must not add the folded-in app user as an extra entity. (In practice the
  family's member id is the one present in `split_member_ids`.)
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) must remain intact;
  no switch to ObjectIds.
- Keep/maintain existing RBAC: `_trip_or_404` on balance/settle/report routes stays as-is. Add no
  access control in this step.
- Follow frontend design-system tokens and dynamic light/dark `ThemeContext` for any UI — but this
  step ships **no** frontend changes.
- Keep changes strictly scoped to this step; do not touch the settlement algorithm, the reports
  pipeline, the `per_person` breakdown, the `PER_CAPITA` path, or any unrelated code.

## Definition of Done
- [ ] `backend/services/calculator.py` defines pure `split_per_family(amount, member_ids)` with no
      imports from `database`, `routes`, `utils`, FastAPI, or Motor; `from services.calculator
      import split_per_family` succeeds when run from `backend/`.
- [ ] `_compute_balances`'s `PER_FAMILY` branch now calls `split_per_family(e["amount"], split_ids)`,
      skips when shares are empty, debits each entity, credits the payer, and no longer contains the
      interim `wt()` / `total_weight` / `per_unit` code. The returned shape
      (`{net, transfers, members, currency, per_person}`) is unchanged.
- [ ] New `backend/tests/test_per_family.py` (pure, server-free) covers, at minimum:
      - the Section 5(B) example — 4 families + 2 individuals = 6 entities, a 120 expense → C = 20;
        **every** entity owes exactly 20 regardless of family size; `sum(shares) == 120`;
      - a per-capita-vs-per-family contrast: the same selection where a large family and a single
        individual owe the **same** flat per-family share (proving size is ignored);
      - empty `member_ids` → `{}`;
      - a single entity owes the full amount;
      - non-divisible remainder (e.g. `100 / 3` entities) where `sum(shares)` equals `amount` within
        `1e-9` and no intermediate rounding occurs;
      - duplicate ids in `member_ids` collapse to one entity (correct `E`, single result entry);
      - `weight_snapshots` / family size have **no** effect on the per-family result.
- [ ] No regression in the integration suite: `PER_CAPITA` balances are byte-for-byte unchanged;
      `test_split_mode.py`, `test_balances_reports.py`, `test_expenses.py`, and
      `test_calculator.py` / `test_per_capita.py` still pass.
- [ ] `cd backend && pytest` is green across the whole suite (including the new
      `tests/test_per_family.py`).
- [ ] `CLAUDE.md` Roadmap Step 7 checkbox flipped to `- [x]` in the implementation commit.
