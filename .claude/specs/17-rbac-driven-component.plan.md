# Implementation Plan — Step 17: RBAC-Driven Component Hiding

> Companion to `.claude/specs/17-rbac-driven-component.md`. Incorporates the two Spec-Interview
> decisions:
> 1. **Edit screen = "Hide buttons only"** — hide `ee-save`/`ee-delete` + show a read-only note;
>    inputs stay interactive (no save path exists once the buttons are gone). *No* `editable={false}`
>    / `pointerEvents` wiring.
> 2. **Add minimal jest** — net-new frontend test infra to unit-test `canModifyExpense`.
>
> Branch: `feature/rbac-driven-component`. Backend untouched (Step 10 is authoritative).

---

## 1. Objective
Mirror the backend `can_modify_expense` rule (*creator OR trip admin*) on the client and **hide** the
transaction edit/delete affordances when it is not satisfied. Pure UX; the server remains the sole
authority. Legacy rows (missing `created_by`) → admin-only.

## 2. The shared predicate (single source of truth)
`frontend/src/permissions.ts`:
```ts
export type ExpenseLike = { created_by?: string | null };
export type TripLike = { admin_ids?: string[] | null };

export function canModifyExpense(
  expense: ExpenseLike,
  userId: string | undefined,
  trip: TripLike,
): boolean {
  if (!userId) return false;
  return expense.created_by === userId || (trip.admin_ids ?? []).includes(userId);
}
```
Mirrors `backend/utils/deps.py::can_modify_expense` exactly, including the legacy fall-through
(missing `created_by` ⇒ creator branch false ⇒ admin-only).

## 3. Files

### CREATE
| File | Purpose |
|---|---|
| `frontend/src/permissions.ts` | Pure `canModifyExpense` predicate. |
| `frontend/src/__tests__/permissions.test.ts` | Jest unit tests (full matrix). |
| `frontend/jest.config.js` | `module.exports = { preset: 'jest-expo' }` (or a `"jest"` block in `package.json`). |

### MODIFY
| File | Change |
|---|---|
| `frontend/app/trip/[id]/index.tsx` | `Expense` type gains `created_by?: string \| null`; import `canModifyExpense`; wrap the inline `expense-del-${e.id}` trash `TouchableOpacity` in `{canModifyExpense(e, user?.id, trip) && (…)}`. Row remains tappable. |
| `frontend/app/trip/[id]/edit-expense.tsx` | Widen `Trip` type (`owner_id: string`, `admin_ids: string[]`) and `Expense` type (`created_by?: string \| null`); add `useAuth()`; add `createdBy` state set during fetch; derive `canModify`; wrap `ee-save`+`ee-delete` in `{canModify && (…)}`; render `expense-readonly-note` when `!canModify`. Inputs stay interactive. |
| `frontend/package.json` | devDeps `jest`, `jest-expo`, `@types/jest`; `"test": "jest"` script; jest preset (if not a separate config file). |
| `frontend/eslint.config.js` | Add a jest-globals override for `**/*.test.ts` **iff** `expo lint` flags `describe/it/expect`. |
| `.claude/specs/17-rbac-driven-component.md` | Update edit-screen section → "hide buttons only"; add jest to *New Dependencies* + DoD. |
| `CLAUDE.md` | Flip Roadmap **Step 17** `[ ]`→`[x]` — last, only after tests pass + commit. |

## 4. Detailed edits

### 4.1 `index.tsx`
- Line ~16: extend type
  `type Expense = { …; split_member_ids: string[]; created_by?: string | null };`
- Add import: `import { canModifyExpense } from '../../../src/permissions';`
- In the Expenses-tab `expenses.map((e) => …)`, gate the trash button (currently lines ~256-272):
  ```tsx
  {canModifyExpense(e, user?.id, trip) && (
    <TouchableOpacity testID={`expense-del-${e.id}`} …>…</TouchableOpacity>
  )}
  ```
- `trip` is non-null in this scope (guarded by the earlier `if (!trip) return …`); `user` already
  from `useAuth()`.

### 4.2 `edit-expense.tsx`
- Imports: add `import { useAuth } from '../../../src/AuthContext';`
  and `import { canModifyExpense } from '../../../src/permissions';`
- Widen types:
  - `type Trip = { id: string; name: string; currency: string; owner_id: string; admin_ids: string[]; members: Member[] };`
  - `type Expense = { …; weight_snapshots?…; receipt_base64?…; created_by?: string | null };`
