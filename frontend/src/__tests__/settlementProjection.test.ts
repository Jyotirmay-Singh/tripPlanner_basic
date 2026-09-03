import {
  currentSuggestedAmount,
  formatPreciseMoney,
  usesWholeUnits,
} from '../settlementProjection';

describe('settlement projection compatibility helpers', () => {
  it('recognizes only an enabled one-unit projection', () => {
    expect(usesWholeUnits(undefined)).toBe(false);
    expect(usesWholeUnits({ enabled: false, increment: '1' } as any)).toBe(false);
    expect(usesWholeUnits({ enabled: true, increment: '1' } as any)).toBe(true);
  });

  it('formats precise strings without converting them through binary float', () => {
    expect(formatPreciseMoney('1249.670000000000', 'LKR')).toBe('LKR 1,249.67');
    expect(formatPreciseMoney('-0.000000000001', 'NPR')).toBe('NPR -0.000000000001');
    expect(formatPreciseMoney('3.000000000000', 'LKR')).toBe('LKR 3.00');
  });

  it('finds only the currently suggested direction', () => {
    const transfers = [{ from_member_id: 'a', to_member_id: 'b', amount: 10 }];
    expect(currentSuggestedAmount(transfers, 'a', 'b')).toBe(10);
    expect(currentSuggestedAmount(transfers, 'b', 'a')).toBe(0);
  });
});
