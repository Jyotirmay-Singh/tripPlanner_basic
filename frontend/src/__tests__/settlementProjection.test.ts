import {
  currentSuggestedAmount,
  usesWholeUnits,
} from '../settlementProjection';

describe('settlement projection compatibility helpers', () => {
  it('recognizes only an enabled one-unit projection', () => {
    expect(usesWholeUnits(undefined)).toBe(false);
    expect(usesWholeUnits({ enabled: false, increment: '1' } as any)).toBe(false);
    expect(usesWholeUnits({ enabled: true, increment: '1' } as any)).toBe(true);
  });

  it('finds only the currently suggested direction', () => {
    const transfers = [{ from_member_id: 'a', to_member_id: 'b', amount: 10 }];
    expect(currentSuggestedAmount(transfers, 'a', 'b')).toBe(10);
    expect(currentSuggestedAmount(transfers, 'b', 'a')).toBe(0);
  });
});
