# Claude Code prompt — Phase 22: Exact-Amount Split (plan mode)

> Paste this whole message into Claude Code. It is written to be run in **plan mode
> first**: produce the plan, let me approve it, then execute step by step.

---

## 0. Operating instructions (read first)

1. **Do not write any code yet.** Enter **plan mode** and produce a concrete,
   file-by-file execution plan for the feature described below. List every file you
   will create or modify, the tests you will add, and the order of steps. Wait for my
   approval before editing anything.
2. **Create a new git branch** off the current default branch before any code changes:
   `git checkout -b feature/phase-22-exact-amount-split`. Do all work there. Do not
   commit to `main`.
3. Read `CLAUDE.md`, `USER_GUIDE.md`, and `memory/PRD.md` before planning so the plan
   respects the existing architecture and the **do-not-break invariants** (§2 below).
4. Work step by step. After each step: run the relevant tests, and only then move on.
   Update the Phase-22 checklist in `CLAUDE.md` (`[ ]`→`[x]`) as each step is completed,
   tested, and committed — exactly as prior phases were tracked.
5. Commit in logical units with clear messages (e.g. `phase-22: step 87 — pure exact
   resolver + unit tests`). Do not squash unrelated changes.
6. The feature is **strictly additive**. If any step forces a change to a protected
   path (§2), stop and flag it in the plan instead of proceeding.

---

## 1. Goal

Add a third expense split mode, **Exact amounts** (`split_mode = "EXACT"`), on top of the
existing `PER_CAPITA` and `PER_FAMILY` modes.

In EXACT mode the person entering the expense assigns an **exact amount to specific
people** — individual family members and/or standalone individuals — and the amounts
must add up to the expense total. Example: a trip-currency 100.00 expense assigned as
80 / 10 / 10 across three selected people.

Selection is **person-level**: families expand to their members and each selected member
gets their own amount; standalone individuals get an amount directly. A member with no
amount entered (unticked) contributes exactly 0.

### The one hard rule (non-negotiable)

**An EXACT expense cannot be saved unless the sum of the individual amounts equals the
expense total.** Enforce this in **two places** (defense in depth):

- **Frontend:** the Save button is disabled and a live reconciliation bar shows the
  remaining/over amount until the sum matches the total (within a 1-cent snap).
- **Backend:** the create and edit endpoints **reject** any EXACT payload whose amounts
  do not sum to the total, returning a validation error (HTTP 422, FastAPI-normalized).
  The backend is the source of truth; never trust the client to have validated.

---

## 2. Do-not-break invariants (must remain byte-identical unless the step is explicitly about them)

- `PER_CAPITA` involved-count math (§5-A) and `PER_FAMILY` entity math (§5-B) — unchanged.
- `utils/balances._compute_balances`, `services/calculator.minimize_transfers` — EXACT
  must flow through the **existing** entity-share path, not fork the settlement engine.
- Settlement lifecycle + mark-paid RBAC (Phase 10), partial payments overlay (Phase 20).
- JWT/auth, Google OAuth, GridFS receipts, the Gmail-only rule (`utils/email_rules.py`).
- Every existing Pydantic/DB model shape and route contract. New fields are **optional**
  and absent on legacy documents; legacy expenses must behave exactly as before.
- The XLSX/PDF report only **displays** engine-computed values — no forked split math in
  the report layer.

Regression proof is required: the full existing backend + frontend suites must stay green.

---

## 3. Design (person-level input → entity-level ledger → per-member display)

This is the crux — implement it exactly this way so the protected paths are untouched:

1. **Input (person-level).** The expense stores raw per-person amounts:
   `custom_amounts: { "<member_id>": <trip-currency amount> }`. Presence of a member key
   means "involved"; absence means 0. This is the raw user input, persisted verbatim so
   edits round-trip (reopening an EXACT expense shows the exact amounts typed).
2. **Ledger (entity-level rollup).** A pure resolver rolls each person's amount up to
   their **entity**: a family's entity share = Σ of its selected members' amounts; a
   standalone individual's share = their own amount. This produces the same
   `{entity_key: amount}` shape the two existing modes already emit, so it feeds
   `expense_shares.entity_shares_raw` → `_compute_balances` → `minimize_transfers`
   **unchanged**. The ledger continues to settle between entities.
3. **Display (per-member breakdown).** The Phase-14 per-expense family breakdown
   (`calculator.distribute_per_expense_net`) branches for EXACT to use the **explicit**
   per-member amounts directly (excluded member ⇒ 0) instead of the even split. Because
   the family entity share equals Σ member amounts by construction, the breakdown still
   foots exactly to the family net, and the chronological settlement replay
   (`distribute_chronological`) consumes it unchanged.

EXACT **ignores** `family_participants` and `weight_snapshots` (those drive PER_CAPITA
involvement). In EXACT, "involved" is defined solely by presence in `custom_amounts`.

All internal reconciliation is done in **integer cents** to avoid float drift; the
1-cent tolerance is resolved by snapping the largest row (largest-remainder style), so
the resolved entity shares always sum exactly to the stored total.

---

## 4. Data model

