// Pure UX helpers for the Phase 11 join-identity reconciliation (one gmail == at most one
// person per trip). The backend is authoritative (backend/routes/trips.py join + join/preview,
// backend/utils/members.py); these only decide what the Join Wizard shows and which
// /trips/join request body it sends. Mirrors the server's match/claim/join_new contract.

export type JoinMatch = {
  member_id: string;
  member_type: 'individual' | 'family';
  member_name: string;
  family_id?: string | null;
  family_name?: string | null;
  has_financial_history: boolean;
};

export type JoinChoice = 'claim' | 'join_new';

// What the identity step may offer. No match => the normal wizard (join as new) only. A match
// WITH financial history can ONLY be claimed (a profile with expenses can't be duplicated); a
// clean match can be claimed OR replaced by joining as someone new.
export function availableJoinChoices(match: JoinMatch | null | undefined): JoinChoice[] {
  if (!match) return ['join_new'];
  return match.has_financial_history ? ['claim'] : ['claim', 'join_new'];
}

// True when the joiner has no choice but to claim (matched stub carries expense/settlement history).
export const mustClaim = (match: JoinMatch | null | undefined): boolean =>
  !!match && match.has_financial_history;

// True when committing a join-as-new must first remove the caller's own CLEAN stub — drives the
// destructive ConfirmModal and adds replace_member_id to the request body.
export const replacementNeeded = (
  match: JoinMatch | null | undefined,
  choice: JoinChoice,
): boolean => !!match && choice === 'join_new' && !match.has_financial_history;

export const claimLabel = (match: JoinMatch): string =>
  `This is me — take over ${match.member_name}`;

// Note shown in the destructive confirm (which existing profile gets removed).
export const replacementNote = (match: JoinMatch): string =>
  `This removes the existing profile ${match.member_name} from the trip. Continue?`;

// ---- /trips/join request-body builders (asserted in tests so the wire shape stays correct) ----
export function buildClaimBody(code: string, match: JoinMatch): Record<string, unknown> {
  return { code, action: 'claim', member_id: match.member_id };
}

export function buildJoinNewBody(
  code: string,
  mode: 'individual' | 'family' | 'new_family',
  extra: Record<string, unknown>,
  match: JoinMatch | null | undefined,
): Record<string, unknown> {
  return {
    code,
    action: 'join_new',
    mode,
    ...extra,
    ...(replacementNeeded(match, 'join_new') ? { replace_member_id: match!.member_id } : {}),
  };
}
