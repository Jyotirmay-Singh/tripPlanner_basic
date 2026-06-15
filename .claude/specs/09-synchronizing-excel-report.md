# Spec: Synchronize XLSX Export Report  (Step 09)

## Overview
This step delivers **Phase 2, Step 9 — "Synchronize XLSX Export Report"** from the `CLAUDE.md`
Roadmap: bring the `openpyxl` export pipeline in `backend/routes/reports.py::report_xlsx` in sync
with the dual split-mode engine (`PER_CAPITA` | `PER_FAMILY`) realized in Steps 4–8. Today the XLSX
ignores `split_mode` entirely — its "Transactions" sheet lists each expense's amount, payer, and the
raw participant names, but never shows **how** the amount was divided, and there is no way to audit
whether a line item was split per-human (Section 5A) or per-entity (Section 5B). The
balance/settle math has been mode-aware since Step 7, but the report still presents one undifferentiated
view, so a reviewer cannot reconcile a member's net balance against the per-expense allocations. This
step extracts a **pure, unit-testable report builder** (`backend/services/report_builder.py`) that
re-derives each expense's per-member allocation through the *same* calculator functions used by
`_compute_balances` (`resolve_weights` / `split_per_capita` / `split_per_family`), then adds two new
**mathematical validation tabs** to the workbook — one for per-capita line items (showing H = total
humans, per-human cost, and each participant's share) and one for per-family line items (showing
E = total entities and the flat per-entity cost) — plus a `split_mode` column on the existing
Transactions sheet. The JSON `/report` endpoint, all balance endpoints, and the download URL/auth
flow stay **unchanged**; only the contents of the streamed `.xlsx` grow.

## Depends on
- **Step 4 — Dual Split Mode Enums** (done): `split_mode` (`PER_CAPITA` | `PER_FAMILY`) and
  `weight_snapshots` persist on every Expense (`backend/models/expense.py`). The report reads these
  fields to classify each line item.
- **Step 5 — Isolate Mathematical Layer** (done): `backend/services/calculator.py` exposes
  `resolve_weights`, `split_per_capita`, `split_per_family`. The report builder MUST reuse these — it
  must not re-implement the division math — so the export can never drift from the ledger.
- **Step 6 — Realize Per-Capita Mode Math** (done): per-human division and `weight_snapshots`
  override semantics are final; the per-capita validation tab renders exactly this math.
- **Step 7 — Realize Per-Family Mode Math** (done): flat per-entity division is final; the per-family
  validation tab renders exactly this math (size and snapshots ignored, per Section 5B).
- **Step 8 — Retroactive Family Re-allocation Routine** (done): `weight_snapshots` may pin a member's
  per-capita weight on a past expense. The builder feeds `e.get("weight_snapshots")` into
  `resolve_weights` so the report reflects pinned weights identically to `_compute_balances`.
- This step does **not** depend on Steps 10–20 (RBAC tightening, join pipeline, frontend work).

## Data Model Changes (MongoDB/Pydantic)
No data model changes. No new collections, fields, or indexes. The export reads only existing fields
(`split_mode`, `split_member_ids`, `weight_snapshots`, `amount`, `paid_by_member_id`, `kind`,
`category`, `date`, `description`) off Expense documents and `members` off the Trip document. All
reads keep `{"_id": 0}` projections; documents keep UUID string `id`s (no ObjectIds).

## Backend API & Services (FastAPI)

### New service module — `backend/services/report_builder.py`
A **pure** module (no `async`, no Motor/`database`/FastAPI imports — mirroring `calculator.py`,
`test_per_capita.py`, `test_per_family.py`) that turns raw expense + member dicts into structured rows
the route can write straight into worksheets. It re-derives allocations via the calculator so the
report is provably consistent with the ledger.

1. `build_member_weight_map(members: list[dict]) -> dict` — `member_id -> base human count`
   (individual = 1, family = `max(1, len(family_members))`). Mirrors `_weight_of_member` /
   `weight_map` in `backend/utils/balances.py`; kept local to avoid importing the route/util layer
   into a pure service (a tiny duplication is acceptable and explicitly in scope; do not refactor
   `balances.py`).

2. `build_per_capita_rows(expenses, members) -> list[dict]` — for every `kind == "expense"` with
   `split_mode == "PER_CAPITA"`, resolve participants (`split_member_ids or all member ids`), compute
   `weights = resolve_weights(split_ids, weight_map, e.get("weight_snapshots"))`,
   `shares = split_per_capita(e["amount"], weights)`. Emit one row **per participating member**:
   `{date, category, description, amount, total_humans (H = sum weights), per_human (amount/H),
   member_name, member_weight, member_share (round 2)}`. Skip the expense if `shares` is empty
   (H ≤ 0), matching `_compute_balances`.

