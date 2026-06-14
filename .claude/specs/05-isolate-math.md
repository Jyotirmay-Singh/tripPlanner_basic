# Spec: Isolate Mathematical Layer  (Step 05)

## Overview
This step begins **Phase 2 (The Calculation & Export Engines)** by carving the pure
settlement mathematics out of the data-access/orchestration layer. Today the
minimum-transaction *greedy settlement* algorithm is inlined inside
`backend/utils/balances.py::_compute_balances`, tangled together with Motor DB reads,
weight lookups, and response shaping. This step creates a new `backend/services/calculator.py`
module and migrates the greedy debtor/creditor matching into a **pure, synchronous,
dependency-free function** that takes a net-balance dict and returns the list of transfers.
`_compute_balances` is rewritten to call that function, producing **byte-for-byte identical**
output. The point is isolation, not behavior change: it gives Steps 6–7 (per-capita /
per-family math) and Step 8 (retroactive re-allocation) a clean, unit-testable seam to build
on, and it lets us cover the settlement math with a true unit test (no running server). This
corresponds to **Phase 2, Step 5: Isolate Mathematical Layer** in the `CLAUDE.md` Roadmap.

## Depends on
- **Step 1 — Modularize Backend** (done): `utils/balances.py`, `routes/balances.py`,
  `routes/reports.py` already exist as separate modules; `services/` is the new sibling package.
- **Step 4 — Dual Split Mode Enums** (done): `split_mode` already persists on expenses. This
  step does **not** read or branch on it (that is Steps 6–7) but deliberately keeps the new
  calculator decoupled so those steps can plug split-mode logic into the *net computation*
  without touching the settlement function.
- No dependency on Steps 6–12.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. No new Pydantic models, no MongoDB document/shape changes, no new
indexes. UUID `id` documents and `{"_id": 0}` projections are untouched.

## Backend API & Services (FastAPI)
**New service module — `backend/services/calculator.py`** (pure functions, no FastAPI, no
Motor, no `async`, no imports from `database`/`routes`/`utils`):

- `minimize_transfers(net: dict[str, float]) -> list[dict]`
  - **Input:** `net` — a mapping of `member_id -> net balance` (positive = is owed money /
    creditor, negative = owes money / debtor). Callers pass an already-rounded dict (the
    rounding stays in `_compute_balances`, see below).
  - **Output:** a list of transfer dicts, each exactly
    `{"from_member_id": <debtor_id>, "to_member_id": <creditor_id>, "amount": <float rounded to 2dp>}`,
    identical in shape and ordering to what `_compute_balances` returns today.
  - **Algorithm (migrated verbatim, semantics preserved):** sort debtors ascending by balance,
    creditors descending by balance; greedily match the largest debt against the largest credit;
    emit a transfer only when `pay > 0.01`; advance a side once its residual is within `0.01` of
    zero. The `0.01` epsilon thresholds and `round(pay, 2)` MUST be preserved exactly so results
    do not drift.
  - **Edge cases:** empty dict → `[]`; an all-zero (already-settled) net → `[]`; a single
    member → `[]`.

**Changed orchestrator — `backend/utils/balances.py::_compute_balances`:**
- Keep all existing responsibilities: load trip (`{"_id": 0}`), compute `net` from expenses
  (current weight-based per-capita loop — **unchanged** in this step), apply settlements, and
  `round(..., 2)` every entry of `net`.
- **Replace** the inlined debtor/creditor `while` loop (current lines ~47–65) with a single call:
  `transfers = minimize_transfers(net)`.
- The returned dict (`net`, `transfers`, `members`, `currency`, `per_person`) is **unchanged**.

**Routes:** No route signatures change. `GET /api/trips/{trip_id}/balances`,
`POST /api/trips/{trip_id}/settle`, and both report endpoints keep calling `_compute_balances`
exactly as before. Existing `_trip_or_404` membership enforcement is preserved; **no new RBAC**
is introduced (creator/admin edit-protection is Step 10).

