# Plan: Isolate Mathematical Layer (Roadmap Step 5)

## Context
Phase 2 of the Trip Expense Splitter roadmap is about turning the calculation/export code into
clean, testable engines. Right now the **minimum-transaction greedy settlement algorithm** is
inlined inside `backend/utils/balances.py::_compute_balances` (lines 47–65), interleaved with
Motor DB reads, member-weight lookups, settlement application, and response shaping. That makes
the settlement math impossible to unit-test in isolation and impossible to reuse from the
per-capita/per-family work coming in Steps 6–8.

This step (per `.claude/specs/05-isolate-math.md`) extracts that algorithm into a new, **pure,
synchronous, dependency-free** function `minimize_transfers(net)` in `backend/services/calculator.py`,
and rewrites `_compute_balances` to call it. Behavior must be **byte-for-byte identical** — this is
an isolation refactor, not a behavior change. The payoff: a true unit-testable seam (no running
server) for the math engines, and a stable place for Steps 6–7 to layer split-mode logic into the
*net computation* without ever touching settlement.

## Scope guardrails
- Backend only. **No frontend changes**, no data-model changes, no new dependencies.
- Do **not** change the net-computation loop, the per-person breakdown, the reports pipeline, or
  any split-mode (`PER_CAPITA`/`PER_FAMILY`) math — those are Steps 6–9.
- Preserve the algorithm exactly: `0.01` epsilon comparisons, debtors-ascending /
  creditors-descending sort, `min(owe, receive)` matching, `round(pay, 2)`, and transfer ordering.
- Keep all UUID `id` usage and `{"_id": 0}` projections intact; keep existing `_trip_or_404` RBAC
  on balance/settle/report routes unchanged.

## Changes

### 1. Create `backend/services/__init__.py`
Empty package marker so `services` is importable as a top-level package from `backend/` (mirrors
`models/`, `routes/`, `utils/`).

### 2. Create `backend/services/calculator.py`
Pure module — **no** `async`, and **no** imports from `database`, `routes`, `utils`, FastAPI, or
Motor. Define:

```python
def minimize_transfers(net: dict) -> list[dict]:
    """Greedy minimum-transaction settlement.

    net: member_id -> rounded net balance (positive = creditor, negative = debtor).
    Returns transfers: [{"from_member_id", "to_member_id", "amount"}], amount rounded to 2dp.
    """
```

Body is the algorithm migrated **verbatim** from `backend/utils/balances.py:47-65`:
sort `debtors` ascending and `creditors` descending; two-pointer greedy match; append
`{"from_member_id", "to_member_id", "amount": round(pay, 2)}` only when `pay > 0.01`; advance a
pointer when its residual is `< 0.01` in absolute value. Return the `transfers` list.
Caller passes an already-rounded `net`, so rounding stays out of this function.

### 3. Modify `backend/utils/balances.py`
- Add `from services.calculator import minimize_transfers` at the top.
- Keep everything in `_compute_balances` up to and including the `round(net[k], 2)` loop unchanged.
- **Delete** the inlined greedy block (current lines ~47–65) and replace with:
  `transfers = minimize_transfers(net)`.
- The returned dict (`net`, `transfers`, `members`, `currency`, `per_person`) is unchanged.

### 4. Create `backend/pytest.ini` (professional-setup fix — beyond the spec's file list)
Required so the new pure unit test can `import` app modules under the documented `pytest` command.
Today no test imports app code, so this gap is latent; the new test is the first to need it.
`pytest` (console script) does not put `backend/` on `sys.path`, and `backend/tests/` has no
`__init__.py`, so `from services.calculator import minimize_transfers` would otherwise fail.

```ini
[pytest]
pythonpath = .
```

Minimal and non-disruptive: the existing HTTP-only tests are unaffected; pytest 9.0.3 supports
`pythonpath`. (Alternative considered: a root `backend/conftest.py` — `pytest.ini` is chosen as the
more explicit, declarative professional convention and gives a home for future test config.)

### 5. Create `backend/tests/test_calculator.py`
Pure unit tests: `from services.calculator import minimize_transfers`, asserting directly — **no
HTTP, no server, no `conftest.py` fixtures**. Cases:
- Empty `net` → `[]`; all-zero / already-settled net → `[]`; single member → `[]`.
- Simple two-party debt: `{"a": -50.0, "b": 50.0}` → one transfer a→b for `50.0`.
- Multi-party case asserting the **minimum number of transfers** and correct amounts/direction.
- Sub-`0.01` epsilon residuals are ignored (no spurious micro-transfers).
- A scenario matching a Section-5 example (e.g. per-capita net derived from the 13-humans / $130
  example) to anchor real-world numbers — testing the settlement output for that net vector.

## Verification
1. `cd backend && pytest tests/test_calculator.py -v` → new pure unit tests pass **without** a
   running server (proves isolation + import resolution via `pytest.ini`).
2. Regression — no behavior drift:
   - Start the API: `cd backend && uvicorn server:app --reload`.
   - `cd backend && pytest` → whole suite green, including `test_balances_reports.py` and
     `test_expenses.py` (these exercise `/balances` end-to-end, confirming `net` + `transfers` are
     unchanged after the refactor).
3. Optional spot check: `GET /api/trips/{id}/balances` returns the same `transfers` list as before
   the refactor for a seeded trip.
4. After green + commit, flip Roadmap **Step 5** `- [ ]` → `- [x]` in `CLAUDE.md` (per the spec's
   final DoD item) in the implementation commit.

## Files
**Create**
- `backend/services/__init__.py`
- `backend/services/calculator.py`
- `backend/pytest.ini`
- `backend/tests/test_calculator.py`

**Modify**
- `backend/utils/balances.py` (extract greedy loop → call `minimize_transfers`)
- `CLAUDE.md` (Step 5 checkbox, in the implementation commit after tests pass)

## Definition of Done (from spec)
- `from services.calculator import minimize_transfers` resolves when run from `backend/`.
- `calculator.py` is pure (no DB/FastAPI/Motor/async imports).
- `_compute_balances` no longer inlines the greedy loop; output shape identical.
- New `test_calculator.py` passes standalone; full `cd backend && pytest` is green.
- `CLAUDE.md` Step 5 flipped to `[x]` in the implementation commit.