- `models/expense.py` (Pydantic create/update/DB bodies): extend the `split_mode`
  literal to `Literal["PER_CAPITA", "PER_FAMILY", "EXACT"]`. Add optional field
  `custom_amounts: dict[str, float] | None = None`.
- DB documents: store `custom_amounts` only for EXACT expenses; leave absent otherwise.
- No migration/backfill needed (field is optional; legacy rows unaffected).

---

## 5. Backend implementation (Phase 22 — steps)

Add these as a new **Phase 22** block in `CLAUDE.md`'s roadmap, in the same condensed
step format as existing phases, and check them off as you go.

- **Step 86 — Model + pure validator.** Add the `EXACT` literal and `custom_amounts` to
  `models/expense.py`. Write a pure validator (in `services/custom_split.py` or
  `utils/`) `validate_exact_amounts(total, custom_amounts, trip_members)` that enforces:
  every key is a real member of this trip; every amount ≥ 0; at least one amount > 0;
  Σ amounts == total within ±0.01 (then snap). Returns normalized amounts or raises a
  clear validation error. **No I/O.**
- **Step 87 — Pure resolver.** `services/custom_split.py::resolve_exact_entity_shares(
  custom_amounts, roster)` → `{entity_key: amount}` rolling members up to their entity
  (family = Σ its members present; individual = own), integer-cent safe, summing exactly
  to the total. **No I/O.** Extensive unit tests (see §7).
- **Step 88 — Wire into the share engine.** Add EXACT as a third branch in
  `expense_shares.entity_shares_raw` returning the resolver output, so `_compute_balances`
  and `minimize_transfers` consume it with no other change. Add a reconciliation test:
  Σ entity_shares == total for EXACT across family and individual payers.
- **Step 89 — Wire into the per-member breakdown.** Branch
  `services/calculator.distribute_per_expense_net` so an EXACT expense uses its explicit
  per-member `custom_amounts` (excluded ⇒ 0); `distribute_chronological` unchanged. Test
  that the family breakdown equals the typed amounts and foots to the family net, and
  that settlement scaling still works when an EXACT expense is later settled.
- **Step 90 — Enforce the hard rule at the API.** In the create and edit expense routes
  (`routes/expenses.py`), when `split_mode == "EXACT"`, call the Step-86 validator and
  **reject mismatches with HTTP 422** (FastAPI-normalized error body the frontend
  already understands). The existing creator/admin edit RBAC (`_expense_modify_or_403`)
  is unchanged and still applies. Persist `custom_amounts` on success.
- **Step 91 — Reports.** Extend `services/report_builder.py` (`mode_label`,
  `build_split_math_rows`, `build_expense_member_rows`) and the PDF builder
  (`services/report_pdf.py`) to render EXACT: show the mode label and each person's
  exact share, reusing `entity_shares_raw` — no forked math. XLSX (`routes/reports.py`)
  and PDF both. Amounts reconcile to the same totals as the ledger.

## 6. Frontend implementation (Phase 22 — steps)

- **Step 92 — Pure helper + shared vectors.** `frontend/src/exactSplit.ts`:
  - `reconcile(rows, total) -> { assigned, remaining, isValid }` (isValid ⇔ |remaining|
    < 0.005 and total > 0).
  - `resolveEntityShares(rows)` mirroring the backend rollup.
  - `splitRemainingEqually(rows, total)` filling ticked-but-blank rows, snapping the last
    row so the sum is exact.
  Use a **shared test-vector fixture** (committed under a path both `pytest` and `jest`
  read, or duplicated with an explicit "keep in sync" comment) so the frontend and
  backend snap logic cannot drift. Jest tests for every helper.
- **Step 93 — UI: EXACT mode in Add/Edit expense.** Extend the split-mode segmented
  control to three options `[Per Person | Per Family | Exact]` (`SplitModeSelector`). When
  EXACT is active, transform the existing **Split Among** list in place (do NOT add a
  separate screen — keep inline editing so totals update instantly):
  - The **total amount** field at the top remains fully editable; the reconciliation
    recomputes live whenever the total or any amount changes.
  - **Families are collapsed by default**, showing name, member count, and a live
    **subtotal**. Tapping a family expands it to reveal per-member rows, each with a
    checkbox (include/exclude) and a right-aligned amount input. Unticking a family
    excludes it (contributes 0) and collapses it.
  - Standalone individuals show a checkbox + inline amount input.
  - A **live reconciliation bar** below the list shows `Assigned … · Remaining …`,
    green when the sum equals the total and red otherwise, and the **Save button is
    disabled** until it reconciles (mirror of the backend rule).
  - A **"Split remaining equally"** action fills ticked-but-blank member rows.
  - Show a subtle "not set" hint on any included family whose subtotal is still 0.
  - On **edit**, rehydrate the exact per-person amounts from `custom_amounts`.
  Reference the approved mockup for layout/behavior. Reuse existing design-system
  components (`ui/`), the `Screen`/`Card`/`ListRow` patterns, and theme tokens.
