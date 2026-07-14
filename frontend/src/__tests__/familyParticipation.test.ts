import {
  familyMemberIds,
  familyInvolvedWeight,
  perCapitaHumans,
  buildFamilyParticipants,
  excludedFromParticipants,
  familyShareEach,
  rowsToPayload,
  familyToRows,
  familyEmailIssue,
  tripMemberEmails,
  FPMember,
} from '../familyParticipation';

const sharma: FPMember = {
  id: 'S', kind: 'family',
  family_members: ['Asha', 'Vik', 'Sam', 'Rahul'],
  family_member_ids: ['a', 'v', 's', 'r'],
};
const gupta: FPMember = { id: 'G', kind: 'family', family_members: ['X', 'Y'], family_member_ids: ['gx', 'gy'] };
const indie: FPMember = { id: 'I', kind: 'individual', family_members: [] };
const members = [sharma, gupta, indie];

describe('familyMemberIds', () => {
  it('returns the stable ids parallel to the roster', () => {
    expect(familyMemberIds(sharma)).toEqual(['a', 'v', 's', 'r']);
  });
  it('pads synthetic ids for a family not yet backfilled', () => {
    const legacy: FPMember = { id: 'L', kind: 'family', family_members: ['A', 'B'] };
    expect(familyMemberIds(legacy)).toEqual(['L:0', 'L:1']);
  });
});

describe('familyInvolvedWeight', () => {
  it('full size when there is no restriction', () => {
    expect(familyInvolvedWeight(sharma)).toBe(4);
  });
  it('involved count for a proper, non-empty restriction (§5-A)', () => {
    expect(familyInvolvedWeight(sharma, undefined, ['r'])).toBe(3);
  });
  it('numeric override wins over participation', () => {
    expect(familyInvolvedWeight(sharma, 2, ['r'])).toBe(2);
  });
  it('falls back to full size when all/none are excluded', () => {
    expect(familyInvolvedWeight(sharma, undefined, ['a', 'v', 's', 'r'])).toBe(4);
    expect(familyInvolvedWeight(sharma, undefined, [])).toBe(4);
  });
});

describe('perCapitaHumans', () => {
  it('counts family by size + individuals as 1', () => {
    expect(perCapitaHumans(members, ['S', 'G', 'I'], {})).toBe(7);
  });
  it('honors a weight override (count chips)', () => {
    expect(perCapitaHumans(members, ['S', 'I'], { S: 3 })).toBe(4);
  });
  it('counts a partially-attending family by its involved members (§5-A)', () => {
    // Sharma 3 of 4 involved -> 3; + individual 1 = 4.
    expect(perCapitaHumans(members, ['S', 'I'], {}, { S: ['r'] })).toBe(4);
  });
});

describe('buildFamilyParticipants', () => {
  it('records a proper-subset restriction as included ids', () => {
    expect(buildFamilyParticipants(members, ['S', 'I'], 'PER_CAPITA', { S: ['r'] })).toEqual({ S: ['a', 'v', 's'] });
  });
  it('returns null when every member is included', () => {
    expect(buildFamilyParticipants(members, ['S', 'I'], 'PER_CAPITA', {})).toBeNull();
    expect(buildFamilyParticipants(members, ['S', 'I'], 'PER_CAPITA', { S: [] })).toBeNull();
  });
  it('returns null when all members are excluded (no genuine restriction)', () => {
    expect(buildFamilyParticipants(members, ['S'], 'PER_CAPITA', { S: ['a', 'v', 's', 'r'] })).toBeNull();
  });
  it('builds a proper-subset restriction in PER_FAMILY mode too', () => {
    expect(buildFamilyParticipants(members, ['S', 'I'], 'PER_FAMILY', { S: ['r'] })).toEqual({ S: ['a', 'v', 's'] });
  });
  it('returns null for an unknown split mode', () => {
    expect(buildFamilyParticipants(members, ['S', 'I'], 'WHATEVER', { S: ['r'] })).toBeNull();
  });
  it('only includes families that are actually in the split', () => {
    expect(buildFamilyParticipants(members, ['I'], 'PER_CAPITA', { S: ['r'] })).toBeNull();
  });
});

describe('excludedFromParticipants', () => {
  it('round-trips participants back to an excluded map', () => {
    expect(excludedFromParticipants(members, { S: ['a', 'v', 's'] })).toEqual({ S: ['r'] });
  });
  it('is empty when there are no recorded restrictions', () => {
    expect(excludedFromParticipants(members, null)).toEqual({});
  });
});