## App Screens & UI (Expo React Native)
- **Create:** None.
- **Modify:** None. This is a backend-internal refactor; the `/balances` and report responses
  are identical, so the dashboard, settle-up, and reports screens require no changes.

## State & API Integration
No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`. The API
contract is byte-for-byte unchanged.

## Files to change
- `backend/utils/balances.py` — remove the inlined greedy settlement loop; import and call
  `minimize_transfers` from `services.calculator`. Net computation, settlement application, and
  rounding stay here.

## Files to create
- `backend/services/__init__.py` — makes `services` an importable top-level package from
  `backend/` (matches how `from database import db` / `from utils...` are imported when pytest
  runs `cd backend && pytest`).
- `backend/services/calculator.py` — the pure `minimize_transfers` settlement function.
- `backend/tests/test_calculator.py` — **pure unit tests** that
  `from services.calculator import minimize_transfers` and assert directly (no HTTP, no server,
  no fixtures from `conftest.py`).
- `.claude/specs/05-isolate-math.md` — this spec document.

## New Dependencies
No new dependencies (Python or frontend).

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5 of
  `CLAUDE.md`. This step does **not** implement or branch on split-mode math — it only relocates
  the settlement algorithm. The per-capita/per-family division is Steps 6–7 and must remain a
  later concern layered into the *net computation*, not the settlement function.
- `services/calculator.py` MUST be pure: no `async`, no Motor/`database` import, no FastAPI, no
  network/DB I/O. It operates only on plain Python dicts/lists so it is unit-testable in
  isolation.
- Preserve the algorithm **exactly**: the `0.01` epsilon comparisons, debtor-ascending /
  creditor-descending sort order, `min(owe, receive)` matching, and `round(pay, 2)`. Output of
  `_compute_balances` must be identical to pre-refactor for the same data.
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) must remain intact;
  no switch to ObjectIds.
- Enforce/keep existing RBAC: `_trip_or_404` checks on balance/settle/report routes stay as-is.
  Do not add or remove access control in this step.
- Follow the frontend design system tokens and dynamic light/dark `ThemeContext` for any UI — but
  this step ships with **no** frontend changes.
- Keep changes strictly scoped to this step; do not refactor the net-computation loop, the reports
  pipeline, the per-person breakdown, or any unrelated code.
- After the work is complete, tested, and committed, update the `CLAUDE.md` Roadmap by changing
  Step 5's `- [ ]` to `- [x]`.

## Definition of Done
- [ ] `backend/services/__init__.py` exists and `from services.calculator import minimize_transfers`
      succeeds when run from `backend/`.
- [ ] `backend/services/calculator.py` defines `minimize_transfers(net)` as a pure synchronous
      function with no imports from `database`, `routes`, `utils`, FastAPI, or Motor.
- [ ] `utils/balances.py::_compute_balances` no longer contains the inlined debtor/creditor loop;
      it calls `minimize_transfers(net)` and returns the same `{net, transfers, members, currency,
      per_person}` shape.
- [ ] New `backend/tests/test_calculator.py` (pure unit tests, runnable without a server) covers:
      empty/all-zero net → `[]`; a simple two-party debt; a multi-party case asserting the minimum
      number of transfers and correct amounts; the sub-`0.01` epsilon being ignored; and a scenario
      matching a Section 5 example. These tests pass with `cd backend && pytest tests/test_calculator.py`.
- [ ] The pre-existing integration suite proves no regression: with the API running locally
      (`uvicorn server:app --reload`), `GET /api/trips/{id}/balances` returns the same `net` and
      `transfers` as before, and `test_balances_reports.py` / `test_expenses.py` still pass.
- [ ] `cd backend && pytest` is green across the whole suite.
- [ ] `CLAUDE.md` Roadmap Step 5 checkbox flipped to `- [x]` in the implementation commit.
