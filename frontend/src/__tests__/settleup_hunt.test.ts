// BREAK-IT-ALL QA campaign — frontend Settle-Up state/validation probes (Phase 20).
// Exercises src/payments.ts the way settle-up.tsx consumes it: the active/settled partition, the
// open->partial->paid badge state machine, the record/edit "Max" caps, and validatePaymentAmount
// against adversarial input (0, negative, NaN, Infinity, sub-cent boundary).
import {
  paymentStatus,
  buildPairBlocks,
  originalPayable,
  validatePaymentAmount,
  Payment,
  PairBlock,
} from '../payments';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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

// Mirror the partition settle-up.tsx renders: active vs settled at the 0.01 boundary.
const partition = (blocks: PairBlock[]) => ({
  active: blocks.filter((b) => b.current_payable > 0.01),
  settled: blocks.filter((b) => b.current_payable <= 0.01),
});

describe('badge state machine (open -> partial -> paid)', () => {
  it('walks a pair through every badge as payments land', () => {
    // open
    expect(paymentStatus(100, 0)).toBe('open');
    // partial (greedy residual 60 after paying 40)
    expect(paymentStatus(60, 40)).toBe('partial');
    // paid (residual cleared)
    expect(paymentStatus(0, 100)).toBe('paid');
  });

  it('treats a sub-cent residual as paid but a sub-cent payment as still open', () => {
    expect(paymentStatus(0.01, 100)).toBe('paid');
    expect(paymentStatus(0.0101, 100)).toBe('partial');
    expect(paymentStatus(100, 0.01)).toBe('open');
  });
});

describe('active vs settled partition (mirrors settle-up.tsx)', () => {
  it('routes an in-progress pair to active with a Partially Paid badge', () => {
    const { active, settled } = partition(
      buildPairBlocks(
        [{ from_member_id: 'ram', to_member_id: 'shyam', amount: 300 }],
        [pay({ from_member_id: 'ram', to_member_id: 'shyam', amount: 200 })],
      ),
    );
    expect(active).toHaveLength(1);
    expect(settled).toHaveLength(0);
    expect(active[0].status).toBe('partial');
    // progress bar fraction stays within [0,1]
    const frac = active[0].paid / active[0].original_payable;
    expect(frac).toBeGreaterThanOrEqual(0);
    expect(frac).toBeLessThanOrEqual(1);
    expect(frac).toBeCloseTo(200 / 500, 5);
  });

  it('routes a fully-paid direction to settled with a Paid badge', () => {
    const { active, settled } = partition(
      buildPairBlocks(
        [{ from_member_id: 'gita', to_member_id: 'shyam', amount: 200 }],
        [pay({ from_member_id: 'ram', to_member_id: 'shyam', amount: 200 })],
      ),
    );
    expect(active.map((b) => b.from_member_id)).toEqual(['gita']);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ from_member_id: 'ram', status: 'paid', current_payable: 0 });
  });
});

describe('record/edit "Max" caps (mirrors openRecord/openEdit in settle-up.tsx)', () => {
  const blocks = buildPairBlocks(
    [{ from_member_id: 'ram', to_member_id: 'shyam', amount: 300 }],
    [pay({ id: 'p1', from_member_id: 'ram', to_member_id: 'shyam', amount: 200 })],
  );
  const b = blocks[0];

  it('record max == current payable', () => {
    expect(b.current_payable).toBe(300);
  });

  it('edit max == current residual + this payment (== original debt minus other payments)', () => {
    const p = b.payments[0];
    const editMax = round2(b.current_payable + p.amount);
    expect(editMax).toBe(500);
    expect(editMax).toBe(originalPayable(b.current_payable, p.amount));
  });
});

describe('validatePaymentAmount — adversarial input', () => {
  it('rejects 0 and negative', () => {
    expect(validatePaymentAmount(0, 100).ok).toBe(false);
    expect(validatePaymentAmount(-50, 100).ok).toBe(false);
  });

  it('rejects NaN and Infinity (frontend guards where the backend does not)', () => {
    expect(validatePaymentAmount(NaN, 100).ok).toBe(false);
    expect(validatePaymentAmount(Infinity, 100).ok).toBe(false);
    expect(validatePaymentAmount(-Infinity, 100).ok).toBe(false);
  });

  it('caps at max + 1 cent tolerance', () => {
    expect(validatePaymentAmount(100.5, 100).ok).toBe(false);
    expect(validatePaymentAmount(100.004, 100).ok).toBe(true);
    expect(validatePaymentAmount(100, 100)).toEqual({ ok: true, error: null });
  });

  it('accepts a valid partial amount', () => {
    expect(validatePaymentAmount(40, 100).ok).toBe(true);
  });
});
