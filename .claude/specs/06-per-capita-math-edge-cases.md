# Spec: Per-Capita Math Calculation (Including Edge Cases)  (Step 06)

## Overview
This step delivers **Phase 2, Step 6 — "Realize Per-Capita Mode Math"** from the `CLAUDE.md`
Roadmap: implement the complete, isolated, well-tested **human-count division (`PER_CAPITA`)**
specified in Section 5(A) of `CLAUDE.md`. Today `backend/utils/balances.py::_compute_balances`
runs a single weight-based loop for *every* expense and never branches on the persisted
`split_mode`. That loop coincidentally computes per-capita-style shares, but the math is inlined,
not unit-testable in isolation, and does not formally distinguish `PER_CAPITA` from `PER_FAMILY`.
This step extracts the per-capita division into pure functions in the existing
`backend/services/calculator.py` (created in Step 5), makes `_compute_balances` **explicitly
branch** on `e["split_mode"]` so `PER_CAPITA` runs through the new functions, and hardens the
behavior against the full set of edge cases (empty split lists, families of size 0, partial-family
`weight_snapshots` overrides, unknown/stale member ids, non-divisible remainders, all-zero weights,
single-member trips, and the App-User-folded-into-a-family identity mapping). `PER_FAMILY` is left
on its current interim behavior — Step 7 replaces that branch — so this change is numerically
**identical** for existing `PER_CAPITA` data and introduces **no** API contract change.

## Depends on
- **Step 4 — Dual Split Mode Enums** (done): `split_mode` (`PER_CAPITA` | `PER_FAMILY`) already
  persists on every expense and defaults to `PER_CAPITA`; `weight_snapshots` already persists.
- **Step 5 — Isolate Mathematical Layer** (done): `backend/services/calculator.py` exists as a
  pure, dependency-free module and `_compute_balances` already imports `minimize_transfers` from it.
  This step adds the per-capita division alongside `minimize_transfers` in the same module.
- This step does **not** depend on Steps 7–20. Step 7 (`PER_FAMILY` math) and Step 8 (retroactive
  re-allocation) build on the seam created here.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. `split_mode` and `weight_snapshots` already exist on the Expense
documents/Pydantic models (Step 4). No new fields, no new collections, no new indexes. UUID `id`
documents and `{"_id": 0}` projections are untouched.

## Backend API & Services (FastAPI)

### New pure functions — `backend/services/calculator.py`
Both functions are pure and synchronous (no `async`, no Motor/`database`, no FastAPI, no I/O),
matching the existing `minimize_transfers` contract so they remain unit-testable without a server.

