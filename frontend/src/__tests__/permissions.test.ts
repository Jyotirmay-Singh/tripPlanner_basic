import {
  canModifyExpense,
  roleOf,
  canManageMembers,
  canEditTripSettings,
  canManageAdmins,
  canTransferOwnership,
  canDeleteTrip,
  canRemoveMemberRow,
  canMarkSettlementPaid,
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

describe('canMarkSettlementPaid', () => {
  // m-lender is the creditor (to_member_id), linked to the app user 'member'.
  const MEMBERS = [
    { id: 'm-owner', user_id: 'owner' },
    { id: 'm-admin', user_id: 'admin' },
    { id: 'm-lender', user_id: 'member' },
    { id: 'm-detached', user_id: null },
  ];
  const S = { to_member_id: 'm-lender' };

  it('allows the lender (app user linked to the creditor member)', () => {
    expect(canMarkSettlementPaid(TRIP, S, 'member', MEMBERS)).toBe(true);
  });

  it('allows any trip admin or the owner regardless of who the lender is', () => {
    expect(canMarkSettlementPaid(TRIP, S, 'admin', MEMBERS)).toBe(true);
    expect(canMarkSettlementPaid(TRIP, S, 'owner', MEMBERS)).toBe(true);
  });

  it('denies an unrelated member who is neither the lender nor an admin', () => {
    const s = { to_member_id: 'm-owner' };
    expect(canMarkSettlementPaid(TRIP, s, 'member', MEMBERS)).toBe(false);
  });

  it('denies an undefined user and an unmatched/unlinked creditor member', () => {
    expect(canMarkSettlementPaid(TRIP, S, undefined, MEMBERS)).toBe(false);
    expect(canMarkSettlementPaid(TRIP, { to_member_id: 'ghost' }, 'member', MEMBERS)).toBe(false);
    expect(canMarkSettlementPaid(TRIP, { to_member_id: 'm-detached' }, 'member', MEMBERS)).toBe(false);
  });
});

describe('canRemoveMemberRow', () => {
  it('lets an admin/owner remove a non-app-user member row', () => {
    const m = { user_id: null };
    expect(canRemoveMemberRow(TRIP, m, 'owner')).toBe(true);
    expect(canRemoveMemberRow(TRIP, m, 'admin')).toBe(true);
  });

  it('lets an admin remove an app-user member that is NOT the owner', () => {
    expect(canRemoveMemberRow(TRIP, { user_id: 'admin' }, 'admin')).toBe(true);
    expect(canRemoveMemberRow(TRIP, { user_id: 'member' }, 'owner')).toBe(true);
  });

  it('never lets anyone remove the owner row', () => {
    expect(canRemoveMemberRow(TRIP, { user_id: 'owner' }, 'owner')).toBe(false);
    expect(canRemoveMemberRow(TRIP, { user_id: 'owner' }, 'admin')).toBe(false);
  });

  it('blocks plain members and strangers', () => {
    expect(canRemoveMemberRow(TRIP, { user_id: null }, 'member')).toBe(false);
    expect(canRemoveMemberRow(TRIP, { user_id: null }, 'stranger')).toBe(false);
    expect(canRemoveMemberRow(TRIP, { user_id: null }, undefined)).toBe(false);
  });
});
