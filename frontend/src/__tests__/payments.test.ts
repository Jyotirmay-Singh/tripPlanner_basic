import {
  paymentsForPair,
  pairPaid,
  paymentStatus,
  originalPayable,
  buildPairBlocks,
  validatePaymentAmount,
  snapshotPaymentRecipient,
  paymentRecipientRequiresReview,
  paymentHandoffRequiresReview,
  activePaymentAttemptForDirection,
  validateTransactionReference,
  Payment,
  PaymentAttempt,
  PaymentHandoffPreview,
  PaymentRecipientCandidate,
  PaymentRecipientDetails,
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

describe('recipient-confirmed UPI attempts', () => {
  const attempt = (status: PaymentAttempt['status']): PaymentAttempt => ({
    id: `attempt-${status}`,
    from_member_id: 'a',
    to_member_id: 'b',
    status,
  } as PaymentAttempt);

  it('blocks only unresolved directions', () => {
    expect(activePaymentAttemptForDirection([attempt('awaiting_confirmation')], 'a', 'b')?.id)
      .toBe('attempt-awaiting_confirmation');
    expect(activePaymentAttemptForDirection([attempt('settled_recipient_confirmed')], 'a', 'b'))
      .toBeNull();
    expect(activePaymentAttemptForDirection([attempt('needs_review')], 'b', 'a')).toBeNull();
  });

  it('normalizes optional references without calling them verified', () => {
    expect(validateTransactionReference('   ')).toEqual({ ok: true, value: null, error: null });
    expect(validateTransactionReference('  UTR-123  ')).toEqual({
      ok: true, value: 'UTR-123', error: null,
    });
    expect(validateTransactionReference('bad\nreference').ok).toBe(false);
    expect(validateTransactionReference('x'.repeat(101)).ok).toBe(false);
    expect(validateTransactionReference('😀'.repeat(100)).ok).toBe(true);
    expect(validateTransactionReference('😀'.repeat(101)).ok).toBe(false);
  });
});

const recipient = (
  over: Partial<PaymentRecipientCandidate> = {},
): PaymentRecipientCandidate => ({
  person_id: over.person_id ?? 'recipient-person',
  name: over.name ?? 'Recipient Person',
  family_id: over.family_id ?? null,
  family_name: over.family_name ?? null,
  account_linked: over.account_linked ?? true,
  upi_id: over.upi_id === undefined ? 'recipient@upi' : over.upi_id,
  upi_updated_at: over.upi_updated_at === undefined
    ? '2026-09-11T10:00:00+00:00'
    : over.upi_updated_at,
});

const recipientDetails = (
  recipients: PaymentRecipientCandidate[],
): PaymentRecipientDetails => ({
  trip_id: 'trip-1',
  from_member_id: 'payer',
  to_member_id: 'recipient',
  recipients,
});

describe('payment recipient snapshots', () => {
  it('copies and freezes the reviewed person, UPI ID, and revision', () => {
    const candidate = recipient({
      family_id: 'family-1', family_name: 'Recipient Family',
    });
    const snapshot = snapshotPaymentRecipient(candidate);

    candidate.name = 'Edited roster name';
    candidate.upi_id = 'changed@upi';

    expect(snapshot).toEqual({
      person_id: 'recipient-person',
      name: 'Recipient Person',
      family_id: 'family-1',
      family_name: 'Recipient Family',
      upi_id: 'recipient@upi',
      upi_updated_at: '2026-09-11T10:00:00+00:00',
    });
    expect(snapshot).not.toBe(candidate);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('accepts an unchanged, available selected recipient', () => {
    const candidate = recipient();
    const snapshot = snapshotPaymentRecipient(candidate);

    expect(paymentRecipientRequiresReview(
      snapshot,
      recipientDetails([recipient({ person_id: 'someone-else' }), candidate]),
    )).toBe(false);
  });

  it.each([
    ['changed recipient name', recipient({ name: 'Renamed Recipient' })],
    ['edited UPI ID', recipient({ upi_id: 'new@upi' })],
    ['removed UPI ID', recipient({ upi_id: null })],
    ['changed revision', recipient({ upi_updated_at: '2026-09-11T11:00:00+00:00' })],
    ['unavailable account', recipient({ account_linked: false, upi_id: null })],
  ])('requires review for an %s', (_reason, current) => {
    const snapshot = snapshotPaymentRecipient(recipient());

    expect(paymentRecipientRequiresReview(snapshot, recipientDetails([current]))).toBe(true);
  });

  it('requires review when the selected person or fresh details are missing', () => {
    const snapshot = snapshotPaymentRecipient(recipient());

    expect(paymentRecipientRequiresReview(snapshot, recipientDetails([]))).toBe(true);
    expect(paymentRecipientRequiresReview(snapshot, null)).toBe(true);
    expect(paymentRecipientRequiresReview(null, recipientDetails([recipient()]))).toBe(true);
  });
});

describe('payment handoff action-time review', () => {
  const handoff = (over: Partial<PaymentHandoffPreview> = {}): PaymentHandoffPreview => ({
    trip_id: 'trip-1',
    trip_name: 'Goa Weekend',
    from_member_id: 'payer',
    from_name: 'Payer Person',
    to_member_id: 'recipient',
    to_name: 'Recipient Person',
    source_amount: '25.00',
    source_currency: 'USD',
    current_payable: '50.00',
    inr_amount: '2086.42',
    quote: {
      quote_id: 'quote-1',
      rate: '83.4567',
      effective_rate_date: '2026-09-10',
      provider: 'frankfurter_v2_blended',
      stale: false,
      expires_at: '2026-09-11T10:30:00+00:00',
    },
    recipients: [recipient()],
    ...over,
  });

  it('keeps approval valid only for an identical quote, amount, payable, and recipient revision', () => {
    const reviewed = handoff();
    expect(paymentHandoffRequiresReview(
      reviewed, handoff(), snapshotPaymentRecipient(recipient()),
    )).toBe(false);
  });

  it.each([
    ['payable', handoff({ current_payable: '49.00' })],
    ['source amount', handoff({ source_amount: '24.00' })],
    ['currency', handoff({ source_currency: 'EUR' })],
    ['INR result', handoff({ inr_amount: '2000.00' })],
    ['quote', handoff({ quote: { ...handoff().quote, quote_id: 'quote-2' } })],
    ['rate', handoff({ quote: { ...handoff().quote, rate: '84.0000' } })],
    ['stale state', handoff({ quote: { ...handoff().quote, stale: true } })],
    ['UPI ID', handoff({ recipients: [recipient({ upi_id: 'changed@upi' })] })],
    ['UPI revision', handoff({
      recipients: [recipient({ upi_updated_at: '2026-09-11T11:00:00+00:00' })],
    })],
  ])('requires a fresh approval after a %s change', (_label, current) => {
    expect(paymentHandoffRequiresReview(
      handoff(), current, snapshotPaymentRecipient(recipient()),
    )).toBe(true);
  });
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
  it('does not hide one legal yen as zero', () => {
    expect(paymentStatus(100, 1, 'JPY')).toBe('partial');
    expect(paymentStatus(1, 100, 'JPY')).toBe('partial');
    expect(paymentStatus(0, 1, 'JPY')).toBe('paid');
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
  it('sums three-decimal payments in integer KWD minor units', () => {
    const kwd = [
      pay({ amount: 0.001 }),
      pay({ id: 'two', amount: 0.002 }),
    ];
    expect(pairPaid(kwd, 'a', 'b', 'KWD')).toBe(0.003);
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
  it('accepts valid amounts up to the max and rejects hidden extra precision', () => {
    expect(validatePaymentAmount(100, 100)).toEqual({ ok: true, error: null });
    expect(validatePaymentAmount(100.004, 100).ok).toBe(false);
    expect(validatePaymentAmount(40, 100).ok).toBe(true);
  });
  it('enforces JPY and KWD precision and caps', () => {
    expect(validatePaymentAmount(40.5, 100, {
      currency: 'JPY', rawAmount: '40.5',
    }).ok).toBe(false);
    expect(validatePaymentAmount(101, 100, {
      currency: 'JPY', rawAmount: '101',
    }).ok).toBe(false);
    expect(validatePaymentAmount(1.234, 2, {
      currency: 'KWD', rawAmount: '1.234',
    })).toEqual({ ok: true, error: null });
    expect(validatePaymentAmount(1.2345, 2, {
      currency: 'KWD', rawAmount: '1.2345',
    }).ok).toBe(false);
    expect(validatePaymentAmount(2.001, 2, {
      currency: 'KWD', rawAmount: '2.001',
    }).ok).toBe(false);
  });
  it('enforces exact whole-unit amounts when requested', () => {
    expect(validatePaymentAmount(40.5, 100, { wholeUnit: true })).toEqual({
      ok: false, error: 'Enter a whole INR amount',
    });
    expect(validatePaymentAmount(101, 100, { wholeUnit: true }).ok).toBe(false);
    expect(validatePaymentAmount(40, 100, { wholeUnit: true })).toEqual({ ok: true, error: null });
  });
});