3. `build_per_family_rows(expenses, members) -> list[dict]` — for every `kind == "expense"` with
   `split_mode == "PER_FAMILY"`, resolve participants, compute `shares = split_per_family(e["amount"],
   split_ids)`. Emit one row **per participating entity**: `{date, category, description, amount,
   total_entities (E), per_entity (amount/E), member_name, member_share (round 2)}`. Family **size and
   `weight_snapshots` are intentionally ignored** here (Section 5B).

4. `build_transaction_rows(expenses, members) -> list[dict]` — one row per expense (both kinds) with
   the existing columns **plus `split_mode`**: `{date, kind, category, description, amount, paid_by,
   split_among, split_mode}`. Income rows carry their `split_mode` value as stored (display only).

Rounding rule: these builders round **only** the displayed `member_share`/`per_*` cells to 2 dp for
presentation. They MUST NOT introduce any new intermediate rounding into the settlement path — they do
not touch `net`; `_compute_balances` remains the single source of truth for balances and keeps its one
`round(net, 2)`.

### Changed route — `backend/routes/reports.py::report_xlsx`
- Keep the **token-in-query auth** exactly as-is (`decode_token(token)` → `db.users.find_one` →
  `_trip_or_404`); keep the `StreamingResponse`, media type, and `Content-Disposition` filename.
- After loading `expenses` and `bal`, call the three builders to produce row lists.
- Keep existing sheets: **Summary**, **By Category**, **Per Member**, **Per Family Person**,
  **Transactions** — but add a `Split Mode` column (last) to **Transactions** sourced from
  `build_transaction_rows`.
- Add two new sheets after Transactions:
  - **"Per-Capita Math"** — header
    `["Date","Category","Description","Amount","Total Humans","Per-Person","Member","Weight","Share"]`,
    rows from `build_per_capita_rows`.
  - **"Per-Family Math"** — header
    `["Date","Category","Description","Amount","Total Entities","Per-Entity","Member","Share"]`,
    rows from `build_per_family_rows`.
- Apply the existing teal header styling (`PatternFill("solid", fgColor="1C3F39")` + bold white
  `Font`) to the two new sheets' header rows by adding them to the styled-sheet list.
- If a mode has no matching expenses, still create its sheet with just the header row (an empty
  validation tab is valid and keeps the workbook shape stable).

### JSON route — `backend/routes/reports.py::report`
No required change to the JSON `/report` payload. (Optional, only if trivial and non-breaking: nothing
in this step's Definition of Done depends on it; **do not** alter existing keys.)

### Routes & RBAC
- No new routes, no signature changes. `GET /trips/{trip_id}/report.xlsx?token=...` and
  `GET /trips/{trip_id}/report` keep their inputs/outputs.
- Access stays **membership-gated** via `_trip_or_404(trip_id, user["id"])` for both endpoints. This
  step adds **no** new RBAC; admin-only locking is Phase 3 and out of scope.

## App Screens & UI (Expo React Native)
- **Create:** None.
- **Modify:** None. `frontend/src/api.ts::xlsxUrl` already builds the
  `/report.xlsx?token=...` link and the Reports tab already opens it; the richer workbook downloads
  through the identical URL with no client change.

## State & API Integration
No changes to `frontend/src/api.ts` (`xlsxUrl` unchanged), `AuthContext`, `ThemeContext`, or
`AsyncStorage`. The request (token query param) and the response (an `.xlsx` stream) are unchanged in
shape; only the workbook's sheet set and Transactions columns grow.

## Files to change
- `backend/routes/reports.py` — import and call the new builder; add the `Split Mode` column to the
  Transactions sheet; add the **Per-Capita Math** and **Per-Family Math** sheets; extend the
  header-styling loop to cover them.
- `CLAUDE.md` — after the work is tested and committed, flip Roadmap **Step 9** from `- [ ]` to
  `- [x]`.

## Files to create
- `backend/services/report_builder.py` — pure `build_member_weight_map`, `build_per_capita_rows`,
  `build_per_family_rows`, `build_transaction_rows` (no `async`, no `database`/`routes`/`utils`/
  FastAPI/Motor imports; may import only from `services.calculator`).
- `backend/tests/test_report_builder.py` — **pure unit tests** (`from services.report_builder import
  ...`; no HTTP, no server, no `conftest` fixtures — mirroring `test_per_capita.py` /
  `test_per_family.py`).
- `.claude/specs/09-synchronizing-excel-report.md` — this spec document.

## New Dependencies
No new dependencies. `openpyxl` is already in `backend/requirements.txt` and used by the existing
report. No frontend dependencies.

## Rules for Implementation
- Respect the strict dual split-mode logic in Section 5 of `CLAUDE.md`. The **Per-Capita Math** tab
  must show human-count division (H = Σ weights, `amount/H`, each share = `per_human * weight`); the
  **Per-Family Math** tab must show flat entity division (E = entity count, `amount/E` for every
  entity, **size and `weight_snapshots` ignored**).
- The report builder MUST re-use `resolve_weights` / `split_per_capita` / `split_per_family` from
  `services.calculator` — do **not** re-implement the division math in the report layer. This is what
  guarantees the export stays synchronized with the ledger.
- `report_builder.py` MUST be pure: no `async`, no Motor/`database`/FastAPI imports; operate only on
  plain dicts/lists passed in by the route.
- Do not introduce new intermediate rounding into the settlement path. Builders round only the
  **displayed** cells (2 dp); `_compute_balances` keeps its single `round(net, 2)` and remains the
  sole authority on balances.
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) must remain intact; no
  ObjectIds. The route keeps reading members/expenses exactly as today.
