import { receiptExpenses, billLabel } from '../gallery';

describe('receiptExpenses', () => {
  it('keeps only expenses with an attached bill', () => {
    const expenses = [
      { id: 'a', has_receipt: true },
      { id: 'b', has_receipt: false },
      { id: 'c' }, // undefined => no receipt
      { id: 'd', has_receipt: true },
    ];
    expect(receiptExpenses(expenses).map((e) => e.id)).toEqual(['a', 'd']);
  });

  it('returns an empty array when none have receipts', () => {
    expect(receiptExpenses([{ id: 'a' }, { id: 'b', has_receipt: false }])).toEqual([]);
  });

  it('tolerates an empty/missing list', () => {
    expect(receiptExpenses([])).toEqual([]);
    expect(receiptExpenses(undefined as any)).toEqual([]);
  });
});

describe('billLabel', () => {
  it('returns the "Bill not attached" string when no bill', () => {
    expect(billLabel({ has_receipt: false })).toBe('Bill not attached');
    expect(billLabel({})).toBe('Bill not attached');
  });

  it('returns null when a bill is attached (caller renders a thumbnail)', () => {
    expect(billLabel({ has_receipt: true })).toBeNull();
  });
});
