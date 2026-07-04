import {
  paymentsForPair,
  pairPaid,
  paymentStatus,
  originalPayable,
  buildPairBlocks,
  validatePaymentAmount,
  Payment,
} from '../payments';

const pay = (over: Partial<Payment>): Payment => ({
  id: over.id ?? 'pid',
  from_member_id: over.from_member_id ?? 'a',
  to_member_id: over.to_member_id ?? 'b',
  amount: over.amount ?? 10,
  currency: over.currency ?? 'INR',
  created_at: over.created_at ?? '2026-07-01T00:00:00+00:00',
  recorded_by: over.recorded_by ?? 'u',
  note: over.note ?? null,
});

describe('paymentStatus', () => {
  it('is open when nothing is paid', () => {
    expect(paymentStatus(100, 0)).toBe('open');
  });
  it('is partial when some paid and some left', () => {
    expect(paymentStatus(60, 40)).toBe('partial');
  });
  it('is paid when the residual is cleared', () => {
    expect(paymentStatus(0, 100)).toBe('paid');
    expect(paymentStatus(0.005, 100)).toBe('paid');
  });
  it('treats a sub-cent payment as still open', () => {
    expect(paymentStatus(100, 0.005)).toBe('open');
  });
});

describe('originalPayable', () => {
  it('adds paid back onto the residual', () => {
    expect(originalPayable(300, 200)).toBe(500);
  });
});

describe('paymentsForPair / pairPaid', () => {
  const list = [
    pay({ id: '1', from_member_id: 'a', to_member_id: 'b', amount: 30, created_at: '2026-07-01' }),
    pay({ id: '2', from_member_id: 'a', to_member_id: 'b', amount: 20, created_at: '2026-07-03' }),
    pay({ id: '3', from_member_id: 'c', to_member_id: 'b', amount: 99, created_at: '2026-07-02' }),
  ];
  it('filters to the exact direction, newest-first', () => {
    expect(paymentsForPair(list, 'a', 'b').map((p) => p.id)).toEqual(['2', '1']);
  });
  it('sums the direction', () => {
    expect(pairPaid(list, 'a', 'b')).toBe(50);
    expect(pairPaid(list, 'c', 'b')).toBe(99);
    expect(pairPaid(list, 'b', 'a')).toBe(0);
  });
  it('tolerates null input', () => {
    expect(paymentsForPair(null, 'a', 'b')).toEqual([]);
    expect(pairPaid(undefined, 'a', 'b')).toBe(0);
  });
});

describe('buildPairBlocks', () => {
  it('makes an open block for a suggestion with no payments', () => {
    const blocks = buildPairBlocks([{ from_member_id: 'a', to_member_id: 'b', amount: 100 }], []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ status: 'open', paid: 0, current_payable: 100, original_payable: 100 });
  });

  it('makes a partial block when a suggestion still has payments', () => {
    const blocks = buildPairBlocks(
      [{ from_member_id: 'ram', to_member_id: 'shyam', amount: 300 }],
      [pay({ from_member_id: 'ram', to_member_id: 'shyam', amount: 200 })],
    );
    expect(blocks[0]).toMatchObject({ status: 'partial', paid: 200, current_payable: 300, original_payable: 500 });
  });

  it('adds a settled paid block for a direction no longer suggested', () => {
    const blocks = buildPairBlocks(
      [{ from_member_id: 'gita', to_member_id: 'shyam', amount: 200 }],
      [pay({ from_member_id: 'ram', to_member_id: 'shyam', amount: 200 })],
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ from_member_id: 'gita', status: 'open' });
    expect(blocks[1]).toMatchObject({ from_member_id: 'ram', to_member_id: 'shyam', status: 'paid', current_payable: 0, paid: 200 });
  });

  it('reconciles: sum of block.paid equals sum of payment amounts', () => {
    const payments = [
      pay({ from_member_id: 'a', to_member_id: 'b', amount: 5 }),
      pay({ from_member_id: 'c', to_member_id: 'd', amount: 7.5 }),
    ];
    const blocks = buildPairBlocks([{ from_member_id: 'a', to_member_id: 'b', amount: 10 }], payments);
    const totalPaid = blocks.reduce((s, b) => s + b.paid, 0);
    expect(totalPaid).toBeCloseTo(12.5, 2);
  });
});

describe('validatePaymentAmount', () => {
  it('rejects non-positive amounts', () => {
    expect(validatePaymentAmount(0, 100).ok).toBe(false);
    expect(validatePaymentAmount(-5, 100).ok).toBe(false);
    expect(validatePaymentAmount(NaN, 100).ok).toBe(false);
  });
  it('rejects overpayment beyond a cent of tolerance', () => {
    expect(validatePaymentAmount(100.5, 100).ok).toBe(false);
  });
  it('accepts a valid amount up to the max (with cent tolerance)', () => {
    expect(validatePaymentAmount(100, 100)).toEqual({ ok: true, error: null });
    expect(validatePaymentAmount(100.004, 100).ok).toBe(true);
    expect(validatePaymentAmount(40, 100).ok).toBe(true);
  });
});
