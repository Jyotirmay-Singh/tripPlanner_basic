import { isTripSettled } from '../tripSettled';

describe('isTripSettled', () => {
  it('is true when there are no suggested transfers (all nets ~0)', () => {
    expect(isTripSettled({ transfers: [] })).toBe(true);
  });

  it('is false when any transfer remains', () => {
    expect(
      isTripSettled({ transfers: [{ from_member_id: 'a', to_member_id: 'b', amount: 10 }] }),
    ).toBe(false);
  });

  it('is false while balances are still loading (null)', () => {
    expect(isTripSettled(null)).toBe(false);
  });
});
