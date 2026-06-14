# Plan: Execute Spec 04 — Dual Split Mode Enums

## Context
The Trip Expense Splitter Roadmap (`CLAUDE.md`, Phase 1, **Step 4**) requires every expense to
carry a strict, schema-validated `split_mode` field with exactly two values: `PER_CAPITA`
(divide by total humans) and `PER_FAMILY` (divide by root entities), as defined in Section 5 of
`CLAUDE.md`. Today there is no such field — `_compute_balances` always divides by member weight
(family size), i.e. implicit per-capita. Steps 6–7 will branch the actual math on this field;
this step only lands the **typed tracking field** and persists it, so later steps have something
to read. Scope is intentionally narrow: no math change, no calculator extraction (Step 5), no
frontend selector (Step 16).

Spec: `.claude/specs/04-split-mode.md`. Branch already created: `feature/split-mode`.

## Guardrails (from CLAUDE.md)
- Use the **exact** uppercase enum values `PER_CAPITA` / `PER_FAMILY`.
- Default to `PER_CAPITA` wherever a value is absent (create default + legacy read default) so
  existing balances/reports are byte-for-byte unchanged — `_compute_balances` MUST NOT change.
- Keep UUID `gen_id()` IDs and `{"_id": 0}` projections intact; **no** destructive bulk
  migration of existing expense docs.
- Preserve existing `_trip_or_404` membership checks; do **not** add/remove RBAC (that's Step 10).
- Strictly scoped: do not touch `_compute_balances`, the reports pipeline, or the frontend.

## Changes

### 1. `backend/models/expense.py` — add the enum field
- Add a module-level type alias near the top:
  ```python
  SplitMode = Literal["PER_CAPITA", "PER_FAMILY"]
  ```
  (`Literal` is already imported.)
- `ExpenseIn`: add `split_mode: SplitMode = "PER_CAPITA"`.
- `ExpenseUpdate`: add `split_mode: Optional[SplitMode] = None`.
- Rationale: an invalid value (e.g. `"PER_HEAD"`) is then rejected by FastAPI/Pydantic with
  HTTP **422** automatically on both POST and PATCH, before any DB write.

### 2. `backend/routes/expenses.py` — persist + round-trip
- In `add_expense`, add `"split_mode": body.split_mode` to the inserted `doc` dict (alongside
  the existing keys). The returned `doc` then includes it.
- In `list_expenses`, default the field for legacy docs in the response, e.g. after fetching the
  list, set `e["split_mode"] = e.get("split_mode", "PER_CAPITA")` for each item so every
  returned expense carries a concrete value.
- `update_expense` needs **no change**: its existing
  `{k: v for k, v in body.model_dump().items() if v is not None and k != "force"}` `$set`
  pattern already applies `split_mode` when present and skips it when `None`. (Invalid values are
  rejected at validation time.) A short comment noting "split_mode flows through generic $set"
  is optional.
- Optionally add a one-line `# Step 6 will branch math on split_mode` TODO in
  `utils/balances.py` where the field will eventually be read — **no logic change**.

### 3. `backend/tests/test_split_mode.py` — new test file
Mirror the structure/fixtures of `backend/tests/test_expenses.py` (`api_client`, `test_user`,
`BASE_URL`). Cover:
- Default: POST without `split_mode` → returned expense `split_mode == "PER_CAPITA"`.
- Explicit persist: POST with `"PER_FAMILY"` → returned value is `PER_FAMILY` **and** a
  follow-up `GET /trips/{id}/expenses` shows `PER_FAMILY`.
- Invalid create: POST with `"PER_HEAD"` → HTTP **422**.
- Patch flip: create (default `PER_CAPITA`), `PATCH split_mode="PER_FAMILY"` → reads back as
  `PER_FAMILY`.
- Invalid patch: `PATCH split_mode="PER_HEAD"` → HTTP **422**.
- List shape: `GET` returns `split_mode` on every expense.

### 4. `CLAUDE.md` — flip the checkbox
In the same implementation commit, change Roadmap **Step 4** from `- [ ]` to `- [x]`.

## Files
- **Modify:** `backend/models/expense.py`, `backend/routes/expenses.py`, `CLAUDE.md`
  (optional TODO comment: `backend/utils/balances.py`).
- **Create:** `backend/tests/test_split_mode.py`.
- **Frontend:** none (Step 4 is backend-only; the Per Person / Per Family selector is Step 16).
- **Dependencies:** none new.

## Verification
1. Start the API so the integration tests can reach it:
   `cd backend && uvicorn server:app --reload` (serves `http://localhost:8000`, the
   `conftest.py` fallback `BASE_URL`).
2. Run the new test file: `pytest tests/test_split_mode.py` → all pass.
3. Run the full suite for regression: `cd backend && pytest` → green, confirming
   `test_expenses.py` and `test_balances_reports.py` still pass (i.e. `_compute_balances`
   untouched and existing behavior preserved).
4. Manual smoke (optional): POST an expense without `split_mode`, confirm response shows
   `PER_CAPITA`; POST one with `PER_FAMILY` and GET the list to confirm it round-trips.

## Out of scope (later steps)
Per-capita/per-family division math (Steps 6–7), calculator extraction (Step 5), RBAC
edit-protection (Step 10), and the frontend segmented selector (Step 16).
