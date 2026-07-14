import { isTripSettled, isTripSettledWithActivity } from '../tripSettled';

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

describe('isTripSettledWithActivity (Trips-list badge)', () => {
  const oneTransfer = { transfers: [{ from_member_id: 'a', to_member_id: 'b', amount: 10 }] };

  it('is true only when the trip has real spend AND no residual', () => {
    expect(isTripSettledWithActivity({ transfers: [] }, true)).toBe(true);
  });

  it('is false for an empty (zero-expense) trip even though it has no residual', () => {
    expect(isTripSettledWithActivity({ transfers: [] }, false)).toBe(false);
  });

  it('is false when a residual transfer remains, regardless of activity', () => {
    expect(isTripSettledWithActivity(oneTransfer, true)).toBe(false);
  });

  it('is false while balances are still loading (null)', () => {
    expect(isTripSettledWithActivity(null, true)).toBe(false);
  });
});
