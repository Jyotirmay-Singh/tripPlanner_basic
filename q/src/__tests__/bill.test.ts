import { billLabel } from '../bill';

describe('billLabel', () => {
  it('returns the "Bill not attached" string when no bill', () => {
    expect(billLabel({ has_receipt: false })).toBe('Bill not attached');
    expect(billLabel({})).toBe('Bill not attached');
  });

  it('returns null when a bill is attached (caller renders a thumbnail)', () => {
    expect(billLabel({ has_receipt: true })).toBeNull();
  });
});