- **Step 94 — Preview label + API wiring.** Extend `SplitModeSelector.splitPreviewLabel`
  (and the `familyParticipation.ts` mirror) to describe the EXACT rollup (e.g.
  "Sharma 90 · Alex 10"). Update `src/api.ts` to send/receive `custom_amounts` on create
  and edit, and surface the backend 422 (reuse the existing FastAPI error normalization)
  as an inline error if the client somehow submits an unreconciled EXACT expense.
  Mirror any client-side permission text in `src/permissions.ts` if needed (RBAC itself
  is unchanged).

## 7. Exhaustive testing (required — do not skip)

Add a dedicated test module per layer and make them comprehensive. Aim for full branch
coverage of the new code.

### Backend — pure unit tests (`tests/test_exact_split.py`, no server)
- 80/10/10 across three selected people, individuals only.
- 80/10/10 where two of the three are members of one family + one individual → assert
  entity rollup `{family: 90, individual: 10}` and per-member breakdown `{80,10,0,…}`.
- Mixed: multiple families (each with several members) + multiple individuals; assert
  each family entity share == Σ its members and Σ all == total.
- Property test: family entity share always equals Σ of that family's member amounts.
- Excluded member (absent key) contributes exactly 0; the breakdown still foots.
- Penny/snap cases: amounts like 33.33 / 33.33 / 33.34 summing to 100.00; assert the
  integer-cent snap makes resolved shares sum exactly to the total.
- **Validator failures (must raise):** sum under total; sum over total; a negative
  amount; all amounts zero; empty `custom_amounts`; a key that is not a trip member.

### Backend — integration / live-API tests (`tests/test_exact_split_api.py`)
Run against a local Docker Mongo (same harness as `test_payments.py`).
- `POST` create EXACT expense with matching sum → 201/200, persisted `custom_amounts`.
- `POST` create with **mismatched sum → 422** (the hard rule). Assert the error body.
- `PATCH` edit EXACT expense: change amounts (still matching) → success; reopen returns
  the exact stored amounts (round-trip).
- `PATCH` edit to a **mismatched sum → 422**; the stored expense is unchanged.
- Balances: after an EXACT expense, assert per-entity `net_total` matches the rollup and
  that `minimize_transfers` produces the expected residual pairs.
- Per-member family breakdown returns the explicit typed amounts and sums to family net.
- Settlement replay: settle part of an EXACT-derived balance → chronological breakdown
  scales correctly.
- Report: `GET report.xlsx` and `GET report.pdf` include the EXACT expense; totals
  reconcile (Σ amount == Σ payable == pivot grand total).
- RBAC unchanged: a non-creator non-admin cannot edit/delete the EXACT expense.
- **Regression:** legacy expenses (no `custom_amounts`) unchanged; a `PER_CAPITA` and a
  `PER_FAMILY` fixture produce byte-identical balances/report values to before.

### Frontend — jest (`src/__tests__/exactSplit.test.ts`)
- `reconcile`: exact match → isValid true; under, over, and total==0 → false, with
  correct `assigned`/`remaining`.
- `resolveEntityShares`: matches the backend rollup on the shared vectors.
- `splitRemainingEqually`: distributes remainder, snaps the last row, sum is exact.
- Family exclusion → that family's members contribute 0.

### Frontend — component/interaction (if RTL/Testing Library is set up)
- Save disabled while remaining ≠ 0; enabled at exactly 0.
- Editing the total re-evaluates reconciliation.
- Expand/collapse a family; exclude a family via its checkbox.
- Edit flow rehydrates `custom_amounts` into the fields.

### Manual QA checklist (document in the PR description)
Multiple families with multiple members each; a family excluded entirely; total edited
after amounts entered; "split remaining equally"; attempt to save while unreconciled
(blocked); dark mode + light mode; web and Expo Go.

## 8. Verification gate & delivery

- **Backend:** `cd backend && pytest` — new EXACT unit tests + live-API tests green; the
  full existing suite green (call out any pre-existing unrelated failures, e.g. the known
  `test_auth` admin-login env caveat, and do not introduce new ones).
- **Frontend:** `cd frontend && yarn tsc --noEmit && yarn lint && yarn jest` — all green.
- **Docs:** add Phase 22 to `CLAUDE.md` (roadmap + a new §5-C "Exact-Amount Split"
  describing person-level input → entity-level ledger → per-member display, and the
  save-gate rule) and a `USER_GUIDE.md` section.
- **Commits:** one branch `feature/phase-22-exact-amount-split`, logical commits per step,
  checklist boxes ticked. Do **not** merge — open a PR / summarize the diff and stop for
  my review.

## 9. Deliverables

1. The approved plan (produced in plan mode) before any code.
2. The branch with the implemented feature across backend + frontend + reports.
3. New test modules (pure + live-API + jest) all green, plus the regression proof.
4. Updated `CLAUDE.md` (Phase 22 + §5-C) and `USER_GUIDE.md`.
5. A short PR description: what changed, the two-layer save-gate, test results, and the
   manual QA checklist outcomes.

---

### First action

Reply with the **plan only** (files to touch, step order, test list, branch name,
open questions). Do not modify any files until I approve the plan.
