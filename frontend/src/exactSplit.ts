// Pure helpers for the EXACT split editor (Phase 22). Person-level rows roll UP to entity shares,
// exactly mirroring the backend (backend/services/custom_split.py). All arithmetic is done in integer
// currency minor units to avoid float drift. The shared vectors in shared/exact-split-vectors.json are asserted by
// BOTH this module's jest tests and the backend, so the rollup / save-gate logic can never diverge.
// DISPLAY/INPUT only — nothing here computes a balance; the backend is the source of truth and
// re-validates every EXACT expense (the frontend save-gate simply mirrors that rule).

import { familyMemberIds, FPMember } from './familyParticipation';
import { fromCurrencyUnits, toCurrencyUnits } from './currencies';

export type ExactRow = {
  /** person-level id: a family roster member id, or a standalone individual's own id. */
  memberId: string;
  /** the entity this person rolls up to: the family id, or the individual's own id. */
  entityId: string;
  /** ticked in the editor (an unticked member contributes exactly 0). */
  included: boolean;
  /** parsed amount; null when the input is blank. */
  amount: number | null;
};

/**
 * Expand trip members into person-level EXACT rows. With `custom` (edit rehydrate) a member is included
 * ⇔ its key is present, carrying that stored amount; without it (a fresh expense) every person starts
 * ticked and blank for the author to fill.
 */
export function buildExactRows(members: FPMember[], custom?: Record<string, number> | null): ExactRow[] {
  const rows: ExactRow[] = [];
  const push = (memberId: string, entityId: string) => {
    const amt = custom ? custom[memberId] : undefined;
    rows.push({ memberId, entityId, included: custom ? amt != null : true, amount: amt != null ? amt : null });
  };
  for (const m of members) {
    if (m.kind === 'family') for (const rid of familyMemberIds(m)) push(rid, m.id);
    else push(m.id, m.id);
  }
  return rows;
}

/** Person-level rows -> the `custom_amounts` payload the backend persists (included rows with a value). */
export function rowsToCustomAmounts(rows: ExactRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) if (r.included && r.amount != null && Number.isFinite(r.amount)) out[r.memberId] = r.amount;
  return out;
}

const has = (r: ExactRow): boolean => r.included && r.amount != null && Number.isFinite(r.amount);

/**
 * Sum of the included amounts vs the total. `isValid` means the sum matches the total in the
 * currency's minor units and total is positive—the same rule enforced by the backend save gate.
 */
export function reconcile(
  rows: ExactRow[],
  total: number,
  currency = 'INR',
): { assigned: number; remaining: number; isValid: boolean } {
  let assignedUnits = 0;
  for (const r of rows) {
    if (has(r)) assignedUnits += toCurrencyUnits(r.amount as number, currency);
  }
  const totalUnits = toCurrencyUnits(Math.abs(total), currency);
  return {
    assigned: fromCurrencyUnits(assignedUnits, currency),
    remaining: fromCurrencyUnits(totalUnits - assignedUnits, currency),
    isValid: totalUnits > 0 && assignedUnits === totalUnits,
  };
}

/**
 * Roll person-level rows up to `{ entityId: amount }` using currency minor units, dropping zero
 * entities. This matches the backend values consumed by the ledger.
 */
export function resolveEntityShares(rows: ExactRow[], currency = 'INR'): Record<string, number> {
  const units: Record<string, number> = {};
  for (const r of rows) {
    if (!has(r)) continue;
    units[r.entityId] =
      (units[r.entityId] ?? 0) + toCurrencyUnits(r.amount as number, currency);
  }
  const out: Record<string, number> = {};
  for (const [eid, value] of Object.entries(units)) {
    if (value !== 0) out[eid] = fromCurrencyUnits(value, currency);
  }
  return out;
}

/**
 * Fill ticked-but-blank rows with an equal share of the unassigned remainder, snapping the LAST such
 * row so the amounts sum EXACTLY to the total. Rows that already carry an amount are left untouched;
 * when there's nothing left to give, blanks become 0. Never mutates the input.
 */
export function splitRemainingEqually(
  rows: ExactRow[],
  total: number,
  currency = 'INR',
): ExactRow[] {
  const out = rows.map((r) => ({ ...r }));
  const blanks = out.filter((r) => r.included && (r.amount == null || !Number.isFinite(r.amount)));
  if (blanks.length === 0) return out;

  let assignedUnits = 0;
  for (const r of out) {
    if (has(r)) assignedUnits += toCurrencyUnits(r.amount as number, currency);
  }
  const remainingUnits = Math.max(
    0,
    toCurrencyUnits(Math.abs(total), currency) - assignedUnits,
  );
  const base = Math.floor(remainingUnits / blanks.length);

  blanks.forEach((r, i) => {
    const isLast = i === blanks.length - 1;
    const units = isLast ? remainingUnits - base * (blanks.length - 1) : base;
    r.amount = fromCurrencyUnits(units, currency);
  });
  return out;
}
