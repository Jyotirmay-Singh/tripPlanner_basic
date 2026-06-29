import { rankSpend, SpendEntity } from '../spend';

const mk = (over: Partial<SpendEntity> & { entity_id: string; paid: number }): SpendEntity => ({
  entity_type: over.entity_type ?? 'individual',
  name: over.name ?? over.entity_id,
  expense_count: over.expense_count ?? 1,
  ...over,
});

describe('rankSpend', () => {
  it('sorts descending by paid and assigns ranks', () => {
    const ranked = rankSpend([
      mk({ entity_id: 'a', paid: 10 }),
      mk({ entity_id: 'b', paid: 30 }),
      mk({ entity_id: 'c', paid: 20 }),
    ]);
    expect(ranked.map((r) => r.entity_id)).toEqual(['b', 'c', 'a']);
    expect(ranked.map((r) => r.rank)).toEqual([0, 1, 2]);
  });

  it('scales fraction to the top spender (top = 1)', () => {
    const ranked = rankSpend([
      mk({ entity_id: 'a', paid: 100 }),
      mk({ entity_id: 'b', paid: 25 }),
    ]);
    expect(ranked[0].fraction).toBe(1);
    expect(ranked[1].fraction).toBe(0.25);
  });

  it('breaks ties by name (case-insensitive) then entity_id', () => {
    const ranked = rankSpend([
      mk({ entity_id: 'z', paid: 50, name: 'beta' }),
      mk({ entity_id: 'y', paid: 50, name: 'Alpha' }),
      mk({ entity_id: 'x2', paid: 50, name: 'Alpha' }),
      mk({ entity_id: 'x1', paid: 50, name: 'Alpha' }),
    ]);
    // All paid equal: Alpha before beta; among the three Alphas, by entity_id asc.
    expect(ranked.map((r) => r.entity_id)).toEqual(['x1', 'x2', 'y', 'z']);
  });

  it('preserves entity_type (family vs individual)', () => {
    const ranked = rankSpend([
      mk({ entity_id: 'fam', paid: 40, entity_type: 'family' }),
      mk({ entity_id: 'ind', paid: 10, entity_type: 'individual' }),
    ]);
    expect(ranked[0].entity_type).toBe('family');
    expect(ranked[1].entity_type).toBe('individual');
  });

  it('zero-spend entities all get fraction 0 and sort after spenders', () => {
    const ranked = rankSpend([
      mk({ entity_id: 'a', paid: 0, name: 'Ann' }),
      mk({ entity_id: 'b', paid: 0, name: 'Bob' }),
      mk({ entity_id: 'c', paid: 5, name: 'Cat' }),
    ]);
    expect(ranked.map((r) => r.entity_id)).toEqual(['c', 'a', 'b']);
    expect(ranked[1].fraction).toBe(0);
    expect(ranked[2].fraction).toBe(0);
  });

  it('all-zero list yields all fraction 0 (no divide-by-zero)', () => {
    const ranked = rankSpend([mk({ entity_id: 'a', paid: 0 }), mk({ entity_id: 'b', paid: 0 })]);
    expect(ranked.every((r) => r.fraction === 0)).toBe(true);
  });

  it('single entity gets fraction 1', () => {
    const ranked = rankSpend([mk({ entity_id: 'solo', paid: 99 })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].fraction).toBe(1);
  });

  it('empty / nullish input yields []', () => {
    expect(rankSpend([])).toEqual([]);
    expect(rankSpend(null)).toEqual([]);
    expect(rankSpend(undefined)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [mk({ entity_id: 'a', paid: 1 }), mk({ entity_id: 'b', paid: 2 })];
    const snapshot = input.map((e) => e.entity_id);
    rankSpend(input);
    expect(input.map((e) => e.entity_id)).toEqual(snapshot);
  });
});
