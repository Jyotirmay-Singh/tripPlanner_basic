import {
  BALANCE_COPY,
  groupBalancesByCurrency,
  moneyCents,
  netPositionMessage,
  resolveUserTripBalance,
  tripBalanceState,
  type TripBalancePayload,
} from '../tripBalance';

const payload = (over: Partial<TripBalancePayload> = {}): TripBalancePayload => ({
  net: { individual: 1250, family: -800 },
  currency: 'INR',
  members: [
    { id: 'individual', name: 'A', kind: 'individual', user_id: 'u1' },
    {
      id: 'family', name: 'Family', kind: 'family',
      family_member_ids: ['person-a', 'person-b'],
      family_member_user_ids: ['u2', 'u3'],
    },
  ],
  per_person: [{
    member_id: 'family', net_per_person: -400,
    members: [
      { id: 'person-a', name: 'Person A', net: 0 },
      { id: 'person-b', name: 'Person B', net: -800 },
    ],
  }],
  ...over,
});

describe('authenticated trip balance resolution', () => {
  it('uses the entity net for a standalone authenticated person', () => {
    expect(resolveUserTripBalance(payload(), 'u1')).toBe(1250);
  });

  it('uses the exact family sub-member row instead of the family entity total', () => {
    expect(resolveUserTripBalance(payload(), 'u2')).toBe(0);
    expect(resolveUserTripBalance(payload(), 'u3')).toBe(-800);
  });

  it('returns unavailable for a missing identity or invalid value', () => {
    expect(resolveUserTripBalance(payload(), 'missing')).toBeNull();
    expect(resolveUserTripBalance(payload({ net: { individual: Number.NaN } }), 'u1')).toBeNull();
  });
});

describe('trip balance presentation', () => {
  it('uses integer cents for the currency-rounded zero boundary', () => {
    expect(moneyCents(0.004)).toBe(0);
    expect(moneyCents(-0.004)).toBe(0);
    expect(moneyCents(0.005)).toBe(1);
    expect(moneyCents(-0.005)).toBe(-1);
  });

  it('maps positive to owed, negative to owe with an absolute amount, and zero to settled', () => {
    expect(tripBalanceState(1250)).toEqual({
      kind: 'owed', label: BALANCE_COPY.owed, amount: 1250, cents: 125000,
    });
    expect(tripBalanceState(-800)).toEqual({
      kind: 'owe', label: BALANCE_COPY.owe, amount: 800, cents: -80000,
    });
    expect(tripBalanceState(-0.004)).toEqual({
      kind: 'settled', label: BALANCE_COPY.settled, amount: 0, cents: 0,
    });
    expect(tripBalanceState(null).kind).toBe('unavailable');
  });
});

describe('Home currency aggregation', () => {
  it('sums in cents within a currency and never combines unlike currencies', () => {
    expect(groupBalancesByCurrency([
      { currency: 'USD', balance: -10 },
      { currency: 'INR', balance: 1000.1 },
      { currency: 'INR', balance: 249.9 },
    ])).toEqual([
      { currency: 'INR', cents: 125000, value: 1250 },
      { currency: 'USD', cents: -1000, value: -10 },
    ]);
  });

  it('selects positive, negative, zero, and mixed-position copy', () => {
    expect(netPositionMessage([])).toBe('All settled up');
    expect(netPositionMessage([{ currency: 'INR', cents: 100, value: 1 }])).toBe('You come out ahead');
    expect(netPositionMessage([{ currency: 'INR', cents: -100, value: -1 }])).toBe('You owe overall');
    expect(netPositionMessage([
      { currency: 'INR', cents: 100, value: 1 },
      { currency: 'USD', cents: -100, value: -1 },
    ])).toBe('Balances vary by currency');
  });
});
