import { tripTabFromParam } from '../tripTabs';


describe('trip notification tab parameter', () => {
  it('accepts the notification-enabled trip tabs', () => {
    expect(tripTabFromParam('expenses')).toBe('expenses');
    expect(tripTabFromParam(['expenses'])).toBe('expenses');
    expect(tripTabFromParam('members')).toBe('members');
    expect(tripTabFromParam('chat')).toBe('chat');
  });

  it('preserves Summary as the default for absent or untrusted values', () => {
    expect(tripTabFromParam(undefined)).toBe('summary');
    expect(tripTabFromParam('balances')).toBe('summary');
    expect(tripTabFromParam('anything')).toBe('summary');
  });
});
