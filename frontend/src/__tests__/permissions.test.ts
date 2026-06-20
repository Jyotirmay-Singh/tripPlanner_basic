import {
  canModifyExpense,
  roleOf,
  canManageMembers,
  canEditTripSettings,
  canManageAdmins,
  canTransferOwnership,
  canDeleteTrip,
} from '../permissions';

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

// owner is seeded into admin_ids in production, so the fixture mirrors that.
const TRIP = {
  owner_id: 'owner',
  admin_ids: ['owner', 'admin'],
  user_ids: ['owner', 'admin', 'member'],
};

describe('roleOf', () => {
  it('reports owner even though owner is also in admin_ids', () => {
    expect(roleOf(TRIP, 'owner')).toBe('owner');
  });

  it('reports admin and member', () => {
    expect(roleOf(TRIP, 'admin')).toBe('admin');
    expect(roleOf(TRIP, 'member')).toBe('member');
  });

  it('returns null for a non-member and an undefined user', () => {
    expect(roleOf(TRIP, 'stranger')).toBeNull();
    expect(roleOf(TRIP, undefined)).toBeNull();
  });

  it('tolerates missing arrays without throwing', () => {
    expect(roleOf({}, 'anyone')).toBeNull();
    expect(roleOf({ owner_id: 'x' }, 'x')).toBe('owner');
    expect(roleOf({ admin_ids: null, user_ids: ['m'] }, 'm')).toBe('member');
  });
});

describe('owner-or-admin capabilities', () => {
  it.each([
    ['canManageMembers', canManageMembers],
    ['canEditTripSettings', canEditTripSettings],
  ] as const)('%s allows owner and admin, blocks member and strangers', (_name, fn) => {
    expect(fn(TRIP, 'owner')).toBe(true);
    expect(fn(TRIP, 'admin')).toBe(true);
    expect(fn(TRIP, 'member')).toBe(false);
    expect(fn(TRIP, 'stranger')).toBe(false);
    expect(fn(TRIP, undefined)).toBe(false);
  });
});

describe('owner-only capabilities', () => {
  it.each([
    ['canManageAdmins', canManageAdmins],
    ['canTransferOwnership', canTransferOwnership],
    ['canDeleteTrip', canDeleteTrip],
  ] as const)('%s allows only the owner', (_name, fn) => {
    expect(fn(TRIP, 'owner')).toBe(true);
    expect(fn(TRIP, 'admin')).toBe(false);
    expect(fn(TRIP, 'member')).toBe(false);
    expect(fn(TRIP, undefined)).toBe(false);
  });
});
