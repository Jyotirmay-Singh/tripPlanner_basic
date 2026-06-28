import {
  partitionSettlements,
  isRecorded,
  statusLabel,
  Settlement,
} from '../settlements';

const mk = (over: Partial<Settlement>): Settlement => ({
  id: over.id ?? 'sid',
  from_member_id: over.from_member_id ?? 'a',
  to_member_id: over.to_member_id ?? 'b',
  amount: over.amount ?? 10,
  status: over.status ?? 'pending',
  created_at: over.created_at ?? '2026-01-01T00:00:00+00:00',
  paid_at: over.paid_at ?? null,
  note: over.note ?? null,
});

describe('partitionSettlements', () => {
  it('splits pending vs paid', () => {
    const list = [
      mk({ id: '1', status: 'pending' }),
      mk({ id: '2', status: 'paid', paid_at: '2026-02-01T00:00:00+00:00' }),
    ];
    const { pending, paid } = partitionSettlements(list);
    expect(pending.map((s) => s.id)).toEqual(['1']);
    expect(paid.map((s) => s.id)).toEqual(['2']);
  });

  it('sorts pending newest-first by created_at', () => {
    const list = [
      mk({ id: 'old', status: 'pending', created_at: '2026-01-01T00:00:00+00:00' }),
      mk({ id: 'new', status: 'pending', created_at: '2026-03-01T00:00:00+00:00' }),
    ];
    expect(partitionSettlements(list).pending.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('sorts paid newest-first by paid_at, falling back to created_at', () => {
    const list = [
      mk({ id: 'p1', status: 'paid', paid_at: '2026-01-05T00:00:00+00:00' }),
      mk({ id: 'p2', status: 'paid', paid_at: '2026-04-05T00:00:00+00:00' }),
      mk({ id: 'p3', status: 'paid', paid_at: null, created_at: '2026-06-05T00:00:00+00:00' }),
    ];
    expect(partitionSettlements(list).paid.map((s) => s.id)).toEqual(['p3', 'p2', 'p1']);
  });

  it('tolerates null/undefined/empty input', () => {
    expect(partitionSettlements(null)).toEqual({ pending: [], paid: [] });
    expect(partitionSettlements(undefined)).toEqual({ pending: [], paid: [] });
    expect(partitionSettlements([])).toEqual({ pending: [], paid: [] });
  });

  it('does not mutate the input array', () => {
    const list = [
      mk({ id: 'a', status: 'pending', created_at: '2026-01-01T00:00:00+00:00' }),
      mk({ id: 'b', status: 'pending', created_at: '2026-02-01T00:00:00+00:00' }),
    ];
    partitionSettlements(list);
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('isRecorded', () => {
  const pending = [mk({ from_member_id: 'a', to_member_id: 'b', amount: 100 })];

  it('matches a pending record with same from/to and amount within a cent', () => {
    expect(isRecorded({ from_member_id: 'a', to_member_id: 'b', amount: 100 }, pending)).toBe(true);
    expect(isRecorded({ from_member_id: 'a', to_member_id: 'b', amount: 100.004 }, pending)).toBe(true);
  });

  it('does not match a different from/to or an amount off by more than a cent', () => {
    expect(isRecorded({ from_member_id: 'b', to_member_id: 'a', amount: 100 }, pending)).toBe(false);
    expect(isRecorded({ from_member_id: 'a', to_member_id: 'c', amount: 100 }, pending)).toBe(false);
    expect(isRecorded({ from_member_id: 'a', to_member_id: 'b', amount: 100.5 }, pending)).toBe(false);
  });

  it('returns false against an empty pending list', () => {
    expect(isRecorded({ from_member_id: 'a', to_member_id: 'b', amount: 100 }, [])).toBe(false);
  });
});

describe('statusLabel', () => {
  it('maps status to a human label', () => {
    expect(statusLabel({ status: 'paid' })).toBe('Paid');
    expect(statusLabel({ status: 'pending' })).toBe('Pending');
  });
});
