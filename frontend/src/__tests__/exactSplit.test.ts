import { readFileSync } from 'fs';
import { join } from 'path';

import { ExactRow, reconcile, resolveEntityShares, splitRemainingEqually } from '../exactSplit';

// Shared vectors are read from the repo-root fixture that the backend also asserts against, so the
// person->entity rollup and the reconcile/save-gate logic cannot drift between the two layers.
const vectors = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'shared', 'exact-split-vectors.json'), 'utf8'),
) as {
  reconcile: {
    name: string; total: number; rows: ExactRow[];
    assigned: number; remaining: number; isValid: boolean; entityShares: Record<string, number>;
  }[];
  splitRemaining: { name: string; total: number; rows: ExactRow[]; expectedAmounts: Record<string, number> }[];
};

const row = (over: Partial<ExactRow>): ExactRow => ({
  memberId: over.memberId ?? 'm',
  entityId: over.entityId ?? over.memberId ?? 'm',
  included: over.included ?? true,
  amount: over.amount ?? null,
});

describe('reconcile', () => {
  it('is valid only when the sum equals a positive total', () => {
    const rows = [row({ memberId: 'a', amount: 80 }), row({ memberId: 'b', amount: 20 })];
    expect(reconcile(rows, 100)).toEqual({ assigned: 100, remaining: 0, isValid: true });
  });
  it('is invalid when under', () => {
    const r = reconcile([row({ memberId: 'a', amount: 80 })], 100);
    expect(r).toEqual({ assigned: 80, remaining: 20, isValid: false });
  });
  it('is invalid when over', () => {
    const r = reconcile([row({ memberId: 'a', amount: 120 })], 100);
    expect(r).toEqual({ assigned: 120, remaining: -20, isValid: false });
  });
  it('is invalid when total is 0 even if it "matches"', () => {
    expect(reconcile([row({ memberId: 'a', amount: 0 })], 0).isValid).toBe(false);
  });
  it('ignores unticked and blank rows', () => {
    const rows = [
      row({ memberId: 'a', amount: 100 }),
      row({ memberId: 'b', included: false, amount: 50 }),
      row({ memberId: 'c', amount: null }),
    ];
    expect(reconcile(rows, 100)).toEqual({ assigned: 100, remaining: 0, isValid: true });
  });
});

describe('resolveEntityShares', () => {
  it('rolls family members up to their entity and keeps individuals', () => {
    const rows = [
      row({ memberId: 'a1', entityId: 'fA', amount: 80 }),
      row({ memberId: 'a2', entityId: 'fA', amount: 10 }),
      row({ memberId: 'i1', entityId: 'i1', amount: 10 }),
    ];
    expect(resolveEntityShares(rows)).toEqual({ fA: 90, i1: 10 });
  });
  it('excludes an unticked family member (contributes 0)', () => {
    const rows = [
      row({ memberId: 'a1', entityId: 'fA', amount: 80 }),
      row({ memberId: 'a2', entityId: 'fA', included: false, amount: null }),
      row({ memberId: 'i1', entityId: 'i1', amount: 10 }),
    ];
    expect(resolveEntityShares(rows)).toEqual({ fA: 80, i1: 10 });
  });
});

describe('splitRemainingEqually', () => {
  it('distributes the remainder and snaps the last row so the sum is exact', () => {
    const rows = ['a', 'b', 'c'].map((m) => row({ memberId: m }));
    const out = splitRemainingEqually(rows, 100);
    expect(out.map((r) => r.amount)).toEqual([33.33, 33.33, 33.34]);
    expect(out.reduce((s, r) => s + Math.round((r.amount ?? 0) * 100), 0)).toBe(10000);
  });
  it('fills only the blanks and leaves set amounts alone', () => {
    const rows = [row({ memberId: 'a', amount: 40 }), row({ memberId: 'b' }), row({ memberId: 'c' })];
    expect(splitRemainingEqually(rows, 100).map((r) => r.amount)).toEqual([40, 30, 30]);
  });
  it('does not mutate the input', () => {
    const rows = [row({ memberId: 'a' }), row({ memberId: 'b' })];
    splitRemainingEqually(rows, 100);
    expect(rows.every((r) => r.amount === null)).toBe(true);
  });
});

describe('shared vectors (must match the backend)', () => {
  it.each(vectors.reconcile.map((v) => [v.name, v] as const))('reconcile: %s', (_name, v) => {
    const r = reconcile(v.rows, v.total);
    expect(r.assigned).toBeCloseTo(v.assigned, 2);
    expect(r.remaining).toBeCloseTo(v.remaining, 2);
    expect(r.isValid).toBe(v.isValid);
    expect(resolveEntityShares(v.rows)).toEqual(v.entityShares);
  });

  it.each(vectors.splitRemaining.map((v) => [v.name, v] as const))('splitRemaining: %s', (_name, v) => {
    const out = splitRemainingEqually(v.rows, v.total);
    const byId = Object.fromEntries(out.map((r) => [r.memberId, r.amount]));
    for (const [mid, amt] of Object.entries(v.expectedAmounts)) expect(byId[mid]).toBeCloseTo(amt, 2);
    // filled result must reconcile exactly to the total
    expect(reconcile(out, v.total).isValid).toBe(true);
  });
});
