import { memberDisplayNames, familyMemberDisplayNames, DisplayMember } from '../displayNames';

const ind = (id: string, name: string): DisplayMember => ({ id, name, kind: 'individual', family_members: [] });
const fam = (id: string, name: string, roster: string[]): DisplayMember => ({ id, name, kind: 'family', family_members: roster });

// Mirror of backend/tests/test_display_names.py — must stay byte-for-byte equivalent in behavior.

describe('memberDisplayNames — rule (a)', () => {
  it('suffixes all duplicates, leaves unique names as-is', () => {
    const members = [ind('1', 'Ravi'), ind('2', 'Ravi'), ind('3', 'Ravi'), ind('4', 'Priya')];
    expect(memberDisplayNames(members)).toEqual({ '1': 'Ravi_1', '2': 'Ravi_2', '3': 'Ravi_3', '4': 'Priya' });
  });

  it('does not suffix a single individual', () => {
    expect(memberDisplayNames([ind('1', 'Ravi')])).toEqual({ '1': 'Ravi' });
  });

  it('numbers in stable array order', () => {
    expect(memberDisplayNames([ind('b', 'Ravi'), ind('a', 'Ravi')])).toEqual({ b: 'Ravi_1', a: 'Ravi_2' });
  });
});

describe('rule (b) — individuals vs family roster are separate scopes', () => {
  it('a lone individual and a same-named family roster member both stay plain', () => {
    const family = fam('f', 'Sharma', ['Ravi', 'Priya']);
    const members = [ind('i', 'Ravi'), family];
    expect(memberDisplayNames(members)['i']).toBe('Ravi');
    expect(familyMemberDisplayNames(family)).toEqual(['Ravi', 'Priya']);
  });

  it('two individuals are suffixed while the family roster is untouched', () => {
    const family = fam('f', 'Sharma', ['Ravi']);
    const members = [ind('i1', 'Ravi'), ind('i2', 'Ravi'), family];
    const labels = memberDisplayNames(members);
    expect(labels['i1']).toBe('Ravi_1');
    expect(labels['i2']).toBe('Ravi_2');
    expect(familyMemberDisplayNames(family)).toEqual(['Ravi']);
  });
});

describe('familyMemberDisplayNames — rule (c)', () => {
  it('suffixes within-family duplicates with the space-stripped family name', () => {
    const family = fam('f', 'The Sharmas', ['Ravi', 'Ravi', 'Priya']);
    expect(familyMemberDisplayNames(family)).toEqual(['Ravi_TheSharmas_1', 'Ravi_TheSharmas_2', 'Priya']);
  });

  it('handles an empty roster', () => {
    expect(familyMemberDisplayNames(fam('f', 'Sharma', []))).toEqual([]);
  });
});

describe('families follow the same protocol as individuals', () => {
  it('suffixes two families sharing a name', () => {
    const members = [fam('a', 'Sharma', ['X']), fam('b', 'Sharma', ['Y'])];
    expect(memberDisplayNames(members)).toEqual({ a: 'Sharma_1', b: 'Sharma_2' });
  });

  it('an individual and a family share the top-level scope', () => {
    const members = [ind('i', 'Sharma'), fam('f', 'Sharma', ['X'])];
    expect(memberDisplayNames(members)).toEqual({ i: 'Sharma_1', f: 'Sharma_2' });
  });
});

describe('edge cases', () => {
  it('returns an empty map for no members', () => {
    expect(memberDisplayNames([])).toEqual({});
    expect(memberDisplayNames(null)).toEqual({});
    expect(memberDisplayNames(undefined)).toEqual({});
  });

  it('collides case/space-insensitively but keeps each typed base', () => {
    expect(memberDisplayNames([ind('1', 'Ravi'), ind('2', 'ravi ')])).toEqual({ '1': 'Ravi_1', '2': 'ravi_2' });
  });

  it('treats a literal "Ravi 2" as a distinct base (no double-suffix)', () => {
    expect(memberDisplayNames([ind('1', 'Ravi'), ind('2', 'Ravi 2')])).toEqual({ '1': 'Ravi', '2': 'Ravi 2' });
  });

  it('collapses internal whitespace in the displayed base', () => {
    expect(memberDisplayNames([ind('1', 'Ravi   Kumar')])).toEqual({ '1': 'Ravi Kumar' });
  });
});
