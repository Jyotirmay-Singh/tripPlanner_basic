import {
  BALANCE_COPY,
  groupBalancesByCurrency,
  moneyUnits,
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
  it('uses integer whole units at the half-up zero boundary', () => {
    expect(moneyUnits(0.49)).toBe(0);
    expect(moneyUnits(-0.49)).toBe(0);
    expect(moneyUnits(0.5)).toBe(1);
    expect(moneyUnits(-0.5)).toBe(-1);
  });

  it('uses the same whole-unit boundary for every currency', () => {
    expect(moneyUnits(0.4, 'JPY')).toBe(0);
    expect(moneyUnits(0.5, 'JPY')).toBe(1);
    expect(moneyUnits(-0.5, 'JPY')).toBe(-1);
    expect(moneyUnits(0.49, 'KWD')).toBe(0);
    expect(moneyUnits(0.5, 'KWD')).toBe(1);
  });

  it('maps positive to owed, negative to owe with an absolute amount, and zero to settled', () => {
    expect(tripBalanceState(1250)).toEqual({
      kind: 'owed', label: BALANCE_COPY.owed, amount: 1250, units: 1250,
    });
    expect(tripBalanceState(-800)).toEqual({
      kind: 'owe', label: BALANCE_COPY.owe, amount: 800, units: -800,
    });
    expect(tripBalanceState(-0.49)).toEqual({
      kind: 'settled', label: BALANCE_COPY.settled, amount: 0, units: 0,
    });
    expect(tripBalanceState(null).kind).toBe('unavailable');
  });

  it('returns whole-unit JPY and KWD amounts', () => {
    expect(tripBalanceState(1, 'JPY')).toMatchObject({
      kind: 'owed', amount: 1, units: 1,
    });
    expect(tripBalanceState(-1.234, 'KWD')).toMatchObject({
      kind: 'owe', amount: 1, units: -1,
    });
  });
});

describe('Home currency aggregation', () => {
  it('sums in whole units within a currency and never combines unlike currencies', () => {
    expect(groupBalancesByCurrency([
      { currency: 'USD', balance: -10 },
      { currency: 'INR', balance: 1000.1 },
      { currency: 'INR', balance: 249.9 },
    ])).toEqual([
      { currency: 'INR', units: 1250, value: 1250 },
      { currency: 'USD', units: -10, value: -10 },
    ]);
  });

  it('groups JPY and KWD using the shared whole-unit scale', () => {
    expect(groupBalancesByCurrency([
      { currency: 'JPY', balance: 100 },
      { currency: 'JPY', balance: 25 },
      { currency: 'KWD', balance: 1 },
      { currency: 'KWD', balance: 2 },
    ])).toEqual([
      { currency: 'JPY', units: 125, value: 125 },
      { currency: 'KWD', units: 3, value: 3 },
    ]);
  });

  it('selects positive, negative, zero, and mixed-position copy', () => {
    expect(netPositionMessage([])).toBe('All settled up');
    expect(netPositionMessage([{ currency: 'INR', units: 100, value: 1 }])).toBe('You come out ahead');
    expect(netPositionMessage([{ currency: 'INR', units: -100, value: -1 }])).toBe('You owe overall');
    expect(netPositionMessage([
      { currency: 'INR', units: 100, value: 1 },
      { currency: 'USD', units: -100, value: -1 },
    ])).toBe('Balances vary by currency');
  });
});
