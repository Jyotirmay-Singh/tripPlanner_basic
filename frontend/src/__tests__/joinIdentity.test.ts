import {
  availableJoinChoices,
  mustClaim,
  replacementNeeded,
  buildClaimBody,
  buildJoinNewBody,
  JoinMatch,
} from '../joinIdentity';

const match = (over: Partial<JoinMatch> = {}): JoinMatch => ({
  member_id: over.member_id ?? 'm1',
  member_type: over.member_type ?? 'individual',
  member_name: over.member_name ?? 'Asha',
  family_id: over.family_id ?? null,
  family_name: over.family_name ?? null,
  has_financial_history: over.has_financial_history ?? false,
});

describe('availableJoinChoices', () => {
  it('offers only join_new when there is no match', () => {
    expect(availableJoinChoices(null)).toEqual(['join_new']);
    expect(availableJoinChoices(undefined)).toEqual(['join_new']);
  });
  it('forces claim-only when the match has financial history', () => {
    expect(availableJoinChoices(match({ has_financial_history: true }))).toEqual(['claim']);
  });
  it('offers both for a clean match', () => {
    expect(availableJoinChoices(match({ has_financial_history: false }))).toEqual(['claim', 'join_new']);
  });
});

describe('mustClaim', () => {
  it('is true only for a history-bearing match', () => {
    expect(mustClaim(match({ has_financial_history: true }))).toBe(true);
    expect(mustClaim(match({ has_financial_history: false }))).toBe(false);
    expect(mustClaim(null)).toBe(false);
  });
});

describe('replacementNeeded', () => {
  it('is true only for join_new on a clean match', () => {
    expect(replacementNeeded(match({ has_financial_history: false }), 'join_new')).toBe(true);
  });
  it('is false for claim, for history matches, and for no match', () => {
    expect(replacementNeeded(match({ has_financial_history: false }), 'claim')).toBe(false);
    expect(replacementNeeded(match({ has_financial_history: true }), 'join_new')).toBe(false);
    expect(replacementNeeded(null, 'join_new')).toBe(false);
  });
});

describe('buildClaimBody', () => {
  it('builds the claim wire shape', () => {
    expect(buildClaimBody('ABC123', match({ member_id: 'mX' }))).toEqual({
      code: 'ABC123', action: 'claim', member_id: 'mX',
    });
  });
});

describe('buildJoinNewBody', () => {
  it('omits replace_member_id when there is no match', () => {
    expect(buildJoinNewBody('ABC123', 'individual', {}, null)).toEqual({
      code: 'ABC123', action: 'join_new', mode: 'individual',
    });
  });
  it('includes replace_member_id for a clean match (join-as-new replaces the stub)', () => {
    const body = buildJoinNewBody('ABC123', 'new_family',
      { family_name: 'The Group', family_members: ['P', 'Q'] },
      match({ member_id: 'stub1', has_financial_history: false }));
    expect(body).toEqual({
      code: 'ABC123', action: 'join_new', mode: 'new_family',
      family_name: 'The Group', family_members: ['P', 'Q'], replace_member_id: 'stub1',
    });
  });
  it('omits replace_member_id for a history match (server forces a claim anyway)', () => {
    const body = buildJoinNewBody('ABC123', 'individual', {},
      match({ member_id: 'stub1', has_financial_history: true }));
    expect(body).not.toHaveProperty('replace_member_id');
  });
});
