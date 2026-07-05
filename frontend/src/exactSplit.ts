// Pure helpers for the EXACT split editor (Phase 22). Person-level rows roll UP to entity shares,
// exactly mirroring the backend (backend/services/custom_split.py). All arithmetic is done in integer
// CENTS to avoid float drift. The shared vectors in shared/exact-split-vectors.json are asserted by
// BOTH this module's jest tests and the backend, so the rollup / save-gate logic can never diverge.
// DISPLAY/INPUT only — nothing here computes a balance; the backend is the source of truth and
// re-validates every EXACT expense (the frontend save-gate simply mirrors that rule).

import { familyMemberIds, FPMember } from './familyParticipation';

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

const cents = (n: number): number => Math.round(n * 100);
const has = (r: ExactRow): boolean => r.included && r.amount != null && Number.isFinite(r.amount);

/**
 * Σ of the included amounts vs the total. `isValid` ⇔ the sum matches the total to the cent AND
 * total > 0 — the mirror of the backend save-gate: an EXACT expense cannot be saved unless the
 * per-person amounts add up to the total.
 */
export function reconcile(
  rows: ExactRow[],
  total: number,
): { assigned: number; remaining: number; isValid: boolean } {
  let assignedC = 0;
  for (const r of rows) if (has(r)) assignedC += cents(r.amount as number);
  const totalC = cents(total);
  return {
    assigned: assignedC / 100,
    remaining: (totalC - assignedC) / 100,
    isValid: totalC > 0 && assignedC === totalC,
  };
}

/**
 * Roll person-level rows UP to `{ entityId: amount }`, cent-safe, dropping zero entities — the exact
 * shape and values the backend `resolve_exact_entity_shares` produces for the ledger.
 */
export function resolveEntityShares(rows: ExactRow[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const r of rows) {
    if (!has(r)) continue;
    c[r.entityId] = (c[r.entityId] ?? 0) + cents(r.amount as number);
  }
  const out: Record<string, number> = {};
  for (const [eid, v] of Object.entries(c)) if (v !== 0) out[eid] = v / 100;
  return out;
}

/**
 * Fill ticked-but-blank rows with an equal share of the unassigned remainder, snapping the LAST such
 * row so the amounts sum EXACTLY to the total. Rows that already carry an amount are left untouched;
 * when there's nothing left to give, blanks become 0. Never mutates the input.
 */
export function splitRemainingEqually(rows: ExactRow[], total: number): ExactRow[] {
  const out = rows.map((r) => ({ ...r }));
  const blanks = out.filter((r) => r.included && (r.amount == null || !Number.isFinite(r.amount)));
  if (blanks.length === 0) return out;

  let assignedC = 0;
  for (const r of out) if (has(r)) assignedC += cents(r.amount as number);
  const remainingC = Math.max(0, cents(total) - assignedC);
  const base = Math.floor(remainingC / blanks.length);

  blanks.forEach((r, i) => {
    const isLast = i === blanks.length - 1;
    r.amount = (isLast ? remainingC - base * (blanks.length - 1) : base) / 100;
  });
  return out;
}
