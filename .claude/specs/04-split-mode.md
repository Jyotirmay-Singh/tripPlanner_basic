# Spec: Dual Split Mode Enums  (Step 04)

## Overview
This feature introduces a strict, validated `split_mode` field on every expense so the
application can later distinguish between the two cost-allocation strategies defined in
Section 5 of `CLAUDE.md`: **`PER_CAPITA`** (divide by total humans) and **`PER_FAMILY`**
(divide by total root entities). It corresponds to **Phase 1, Step 4: Dual Split Mode Enums**
in the `CLAUDE.md` Roadmap. The scope of this step is deliberately narrow — it adds the
typed enum field to the Pydantic validation models and persists/round-trips it through the
MongoDB expense document. It does **not** implement the per-capita vs per-family math (that
is Steps 6–7), does **not** isolate the calculator (Step 5), and does **not** build the
frontend selector (Step 16). After this step, every new expense carries an explicit,
schema-enforced split mode, and legacy expenses are treated as `PER_CAPITA` (which exactly
matches today's weight-based behavior), guaranteeing zero behavioral regression.

## Depends on
- **Step 1 — Modularize Backend** (done): `models/expense.py`, `routes/expenses.py`,
  `utils/balances.py` already exist as separate modules.
- **Step 2 — Trip RBAC Infrastructure** (done): `admin_ids` present (not exercised here, but
  the RBAC layer that Step 10 will hook into is already in place).
- **Step 3 — Unique Family & Domain Mapping** (done).
- No dependency on Steps 5–7; this step only adds the tracking field they will consume.

## Data Model Changes (MongoDB/Pydantic)
A new field is added to the expense document and its Pydantic models.

**Type alias (new), defined once in `models/expense.py`:**
```python
SplitMode = Literal["PER_CAPITA", "PER_FAMILY"]
```

**`ExpenseIn` (create payload):**
- Add `split_mode: SplitMode = "PER_CAPITA"`
  - Default is `PER_CAPITA` because the current `_compute_balances` engine already divides by
    member weight (family size), which is per-capita semantics. Defaulting here preserves
    existing behavior for any client that does not send the field.

**`ExpenseUpdate` (patch payload):**
- Add `split_mode: Optional[SplitMode] = None`
  - `None` means "leave unchanged"; the existing generic `$set` of non-`None` fields in
    `update_expense` will apply it automatically once the field is on the model.

**MongoDB `expenses` document:**
- New persisted key `split_mode` (string, one of `"PER_CAPITA"` / `"PER_FAMILY"`).
- **Legacy documents** written before this step will not have the key. They MUST be read as
  `PER_CAPITA`. This is handled at read time by defaulting (`e.get("split_mode", "PER_CAPITA")`)
  rather than a destructive bulk migration — UUID `id` documents and `{"_id": 0}` projections
  remain untouched.
- **No new index** is required (`split_mode` is not queried by itself in this step).
- IDs remain UUID strings via `gen_id()`; no Mongo ObjectIds introduced.

## Backend API & Services (FastAPI)
No new routes. Three existing route handlers in `backend/routes/expenses.py` are touched:

- **`POST /api/trips/{trip_id}/expenses` (`add_expense`)**
  - Input: `ExpenseIn` now includes optional `split_mode` (defaults to `PER_CAPITA`).
  - Behavior: write `"split_mode": body.split_mode` into the inserted document.
  - Output: unchanged shape (`{"expense": doc, "warning": ...}`); `doc` now contains
    `split_mode`.
  - An invalid value (e.g. `"PER_HEAD"`) is rejected by Pydantic with HTTP **422** before any
    DB write — this is the core validation guarantee of this step.

- **`GET /api/trips/{trip_id}/expenses` (`list_expenses`)**
  - Each returned expense must include `split_mode`; for legacy docs missing the key, fill it
    with `"PER_CAPITA"` in the response so the client always sees a concrete value.

- **`PATCH /api/trips/{trip_id}/expenses/{expense_id}` (`update_expense`)**
  - `split_mode` becomes an updatable field; the existing
    `{k: v for k, v in body.model_dump().items() if v is not None and k != "force"}`
    pattern already supports this once the field exists on `ExpenseUpdate`.
  - An invalid value is rejected with HTTP **422** before the `$set`.

- **`utils/balances.py::_compute_balances` — NOT changed in this step.** It continues to use
  the current weight-based (per-capita) algorithm. Branching the math on `split_mode` is
  explicitly deferred to Steps 6–7. (A one-line note/TODO referencing Step 6 may be added
  where `split_mode` will eventually be read, but no logic change.)

- **RBAC:** Existing `_trip_or_404` membership enforcement is preserved on all three handlers.
  No new RBAC is introduced here (creator/admin edit-protection is Step 10).

## App Screens & UI (Expo React Native)
- **Create:** None.
- **Modify:** None required. The visible **Per Person / Per Family** segmented selector in the
  Add/Edit expense screens (`frontend/app/trip/[id]/add-expense.tsx`,
  `frontend/app/trip/[id]/edit-expense.tsx`) is **Step 16** and is out of scope here. Because
  the backend field defaults to `PER_CAPITA`, the current app keeps working unchanged without
  sending the field.

## State & API Integration
- No required changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or
  `AsyncStorage`.
- *(Optional, non-blocking)* the TypeScript expense type in `frontend/src/api.ts` may add
  `split_mode?: 'PER_CAPITA' | 'PER_FAMILY'` for forward-compatibility, but no call site needs
  to set it in this step. Prefer to leave frontend untouched to keep scope tight.

## Files to change
- `backend/models/expense.py` — add `SplitMode` literal alias; add `split_mode` to `ExpenseIn`
  (default `PER_CAPITA`) and `ExpenseUpdate` (`Optional`, default `None`).
- `backend/routes/expenses.py` — persist `split_mode` in `add_expense`'s inserted doc; default
  legacy `split_mode` to `PER_CAPITA` in `list_expenses` responses.

## Files to create
- `backend/tests/test_split_mode.py` — pytest coverage for default, explicit valid values,
  invalid-value rejection (422), persistence round-trip, and patch update.
- `specs/04-split-mode.md` — this spec document.

## New Dependencies
No new dependencies (Python or frontend).

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5
  of `CLAUDE.md`. **Define the enum with these exact uppercase string values.** Do **not**
  implement the per-capita/per-family division math in this step — only the typed tracking
  field. The math is Steps 6–7.
- Default `split_mode` to `PER_CAPITA` everywhere a value is absent (create default + legacy
  read default) so existing balances and reports are byte-for-byte unchanged.
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) must remain
  intact; no switch to ObjectIds and no destructive bulk migration of existing expenses.
