import { canModifyExpense } from '../permissions';

describe('canModifyExpense', () => {
  it('allows the creator', () => {
    expect(canModifyExpense({ created_by: 'u1' }, 'u1', { admin_ids: [] })).toBe(true);
  });

  it('allows a trip admin who is not the creator', () => {
    expect(canModifyExpense({ created_by: 'u1' }, 'u2', { admin_ids: ['u2'] })).toBe(true);
  });

  it('allows the owner (seeded into admin_ids)', () => {
    expect(canModifyExpense({ created_by: 'u1' }, 'owner', { admin_ids: ['owner'] })).toBe(true);
  });

  it('blocks a plain member who is neither creator nor admin', () => {
    expect(canModifyExpense({ created_by: 'u1' }, 'u3', { admin_ids: ['u2'] })).toBe(false);
  });

  it('blocks an undefined user', () => {
    expect(canModifyExpense({ created_by: 'u1' }, undefined, { admin_ids: ['u1'] })).toBe(false);
  });

  it('allows an admin on a legacy row with no created_by', () => {
    expect(canModifyExpense({ created_by: null }, 'u2', { admin_ids: ['u2'] })).toBe(true);
    expect(canModifyExpense({}, 'u2', { admin_ids: ['u2'] })).toBe(true);
  });

  it('blocks a member on a legacy row with no created_by', () => {
    expect(canModifyExpense({ created_by: null }, 'u3', { admin_ids: ['u2'] })).toBe(false);
  });

  it('handles missing/null admin_ids without throwing', () => {
    expect(canModifyExpense({ created_by: 'u1' }, 'u3', {})).toBe(false);
    expect(canModifyExpense({ created_by: 'u1' }, 'u3', { admin_ids: null })).toBe(false);
    expect(canModifyExpense({ created_by: 'u1' }, 'u1', {})).toBe(true);
  });
});