- State: `const { user } = useAuth();` and `const [createdBy, setCreatedBy] = useState<string | null | undefined>(undefined);`
- In the fetch effect, after locating `e`: `setCreatedBy(e.created_by ?? null);`
- Derived: `const canModify = trip ? canModifyExpense({ created_by: createdBy }, user?.id, trip) : false;`
- Read-only note (rendered only when loaded + `!canModify`), placed just under the
  `<T variant="h1">Edit transaction</T>` header:
  ```tsx
  {!canModify && (
    <View testID="expense-readonly-note"
      style={{ padding: SPACING.md, borderRadius: RADIUS.md, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border }}>
      <T variant="caption" muted>Only the person who added this transaction or a trip admin can edit it.</T>
    </View>
  )}
  ```
- Gate the action buttons (currently lines ~269-277):
  `{canModify && (<>…ee-save…ee-delete…</>)}`

### 4.3 jest infra
- `package.json`: add to `devDependencies` (versions resolved against expo SDK 54 at install time:
  `jest-expo@~54`, `jest@~29`, `@types/jest@~29`); add `"test": "jest"` to `scripts`.
- `frontend/jest.config.js`: `module.exports = { preset: 'jest-expo' };`
  (`canModifyExpense` is pure TS with no RN imports, so the preset transforms it fine.)
- `frontend/src/__tests__/permissions.test.ts` cases:
  | case | userId | created_by | admin_ids | expect |
  |---|---|---|---|---|
  | creator | `u1` | `u1` | `[]` | true |
  | admin (non-creator) | `u2` | `u1` | `[u2]` | true |
  | owner (in admin_ids) | `owner` | `u1` | `[owner]` | true |
  | plain member | `u3` | `u1` | `[u2]` | false |
  | undefined user | `undefined` | `u1` | `[u1]` | false |
  | legacy + admin | `u2` | `undefined` | `[u2]` | true |
  | legacy + member | `u3` | `undefined` | `[u2]` | false |
  | null admin_ids | `u3` | `u1` | `null`/absent | false (and no throw) |

## 5. State management
No new global state or context. `index.tsx` reuses existing `user`/`trip`. `edit-expense.tsx` adds
one `useAuth()` call + one `createdBy` field; `canModify` is derived, not stored. Accepted nuance:
until `createdBy` resolves, a *creator* may briefly not see the buttons (admins still do via
`admin_ids`); sub-frame, no extra gating added.

## 6. Styles
Read-only note uses only `useTheme()` colors + `SPACING`/`RADIUS` tokens (`surfaceMuted` bg,
`border`, muted caption). No hardcoded hex → correct in light/dark.

## 7. Testing strategy
- **FE unit:** `cd frontend && yarn test` → `permissions.test.ts` matrix green.
- **FE lint:** `cd frontend && yarn lint` clean for changed/created files (+ test file).
- **Backend regression (no code change here):**
  `cd backend && pytest tests/test_expense_rbac.py tests/test_expenses.py tests/test_rbac.py`.
  ⚠️ Integration tests hit a live `BASE_URL` (need uvicorn + MongoDB). Run if reachable; otherwise
  report honestly — do not claim a pass that wasn't observed.

## 8. Incremental task order (verify after each)
1. **Spec sync** — update `17-…md` for the two decisions.
2. **Predicate** — create `permissions.ts`.
3. **Jest infra** — package.json + config + `permissions.test.ts`; `yarn install` → `yarn test` green.
4. **List gate** — `index.tsx` trash gating; `yarn lint`.
5. **Edit gate** — `edit-expense.tsx` hide buttons + note; `yarn lint`.
6. **Full verify** — `yarn lint` clean; backend regression pytest (as reachable).
7. **Roadmap + commit** — flip `CLAUDE.md` Step 17; stage commit.

## 9. Risks / call-outs
- `yarn install` for jest needs network; if blocked, leave config+test in place and report the
  deviation rather than fake a green run.
- `eslint-config-expo` (eslint 9 flat) may flag jest globals → add a scoped `**/*.test.ts` override.
- Backend integration tests require a live server; see §7.

## 10. Definition of Done (delta from spec)
Spec DoD applies, with the unauthorized-edit-screen bullet reinterpreted as **"Save/Delete hidden +
`expense-readonly-note` shown; inputs remain interactive"** (per decision 1), plus a new bullet:
**"`yarn test` runs `permissions.test.ts` and the predicate matrix passes."**