- Preserve existing `_trip_or_404` access checks on the touched endpoints. Do not add or remove
  RBAC behavior in this step (creator/admin edit-protection is Step 10).
- Follow the frontend design system tokens and dynamic light/dark `ThemeContext` for any UI —
  but this step should ship with **no** frontend changes.
- Keep changes strictly scoped to this step; do not refactor `_compute_balances`, the reports
  pipeline, or unrelated code.
- After the work is complete, tested, and committed, update the `CLAUDE.md` Roadmap by changing
  Step 4's `- [ ]` to `- [x]`.

## Definition of Done
A reviewer can verify each item by running the backend API / `pytest` (start the API locally
with `uvicorn server:app --reload` so the integration tests can reach
`http://localhost:8000`):

- [ ] `models/expense.py` defines `SplitMode = Literal["PER_CAPITA", "PER_FAMILY"]`, with
      `ExpenseIn.split_mode` defaulting to `"PER_CAPITA"` and `ExpenseUpdate.split_mode`
      optional (`None`).
- [ ] `POST /api/trips/{id}/expenses` **without** `split_mode` returns an expense whose
      `split_mode == "PER_CAPITA"`.
- [ ] `POST` with `split_mode: "PER_FAMILY"` returns and persists `"PER_FAMILY"` (confirmed via
      a follow-up `GET /api/trips/{id}/expenses`).
- [ ] `POST`/`PATCH` with an invalid value (e.g. `"PER_HEAD"`) returns HTTP **422** and writes
      nothing.
- [ ] `PATCH /api/trips/{id}/expenses/{expense_id}` with `split_mode: "PER_FAMILY"` flips an
      existing expense from `PER_CAPITA` to `PER_FAMILY`.
- [ ] `GET /api/trips/{id}/expenses` returns `split_mode` on every expense, including legacy
      documents (defaulted to `PER_CAPITA`).
- [ ] Existing balances/reports behavior is unchanged: the full pre-existing suite
      (`test_expenses.py`, `test_balances_reports.py`) still passes — i.e. `_compute_balances`
      was not altered.
- [ ] New `backend/tests/test_split_mode.py` covers all of the above and passes.
- [ ] `cd backend && pytest` is green across the whole suite.
- [ ] `CLAUDE.md` Roadmap Step 4 checkbox flipped to `- [x]` in the implementation commit.