- `resolve_weights(split_ids: list[str], base_weights: dict[str, int], snapshots: dict | None = None) -> dict[str, int]`
  - Builds the effective per-member human-count weights for one expense.
  - For each `sid` in `split_ids`: if `sid` is present in `snapshots`, use `int(snapshots[sid])`
    (the per-transaction partial-family override); otherwise use `base_weights.get(sid, 1)`
    (unknown/stale ids safely default to `1`, preserving today's `wt()` behavior).
  - This is the pure extraction of the inline `wt()` closure currently inside `_compute_balances`.

- `split_per_capita(amount: float, weights: dict[str, int]) -> dict[str, float]`
  - Implements Section 5(A): `H = sum(weights.values())` (total humans). `per_human = amount / H`.
    Each member owes `per_human * weight`.
  - **Returns** `member_id -> share owed` (a non-negative float share per participating member).
  - **No intermediate rounding.** Shares are exact floats so `sum(shares) == amount` (within float
    epsilon); the existing single final `round(..., 2)` of `net` in `_compute_balances` is the only
    rounding, preserving today's balanced-ledger invariant (`sum(net) ≈ 0`).
  - **Edge cases:** empty `weights` → `{}`; total humans `H <= 0` → `{}` (caller skips the expense,
    matching today's `if total_weight == 0: continue`).

### Changed orchestrator — `backend/utils/balances.py::_compute_balances`
- Keep all current responsibilities: load trip with `{"_id": 0}`, seed `net`/`weight_map`, read
  expenses (`kind == "expense"`) with `{"_id": 0}`, apply settlements, `round(..., 2)` every `net`
  entry, call `minimize_transfers(net)`, and return the **unchanged** shape
  `{net, transfers, members, currency, per_person}`.
- **Branch the expense loop on `e.get("split_mode", "PER_CAPITA")`:**
  - `PER_CAPITA`: `weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"))`;
    `shares = split_per_capita(e["amount"], weights)`; subtract each share from `net`; credit
    `net[paid_by_member_id] += e["amount"]`. Skip when `shares` is empty.
  - `PER_FAMILY`: **interim only** — retain the current weight-based computation behind a clear
    comment marking it as deferred to **Step 7**. This keeps numbers unchanged for existing data
    until Step 7 implements true entity-based division. (Do not implement Section 5(B) here.)
- `split_ids` empty still means "split among all members" (`[m["id"] for m in members]`),
  unchanged from today.

### Routes & RBAC
No route signatures change. `GET /api/trips/{trip_id}/balances`, `POST /api/trips/{trip_id}/settle`,
`GET /api/trips/{trip_id}/report`, and the XLSX report all keep calling `_compute_balances`
unchanged. Existing `_trip_or_404` membership enforcement stays as-is; **no new RBAC** is introduced
(creator/admin edit-protection is Step 10).

## App Screens & UI (Expo React Native)
- **Create:** None.
- **Modify:** None. This is backend-internal math; the `/balances` and report response shapes are
  identical, so dashboard, settle-up, reports, and category drill-down screens need no changes. The
  user-facing split-mode selector is Step 16.

## State & API Integration
No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`. The API
contract is byte-for-byte unchanged.

## Files to change
- `backend/services/calculator.py` — add the pure `resolve_weights` and `split_per_capita`
  functions next to the existing `minimize_transfers`.
- `backend/utils/balances.py` — branch `_compute_balances` on `split_mode`; route `PER_CAPITA`
  through `resolve_weights` + `split_per_capita`; keep `PER_FAMILY` as a clearly-commented Step 7
  interim. Remove the now-redundant inline `wt()` closure for the `PER_CAPITA` path.
- `CLAUDE.md` — after the work is tested and committed, flip Roadmap Step 6 from `- [ ]` to `- [x]`.

## Files to create
- `backend/tests/test_per_capita.py` — **pure unit tests** (`from services.calculator import
  resolve_weights, split_per_capita`); no HTTP, no server, no `conftest.py` fixtures.
- `.claude/specs/06-per-capita-math-edge-cases.md` — this spec document.

## New Dependencies
No new dependencies (Python or frontend).

## Rules for Implementation
- Respect the strict dual split-mode logic in Section 5 of `CLAUDE.md`. Implement **only**
  `PER_CAPITA` (Section 5A) in this step; do **not** implement `PER_FAMILY` (Section 5B) — that is
  Step 7. Leave the `PER_FAMILY` branch on its current behavior with an explicit deferral comment.
- The per-capita refactor must be **numerically identical** to today for existing `PER_CAPITA`
  expenses: same `amount / total_humans` arithmetic, **no** new intermediate rounding, and the same
  single final `round(net, 2)`. Do not alter the balanced-ledger invariant (`sum(net) ≈ 0`).
- `split_per_capita` / `resolve_weights` MUST be pure: no `async`, no Motor/`database` import, no
  FastAPI, no network/DB I/O — operate only on plain dicts/lists, like `minimize_transfers`.
- Honor `weight_snapshots` as the per-transaction weight override (partial family / Step 8 snapshots)
  and continue defaulting unknown/stale member ids to weight `1`.
- App-User identity mapping (Section 5): an app user who has joined a family is counted **inside**
  that family's human-count weight, not as a separate individual; the per-capita math operates on
  the resolved member weights and must not double-count such a user.
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) must remain intact;
  no switch to ObjectIds.
- Keep/maintain existing RBAC: `_trip_or_404` on balance/settle/report routes stays as-is. Add no
  access control in this step.
- Follow frontend design-system tokens and dynamic light/dark `ThemeContext` for any UI — but this
  step ships **no** frontend changes.
- Keep changes strictly scoped to this step; do not touch the settlement algorithm, the reports
  pipeline, the `per_person` breakdown, the `PER_FAMILY` path beyond leaving an interim comment, or
  any unrelated code.

## Definition of Done
- [ ] `backend/services/calculator.py` defines pure `resolve_weights(split_ids, base_weights,
      snapshots=None)` and `split_per_capita(amount, weights)` with no imports from `database`,
      `routes`, `utils`, FastAPI, or Motor; `from services.calculator import resolve_weights,
      split_per_capita` succeeds when run from `backend/`.
- [ ] `_compute_balances` explicitly branches on `e.get("split_mode", "PER_CAPITA")`; the
      `PER_CAPITA` path uses `resolve_weights` + `split_per_capita`, and the `PER_FAMILY` path is
      clearly commented as a Step 7 interim. The returned shape
      (`{net, transfers, members, currency, per_person}`) is unchanged.
- [ ] New `backend/tests/test_per_capita.py` (pure, server-free) covers, at minimum:
      - the Section 5(A) example — 4 families (sizes 4, 4, 2, 1) + 2 individuals = 13 humans, a 130
        expense → C = 10; family shares 40/40/20/10, individuals 10/10; `sum(shares) == 130`;
      - empty `weights` → `{}` and all-zero / `H <= 0` weights → `{}`;
      - a single individual owes the full amount;
      - non-divisible remainder (e.g. `100 / 3`) where `sum(shares)` equals `amount` within `1e-9`
        and no intermediate rounding occurs;
      - `weight_snapshots` override changes a family's effective weight (partial family);
      - unknown/stale split ids default to weight `1` via `resolve_weights`;
      - empty `split_ids` resolves to an empty weight map (caller-side "all members" expansion is
        unchanged and may be asserted at the `resolve_weights` boundary).
- [ ] No regression in the integration suite: `GET /api/trips/{id}/balances` returns the same `net`
      and `transfers` as before for `PER_CAPITA` data; `test_balances_reports.py`,
      `test_expenses.py`, and `test_split_mode.py` still pass.
- [ ] `cd backend && pytest` is green across the whole suite (including
      `tests/test_per_capita.py` and the existing `tests/test_calculator.py`).
- [ ] `CLAUDE.md` Roadmap Step 6 checkbox flipped to `- [x]` in the implementation commit.
