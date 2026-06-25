import {
  isSettled,
  isOwnerRow,
  isLastFamilyMember,
  unsettledNames,
  entityRemovable,
  entityBlockReason,
  entityRemoveLabel,
  SETTLED_EPS,
} from '../removal';

const ind = { id: 'i1', name: 'Ann', kind: 'individual' as const, user_id: null };
const fam = (members: string[]) => ({ id: 'f1', name: 'Fam', kind: 'family' as const, family_members: members, user_id: null });
const rows = (...nets: number[]) => nets.map((net, i) => ({ id: `r${i}`, name: `M${i}`, net }));

describe('isSettled', () => {
  it('treats |x| < epsilon as settled, including -0', () => {
    expect(isSettled(0)).toBe(true);
    expect(isSettled(-0)).toBe(true);
    expect(isSettled(SETTLED_EPS / 2)).toBe(true);
  });
  it('treats epsilon and above as unsettled', () => {
    expect(isSettled(SETTLED_EPS)).toBe(false);
    expect(isSettled(0.01)).toBe(false);
    expect(isSettled(-0.01)).toBe(false);
  });
});

describe('isOwnerRow', () => {
  it('is true only for the owner-linked row', () => {
    expect(isOwnerRow({ owner_id: 'o' }, { user_id: 'o' })).toBe(true);
    expect(isOwnerRow({ owner_id: 'o' }, { user_id: 'x' })).toBe(false);
    expect(isOwnerRow({ owner_id: 'o' }, { user_id: null })).toBe(false);
    expect(isOwnerRow({}, { user_id: 'o' })).toBe(false);
  });
});

describe('isLastFamilyMember', () => {
  it('is true at 0 or 1 members, false for 2+', () => {
    expect(isLastFamilyMember({ family_members: [] })).toBe(true);
    expect(isLastFamilyMember({ family_members: ['a'] })).toBe(true);
    expect(isLastFamilyMember({ family_members: ['a', 'b'] })).toBe(false);
    expect(isLastFamilyMember({})).toBe(true);
  });
});

describe('unsettledNames', () => {
  it('lists only unsettled rows, by name', () => {
    expect(unsettledNames(rows(0, 0))).toEqual([]);
    const r = [{ id: 'a', name: 'Alice', net: 0 }, { id: 'b', name: 'Bob', net: -10 }];
    expect(unsettledNames(r)).toEqual(['Bob']);
  });
});

describe('entityRemovable', () => {
  it('individual: removable iff entity net settled', () => {
    expect(entityRemovable(ind, 0, [])).toBe(true);
    expect(entityRemovable(ind, -5, [])).toBe(false);
  });
  it('family: removable iff every member AND the entity net are settled', () => {
    expect(entityRemovable(fam(['a', 'b']), 0, rows(0, 0))).toBe(true);
    expect(entityRemovable(fam(['a', 'b']), 0, rows(0, -10))).toBe(false); // a member unsettled
    expect(entityRemovable(fam(['a', 'b']), 0.5, rows(0, 0))).toBe(false); // entity unsettled
  });
});

describe('entityBlockReason', () => {
  it('returns null when removable', () => {
    expect(entityBlockReason(ind, 0, [])).toBeNull();
    expect(entityBlockReason(fam(['a']), 0, rows(0))).toBeNull();
  });
  it('explains an unsettled individual', () => {
    expect(entityBlockReason(ind, -5, [])).toMatch(/settle up/i);
  });
  it('names the unsettled family members', () => {
    const r = [{ id: 'a', name: 'Alice', net: 0 }, { id: 'b', name: 'Bob', net: -10 }];
    expect(entityBlockReason(fam(['a', 'b']), -10, r)).toContain('Bob');
  });
});

describe('entityRemoveLabel', () => {
  it('labels by kind and family size', () => {
    expect(entityRemoveLabel(ind)).toBe('Remove member');
    expect(entityRemoveLabel(fam(['a', 'b', 'c']))).toBe('Remove family (3)');
  });
});
