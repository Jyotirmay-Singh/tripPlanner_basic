import { identityIssue, buildIdentityFields, IdentityInput } from '../createIdentity';

const input = (over: Partial<IdentityInput> = {}): IdentityInput => ({
  self_kind: over.self_kind ?? 'family',
  familyName: over.familyName ?? 'Sharma',
  memberNames: over.memberNames ?? ['Arjun', 'Priya'],
  selfIndex: over.selfIndex ?? 0,
});

describe('identityIssue', () => {
  it('individual is always valid', () => {
    expect(identityIssue(input({ self_kind: 'individual', familyName: '', memberNames: [] }))).toBeNull();
  });
  it('valid family passes', () => {
    expect(identityIssue(input())).toBeNull();
  });
  it('requires a family name', () => {
    expect(identityIssue(input({ familyName: '   ' }))).toBe('Family name is required');
  });
  it('requires at least one member', () => {
    expect(identityIssue(input({ memberNames: ['', '  '] }))).toBe('Add at least one family member');
  });
  it('requires the "me" row to be a real member', () => {
    expect(identityIssue(input({ memberNames: ['Arjun', ''], selfIndex: 1 }))).toBe('Select which member is you');
  });
  it('out-of-range self index is rejected', () => {
    expect(identityIssue(input({ selfIndex: 5 }))).toBe('Select which member is you');
  });
});

describe('buildIdentityFields', () => {
  it('individual sends only self_kind', () => {
    expect(buildIdentityFields(input({ self_kind: 'individual' }))).toEqual({ self_kind: 'individual' });
  });
  it('family trims name + members and keeps self_index', () => {
    expect(buildIdentityFields(input({ familyName: ' Sharma ', memberNames: [' Arjun ', 'Priya'], selfIndex: 1 })))
      .toEqual({ self_kind: 'family', family_name: 'Sharma', family_members: ['Arjun', 'Priya'], self_index: 1 });
  });
  it('remaps self_index across dropped blank rows', () => {
    // Raw rows ['', 'Arjun', '', 'Priya'] with me=row 3 (Priya) -> cleaned ['Arjun','Priya'], me=1.
    expect(buildIdentityFields(input({ memberNames: ['', 'Arjun', '', 'Priya'], selfIndex: 3 })))
      .toEqual({ self_kind: 'family', family_name: 'Sharma', family_members: ['Arjun', 'Priya'], self_index: 1 });
  });
  it('me at the first non-blank row maps to index 0', () => {
    expect(buildIdentityFields(input({ memberNames: ['', 'Arjun', 'Priya'], selfIndex: 1 })))
      .toEqual({ self_kind: 'family', family_name: 'Sharma', family_members: ['Arjun', 'Priya'], self_index: 0 });
  });
});
