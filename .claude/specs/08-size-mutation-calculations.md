# Spec: Retroactive Family Re-allocation Routine  (Step 08)

## Overview
This step delivers **Phase 2, Step 8 — "Retroactive Family Re-allocation Routine"** from the
`CLAUDE.md` Roadmap: a dedicated, transactional, well-tested service that decides what happens to a
trip's **past** expenses when a **family's size changes** (its `family_members` list grows or
shrinks). Today this behavior is an ad-hoc inline loop buried inside
`backend/routes/members.py::update_member`: when `reweight_past is False` it walks every past expense
containing the member and snapshots the member's **old** weight into `expense.weight_snapshots`
(read back by `resolve_weights` during `PER_CAPITA` math). That inline routine has three real gaps
this step closes: (1) it is **not isolated** into a service (the Roadmap mandates a "transactional
service"); (2) it is **not symmetric** — the `reweight_past=True` ("recalculate past ledger
balances") path does **nothing**, so a member who was previously pinned via a future-only change can
never be un-pinned and float back to the live weight; (3) it snapshots **every** mode including
`PER_FAMILY`, which is meaningless because per-family math ignores size and snapshots entirely
(Section 5B). This step extracts a pure planner + a transactional applier into
`backend/services/reallocation.py`, makes both toggle directions correct and `PER_CAPITA`-scoped,
performs the writes in a single bulk operation inside a MongoDB transaction (with a safe fallback for
standalone Mongo), and rewires `update_member` to delegate to it. The `update_member` response shape
and all balance/report endpoints stay **unchanged**; only the persisted `weight_snapshots` (and
therefore the computed `PER_CAPITA` balances for past expenses) change, exactly per the chosen
toggle.

## Depends on
- **Step 4 — Dual Split Mode Enums** (done): `split_mode` (`PER_CAPITA` | `PER_FAMILY`) and
  `weight_snapshots` persist on every Expense (`backend/models/expense.py`); `reweight_past`
  persists on `MemberUpdate` (`backend/models/member.py`).
- **Step 5 — Isolate Mathematical Layer** (done): `backend/services/` exists as the home for pure,
  dependency-free logic; this step adds a sibling module beside `calculator.py`.
- **Step 6 — Realize Per-Capita Mode Math** (done): `resolve_weights(split_ids, base_weights,
  snapshots)` is the consumer of `weight_snapshots` — a snapshot override wins over the live base
  weight. Retroactive re-allocation only changes numbers through this seam, so per-capita math must
  already be correct.
- **Step 7 — Realize Per-Family Mode Math** (done): established that `PER_FAMILY` ignores family size
  and `weight_snapshots`; this step therefore restricts all snapshot writes to `PER_CAPITA`
  expenses.
- This step does **not** depend on Steps 9–20. Frontend Step 15 ("Apply retroactively / future
  only?" prompt) will *consume* this service's toggle but is out of scope here; the toggle field and
  the `edit-member.tsx` switch already exist.

## Data Model Changes (MongoDB/Pydantic)
No new collections, fields, or indexes. The mechanism reuses the existing
`expense.weight_snapshots` map (`member_id -> int weight`) introduced in Step 4 and the existing
`MemberUpdate.reweight_past: Optional[bool] = True` flag. Documents keep UUID string `id`s and all
reads continue to use `{"_id": 0}` projections; no switch to ObjectIds.

Semantics this step formalizes for `weight_snapshots` on a **`PER_CAPITA`** expense:
- A key `member_id -> w` **pins** that member's per-capita weight for that expense to `w`, overriding
  the member's live base weight (`_weight_of_member`).
- **Absence** of a key means the member floats to the live base weight at compute time.
- `PER_FAMILY` expenses may still carry the field but it is never read (Section 5B) — this step
  never writes snapshots onto `PER_FAMILY` expenses.

## Backend API & Services (FastAPI)

### New service module — `backend/services/reallocation.py`
Split into a **pure planner** (unit-testable with plain dicts, no Motor/FastAPI/I/O — mirroring
`calculator.py`) and a thin **async applier/orchestrator** that touches Mongo.

1. Pure planner (no `async`, no DB import):
   - `plan_reallocation(member_id: str, old_weight: int, new_weight: int, reweight_past: bool,
     expenses: list[dict]) -> dict`
     - `expenses` are plain dicts each with at least `id`, `split_mode`, `split_member_ids`,
       `weight_snapshots`.
     - Returns a plan, e.g.
       `{"set": [{"expense_id": ..., "member_id": ..., "weight": old_weight}, ...],
         "unset": [{"expense_id": ..., "member_id": ...}, ...],
         "set_count": int, "unset_count": int}`.
     - Rules:
       - **No-op when `old_weight == new_weight`** → empty plan (a name/email-only edit must not
         touch any expense).
       - Consider **only** expenses where `member_id` participates: `member_id in
         (split_member_ids or [])`. (An empty `split_member_ids` means "split among all"; treat the
         member as a participant in that case too, consistent with `_compute_balances`.)
       - Consider **only** `split_mode == "PER_CAPITA"` expenses (per-family is size-independent).
       - If `reweight_past is False` (**future-only**): for each qualifying expense **without** an
         existing pin for `member_id`, emit a `set` to pin the member's **old** weight (freeze the
         past at its pre-mutation value). Existing pins are **preserved** (first pin wins — it
         already captured the historically-correct weight).
       - If `reweight_past is True` (**retroactive**): for each qualifying expense **with** an
         existing pin for `member_id`, emit an `unset` to remove that pin so the expense floats to
         the new live weight; expenses without a pin already float and need no write.
   - Keep it deterministic and side-effect-free so it can be tested exactly like
     `test_per_capita.py` / `test_per_family.py`.

2. Async applier (Motor):
   - `apply_reallocation(trip_id: str, plan: dict, session=None) -> dict` — translate the plan into a
     single `db.expenses.bulk_write([...])` of `UpdateOne` ops using dotted-key field updates
     (`{"$set": {"weight_snapshots.<member_id>": old_weight}}` and
     `{"$unset": {"weight_snapshots.<member_id>": ""}}`), scoped by `{"id": expense_id, "trip_id":
     trip_id}`. Passes `session=session` when provided. Returns
     `{"set_count", "unset_count", "modified": <bulk modified_count>}`. Empty plan → no DB call.

3. Orchestrator used by the route:
   - `reallocate_on_member_change(trip_id, member_id, old_weight, new_weight, reweight_past,
     session=None) -> dict` — load the trip's `PER_CAPITA` expenses for that member
     (`db.expenses.find({"trip_id": trip_id, "split_member_ids": member_id, "split_mode":
     "PER_CAPITA"}, {"_id": 0})`; plus, for the `split_member_ids == []` "split among all" case, the
     planner's participant rule applies), call `plan_reallocation`, then `apply_reallocation`. Return
     its summary dict.

### Transactional execution helper
- Add `run_member_reallocation_txn(...)` (or inline in the route) that performs **both** the member
  document mutation **and** the snapshot bulk write atomically:
  - Open a Motor session (`async with await client.start_session() as s:`), `s.start_transaction()`,
    run the `db.trips.update_one(... members.$ ...)` and `apply_reallocation(..., session=s)`
    together, commit.
  - **Fallback:** standalone (non-replica-set) MongoDB raises on `start_transaction`. Catch the
    transaction-unsupported `PyMongoError`/`OperationFailure` and execute the same two writes
    **sequentially without a session** (member update first, then bulk snapshot write). Behavior is
    identical; only atomicity is best-effort on standalone deployments. Expose the Motor `client`
    from `backend/database.py` for session creation (it already constructs the
    `AsyncIOMotorClient`).

### Changed route — `backend/routes/members.py::update_member`
- Keep all current validation (unique name/email, gmail enforcement, kind/family_members
  normalization, `_trip_or_404` membership gate).
- Compute `old_weight = _weight_of_member(target)` and the prospective `new_weight` exactly as today.
- **Replace** the inline `async for e in db.expenses.find(...)` snapshot loop with a single call into
  the new transactional helper, passing `reweight_past=(body.reweight_past is not False)` (preserve
  the current default-`True` semantics).
- The member-document `$set` update now happens **inside** the transactional helper alongside the
  reallocation so the two are atomic.
- **Response shape unchanged:** still return the updated member document (re-read with `{"_id": 0}`).
  The reallocation summary is computed and may be logged, but is **not** added to or removed from the
  returned member object (frontend `edit-member.tsx` only navigates back; the observable effect is
  verified via `/balances`). Keeping the shape stable avoids regressions; surfacing a count to the UI
  is deferred to frontend Step 15.

### Routes & RBAC
- No route signature changes; `PATCH /api/trips/{trip_id}/members/{member_id}` keeps its body and
  return type.
- `_trip_or_404(trip_id, user["id"])` membership enforcement stays exactly as-is. **Admin-only**
  locking of member mutations is **Step 11** and is explicitly out of scope here — re-allocation runs
  only within an already-authorized member update. (Per CLAUDE.md ordering, RBAC tightening for
  member admin is Phase 3.)
- `/balances`, `/settle`, and the report endpoints are untouched and keep calling
  `_compute_balances`.

## App Screens & UI (Expo React Native)
- **Create:** None.
- **Modify:** None. `frontend/app/trip/[id]/edit-member.tsx` already renders a "reweight past" switch
  and already sends `reweight_past` in the PATCH body, so no client change is required for this
  backend step. The richer confirmation prompt ("Apply updates retroactively to prior expenses or
  apply to future items only?") and surfacing the affected-count is **frontend Step 15** — out of
  scope.

## State & API Integration
No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`. The request
body (`reweight_past`) and the response (updated member object) are unchanged; only the persisted
snapshots and the resulting `PER_CAPITA` balances for past expenses differ according to the toggle.

## Files to change
- `backend/routes/members.py` — replace the inline snapshot loop in `update_member` with a delegation
  to the new transactional reallocation helper; move the member-doc `$set` into the same atomic unit;
  import from `services.reallocation`.
- `backend/database.py` — export the Motor `client` (already created here) so the service can open a
  session for transactions. (No connection/config change.)
- `CLAUDE.md` — after the work is tested and committed, flip Roadmap **Step 8** from `- [ ]` to
  `- [x]`.

## Files to create
- `backend/services/reallocation.py` — pure `plan_reallocation(...)` plus the async
  `apply_reallocation(...)`, `reallocate_on_member_change(...)`, and the transactional helper.
- `backend/tests/test_reallocation.py` — **pure unit tests** for `plan_reallocation` (`from
  services.reallocation import plan_reallocation`; no HTTP, no server, no `conftest` fixtures —
  mirroring `test_per_capita.py` / `test_per_family.py`).
- `backend/tests/test_reallocation_api.py` — **integration tests** (live server, using the existing
  `api_client` / `test_user` fixtures and skip-on-unavailable pattern from `conftest.py`) proving the
  end-to-end retroactive-vs-future-only balance behavior through `/members` + `/balances`.
- `.claude/specs/08-size-mutation-calculations.md` — this spec document.

## New Dependencies
No new dependencies (Python or frontend). MongoDB transactions use the already-present `motor` /
`pymongo` packages.

## Rules for Implementation
- Respect the strict dual split-mode logic in Section 5 of `CLAUDE.md`. Re-allocation affects only
  **`PER_CAPITA`** expenses (Section 5A); **never** write `weight_snapshots` onto `PER_FAMILY`
  expenses (Section 5B says size and snapshots are irrelevant there).
- `plan_reallocation` MUST be pure: no `async`, no Motor/`database` import, no FastAPI, no network/DB
  I/O — operate only on plain dicts/lists, exactly like `split_per_capita` / `split_per_family`.
- Toggle semantics are strict and symmetric:
  - `reweight_past=False` → **freeze the past**: pin the member's **old** weight on qualifying
    past expenses that are not already pinned; **never overwrite an existing pin** (first pin wins).
  - `reweight_past=True` (default) → **recalculate the past**: remove this member's pins so past
    expenses float to the **new** live weight.
  - `old_weight == new_weight` (e.g. name/email-only edit) → **no expense writes at all**.
- The member-document update and the snapshot writes MUST be executed as one **transaction** when the
  MongoDB deployment supports it; on standalone Mongo, fall back to sequential writes without a
  session (catch the transaction-unsupported error) — never let a missing replica set break the
  feature in local/dev.
- Do not introduce any new intermediate rounding. This step only edits which weights feed
  `resolve_weights`; the single final `round(net, 2)` in `_compute_balances` stays the only rounding,
  and `sum(net) ≈ 0` must hold after any re-allocation.
- App-User identity mapping (Section 5): an app user folded into a family is part of that family's
  single entity; the family's size for weighting is its `family_members` count via
  `_weight_of_member` — do not add a folded-in app user as an extra weight or entity.
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) must remain intact; no
  ObjectIds. Snapshot writes use dotted-key `$set`/`$unset` keyed on the member UUID.
- Preserve existing RBAC: `_trip_or_404` stays; add **no** new access control (admin-only member
  mutation is Step 11).
- Keep changes strictly scoped to this step: do not touch `calculator.py`, the `PER_CAPITA` /
  `PER_FAMILY` math, the settlement algorithm, the reports pipeline, the `per_person` breakdown, the
  `update_member` response shape, or any unrelated code.

## Definition of Done
- [ ] `backend/services/reallocation.py` exists with a pure `plan_reallocation(member_id, old_weight,
      new_weight, reweight_past, expenses)` (no imports from `database`, `routes`, `utils`, FastAPI,
      or Motor) and async `apply_reallocation` / `reallocate_on_member_change` plus the transactional
      helper; `from services.reallocation import plan_reallocation` succeeds when run from `backend/`.
- [ ] `update_member` no longer contains the inline `async for ... db.expenses.update_one` snapshot
      loop; it delegates to the reallocation helper, performs the member `$set` and the snapshot
      writes atomically (transaction with standalone fallback), and returns the **unchanged** member
      document shape.
- [ ] New pure `backend/tests/test_reallocation.py` covers, at minimum:
      - `old_weight == new_weight` → empty plan (no `set`, no `unset`);
      - future-only (`reweight_past=False`) pins the **old** weight on a `PER_CAPITA` expense that
        lacks a pin;
      - future-only **preserves** a pre-existing pin (no overwrite, first pin wins);
      - retroactive (`reweight_past=True`) emits `unset` for a `PER_CAPITA` expense that **has** a
        pin, and emits **nothing** for one that has no pin;
      - `PER_FAMILY` expenses are **never** in the plan (neither `set` nor `unset`), regardless of
        toggle;
      - expenses where the member is **not** a participant (`member_id not in split_member_ids`, and
        the list is non-empty) are excluded; the `split_member_ids == []` "split among all" case
        includes the member;
      - `set_count` / `unset_count` match the emitted ops.
- [ ] New integration `backend/tests/test_reallocation_api.py` (skip-safe like the other API tests)
      proves end-to-end via `/members` + `/balances`:
      - a `PER_CAPITA` expense split across a family + an individual; growing the family's size with
        `reweight_past=True` **changes** the family's net share to reflect the new size;
      - the same setup with `reweight_past=False` leaves the **past** expense's split unchanged (old
        size preserved) while a **new** expense added afterward uses the new size;
      - in both cases `sum(net) ≈ 0` (balanced ledger preserved).
- [ ] No regression: `test_members.py`, `test_split_mode.py`, `test_per_capita.py`,
      `test_per_family.py`, `test_calculator.py`, `test_balances_reports.py`, and `test_expenses.py`
      still pass.
- [ ] `cd backend && pytest` is green across the whole suite (including the two new test files).
- [ ] `CLAUDE.md` Roadmap **Step 8** checkbox flipped to `- [x]` in the implementation commit.