- Preserve the token-in-query download auth for `report.xlsx` (it is opened via a browser link); do
  **not** convert it to a header-based dependency.
- Preserve existing RBAC: `_trip_or_404` membership gate stays; add **no** new access control.
- App-User identity mapping (Section 5): an app user folded into a family is part of that family's
  single entity; the family's weight is its `family_members` count — do not add a folded-in app user
  as an extra human or entity in either tab.
- Keep changes strictly scoped to this step: do not touch `calculator.py`, `balances.py`, the
  settlement algorithm, the JSON `/report` payload keys, the auth flow, or any unrelated code. Keep
  the five existing sheets (only Transactions gains one column).

## Definition of Done
- [ ] `backend/services/report_builder.py` exists and is pure (no imports from `database`, `routes`,
      `utils`, FastAPI, or Motor; may import from `services.calculator`); `from services.report_builder
      import build_per_capita_rows, build_per_family_rows, build_transaction_rows,
      build_member_weight_map` succeeds when run from `backend/`.
- [ ] `report_xlsx` produces a workbook containing the original five sheets **plus** `Per-Capita Math`
      and `Per-Family Math`; the `Transactions` sheet has a trailing `Split Mode` column; the two new
      sheets carry the teal/bold header styling.
- [ ] New pure `backend/tests/test_report_builder.py` covers, at minimum:
      - `build_per_capita_rows` for the Section 5A example (families sized 4, 4, 2, 1 + 2 individuals
        = H 13; `$130` → per-human 10; family shares 40/40/20/10; individuals 10/10) emits the
        expected per-member shares and `total_humans == 13`;
      - per-capita rows honor `weight_snapshots` (a pinned weight overrides the live family size for
        that one expense's share), proving Step 8 consistency;
      - `build_per_family_rows` for the Section 5B example (4 families + 2 individuals = E 6; `$120`)
        emits a flat `20` share for **every** entity and `total_entities == 6`, **independent** of
        family size and ignoring `weight_snapshots`;
      - `PER_FAMILY` expenses never appear in per-capita rows and `PER_CAPITA` expenses never appear
        in per-family rows;
      - `kind == "income"` expenses are excluded from both math tabs;
      - empty `split_member_ids` ("split among all") includes every member in the row set;
      - `build_transaction_rows` includes a `split_mode` value for every expense row and lists both
        expense and income kinds;
      - the sum of `member_share` across a single expense's rows equals the expense `amount` within
        a 0.02 rounding tolerance (per-capita and per-family).
- [ ] Existing integration `backend/tests/test_balances_reports.py::TestReports::test_get_report_xlsx`
      still passes (valid `PK`-signature XLSX streamed, `spreadsheet` content type). Optionally extend
      it (skip-safe, using the existing `api_client`/`test_user` fixtures) to assert the new sheet
      titles are present via `openpyxl.load_workbook(io.BytesIO(response.content)).sheetnames`.
- [ ] No regression: `test_balances_reports.py`, `test_split_mode.py`, `test_per_capita.py`,
      `test_per_family.py`, `test_calculator.py`, `test_reallocation.py`, `test_expenses.py`, and
      `test_members.py` still pass.
- [ ] `cd backend && pytest` is green across the whole suite (including the new test file).
- [ ] `CLAUDE.md` Roadmap **Step 9** checkbox flipped to `- [x]` in the implementation commit.