describe('familyShareEach', () => {
  it('PER_CAPITA: each involved member owes the per-human cost (involved count drives H)', () => {
    // §5-A: Sharma 3 of 4 involved -> H = 3 + 1 = 4, C = 12.5; each involved member owes 12.5.
    const each = familyShareEach(50, members, ['S', 'I'], {}, 'S', 3, 'PER_CAPITA', { S: ['r'] });
    expect(Math.abs(each - 12.5)).toBeLessThan(1e-9);
  });
  it('PER_FAMILY: splits the flat per-entity share among only the participants', () => {
    // $1000 / 2 entities = $500 per family; family-1 with 3 sharing -> 500/3 each.
    const each1 = familyShareEach(1000, members, ['S', 'G'], {}, 'S', 3, 'PER_FAMILY');
    expect(Math.abs(each1 - 500 / 3)).toBeLessThan(1e-9);
    // family-2 with 2 sharing -> 250 each (size-independent, ignores weight overrides).
    const each2 = familyShareEach(1000, members, ['S', 'G'], {}, 'G', 2, 'PER_FAMILY');
    expect(each2).toBe(250);
  });
  it('returns 0 for invalid input', () => {
    expect(familyShareEach(0, members, ['S', 'I'], {}, 'S', 3, 'PER_CAPITA')).toBe(0);
    expect(familyShareEach(50, members, ['S', 'I'], {}, 'S', 0, 'PER_CAPITA')).toBe(0);
  });
});

describe('rowsToPayload / familyToRows', () => {
  it('builds parallel name + id + email arrays from non-empty rows', () => {
    const rows = [
      { id: 'a', name: 'Asha', email: 'asha@gmail.com' },
      { id: null, name: 'New' }, // no email -> null
      { id: 'x', name: '  ', email: 'x@gmail.com' }, // blank name -> dropped, its id/email drop too
    ];
    expect(rowsToPayload(rows)).toEqual({
      family_members: ['Asha', 'New'],
      family_member_ids: ['a', null],
      family_member_emails: ['asha@gmail.com', null],
    });
  });
  it('trims emails and maps blank -> null', () => {
    const rows = [
      { id: 'a', name: 'Asha', email: '  Asha@Gmail.com  ' },
      { id: 'b', name: 'Vik', email: '   ' },
    ];
    expect(rowsToPayload(rows).family_member_emails).toEqual(['Asha@Gmail.com', null]);
  });
  it('seeds rows from stored names + ids + emails (missing -> null)', () => {
    expect(familyToRows(['Asha', 'Vik'], ['a'], ['asha@gmail.com'])).toEqual([
      { id: 'a', name: 'Asha', email: 'asha@gmail.com' },
      { id: null, name: 'Vik', email: null },
    ]);
  });
  it('tolerates a legacy family with no emails array', () => {
    expect(familyToRows(['Asha', 'Vik'], ['a', 'b'])).toEqual([
      { id: 'a', name: 'Asha', email: null },
      { id: 'b', name: 'Vik', email: null },
    ]);
  });
  it('round-trips rows -> payload -> rows preserving emails', () => {
    const rows = [
      { id: 'a', name: 'Asha', email: 'asha@gmail.com' },
      { id: 'b', name: 'Vik', email: null },
    ];
    const p = rowsToPayload(rows);
    expect(familyToRows(p.family_members, p.family_member_ids, p.family_member_emails)).toEqual(rows);
  });
});

describe('tripMemberEmails', () => {
  it('collects entity + per-member emails, dropping the excluded entity', () => {
    const members = [
      { id: 'i1', email: 'solo@gmail.com' },
      { id: 'f1', email: 'fam@gmail.com', family_member_emails: ['a@gmail.com', null] },
      { id: 'f2', email: null, family_member_emails: ['b@gmail.com'] },
    ];
    expect(tripMemberEmails(members)).toEqual([
      'solo@gmail.com', 'fam@gmail.com', 'a@gmail.com', null, null, 'b@gmail.com',
    ]);
    // Excluding f1 drops its entity + per-member emails (edit round-trip self-exclusion).
    expect(tripMemberEmails(members, 'f1')).toEqual(['solo@gmail.com', null, 'b@gmail.com']);
  });
});

describe('familyEmailIssue', () => {
  it('returns null when all emails are valid + unique', () => {
    const rows = [
      { id: 'a', name: 'A', email: 'a@gmail.com' },
      { id: 'b', name: 'B', email: '' },
      { id: 'c', name: 'C', email: 'c@gmail.com' },
    ];
    expect(familyEmailIssue(rows, ['other@gmail.com'])).toBeNull();
  });
  it('flags a non-gmail member email', () => {
    const rows = [{ id: 'a', name: 'A', email: 'a@outlook.com' }];
    expect(familyEmailIssue(rows, [])).toBe('gmail');
  });
  it('flags a duplicate against the external taken set', () => {
    const rows = [{ id: 'a', name: 'A', email: 'dup@gmail.com' }];
    expect(familyEmailIssue(rows, ['dup@gmail.com'])).toBe('duplicate');
  });
  it('flags an intra-roster duplicate (case-insensitive)', () => {
    const rows = [
      { id: 'a', name: 'A', email: 'dup@gmail.com' },
      { id: 'b', name: 'B', email: 'DUP@Gmail.com' },
    ];
    expect(familyEmailIssue(rows, [])).toBe('duplicate');
  });
});
