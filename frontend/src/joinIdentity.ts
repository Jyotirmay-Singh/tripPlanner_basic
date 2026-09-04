// Pure UX helpers for the Phase 11 join-identity reconciliation (one gmail == at most one
// person per trip). The backend is authoritative (backend/routes/trips.py join + join/preview,
// backend/utils/members.py); these only decide what the Join Wizard shows and which
// /trips/join request body it sends. Mirrors the server's match/claim/join_new contract.

export type JoinMatch = {
  member_id: string;
  // 'family_member' (Phase 25) = the caller's own email sits on ONE member inside a family; claiming
  // links their account to that specific sub-member (family_member_id), not the whole family entity.
  member_type: 'individual' | 'family' | 'family_member';
  member_name: string;
  family_id?: string | null;
  family_name?: string | null;
  family_member_id?: string | null;
  has_financial_history: boolean;
  can_replace?: boolean;
};

export type ExistingPerson = {
  kind: 'individual' | 'family_member';
  member_id: string;
  family_member_id?: string | null;
  name: string;
  family_id?: string | null;
  family_name?: string | null;
  resolution: 'direct' | 'approval_required';
  has_financial_history?: boolean;
  can_replace?: boolean;
};

export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'obsolete';

export type JoinRequestView = {
  id: string;
  trip: { id: string; name: string; code: string };
  target: Omit<ExistingPerson, 'resolution' | 'has_financial_history' | 'can_replace'>;
  status: JoinRequestStatus;
  created_at: string;
  updated_at?: string | null;
  decided_at?: string | null;
  rejection_reason?: string | null;
  retry_after?: string | null;
  requester?: { user_id: string; name: string; email: string };
  target_email?: string | null;
  email_relation?: 'missing' | 'different';
};

export type JoinChoice = 'claim' | 'join_new';

// What the identity step may offer. No match => the normal wizard (join as new) only. A match
// WITH financial history can ONLY be claimed (a profile with expenses can't be duplicated); a
// clean match can be claimed OR replaced by joining as someone new.
export function availableJoinChoices(match: JoinMatch | null | undefined): JoinChoice[] {
  if (!match) return ['join_new'];
  const replaceable = match.can_replace ?? (
    match.member_type !== 'family_member' && !match.has_financial_history
  );
  return match.has_financial_history || !replaceable ? ['claim'] : ['claim', 'join_new'];
}

// True when the joiner has no choice but to claim (matched stub carries expense/settlement history,
// or it is a per-member family_member match which is always claim-only).
export const mustClaim = (match: JoinMatch | null | undefined): boolean =>
  !!match && availableJoinChoices(match).length === 1;

// True when committing a join-as-new must first remove the caller's own CLEAN stub — drives the
// destructive ConfirmModal and adds replace_member_id to the request body. Never for a family_member
// match (claiming a sub-member removes nothing).
export const replacementNeeded = (
  match: JoinMatch | null | undefined,
  choice: JoinChoice,
): boolean =>
  !!match && choice === 'join_new' && availableJoinChoices(match).includes('join_new');

export const claimLabel = (match: JoinMatch): string =>
  `This is me — take over ${match.member_name}`;

// Note shown in the destructive confirm (which existing profile gets removed).
export const replacementNote = (match: JoinMatch): string =>
  match.member_type === 'family_member'
    ? `This removes your Gmail from ${match.member_name} but keeps that person in ${match.family_name}. Continue?`
    : `This removes the existing profile ${match.member_name} from the trip. Continue?`;

// ---- /trips/join request-body builders (asserted in tests so the wire shape stays correct) ----
export function buildClaimBody(code: string, match: JoinMatch): Record<string, unknown> {
  const body: Record<string, unknown> = { code, action: 'claim', member_id: match.member_id };
  // A per-member match also carries the sub-slot id so the server links that specific member.
  if (match.member_type === 'family_member' && match.family_member_id) {
    body.family_member_id = match.family_member_id;
  }
  return body;
}

export function buildJoinNewBody(
  code: string,
  mode: 'individual' | 'family' | 'new_family',
  extra: Record<string, unknown>,
  match: JoinMatch | null | undefined,
): Record<string, unknown> {
  const replace = replacementNeeded(match, 'join_new');
  return {
    code,
    action: 'join_new',
    mode,
    ...extra,
    ...(replace && match && match.member_type !== 'family_member'
      ? { replace_member_id: match.member_id } : {}),
    ...(replace && match && match.member_type === 'family_member'
      ? { replace_family_member_id: match.family_member_id } : {}),
  };
}

export function buildJoinRequestBody(code: string, person: ExistingPerson): Record<string, unknown> {
  return {
    code,
    member_id: person.member_id,
    ...(person.family_member_id ? { family_member_id: person.family_member_id } : {}),
  };
}
