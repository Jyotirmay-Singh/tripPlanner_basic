// Pure UX helpers for settled-only member / family removal. The backend is authoritative
// (backend/utils/settlement_gate.py + routes/members.py); these only drive what the manage-member
// screen shows/enables and never decide anything the server doesn't re-check.

export type RemovalMember = {
  id: string;
  name?: string;
  kind: 'individual' | 'family';
  family_members?: string[] | null;
  user_id?: string | null;
};
export type RemovalTrip = { owner_id?: string | null };
export type BreakdownRow = { id: string; name: string; net: number };

// net is rounded to 2dp upstream; |x| < 0.005 <=> rounds to 0.00 (mirror of SETTLED_EPS server-side).
export const SETTLED_EPS = 0.005;
export const isSettled = (net: number): boolean => Math.abs(net) < SETTLED_EPS;

// The owner's member row is the trip root and is never removable (mirror of the backend guard).
export const isOwnerRow = (trip: RemovalTrip, member: { user_id?: string | null }): boolean =>
  !!member.user_id && member.user_id === trip.owner_id;

// A family of one cannot lose its last member by member-removal — it must go via whole-family removal.
export const isLastFamilyMember = (member: { family_members?: string[] | null }): boolean =>
  (member.family_members?.length ?? 0) <= 1;

export const unsettledNames = (rows: BreakdownRow[]): string[] =>
  rows.filter((r) => !isSettled(r.net)).map((r) => r.name);

// Entity-level removability (mirror of the backend gate). Family: every member settled AND the family
// entity net settled. Individual: entity net settled.
export function entityRemovable(member: RemovalMember, entityNet: number, rows: BreakdownRow[]): boolean {
  if (member.kind === 'family') return isSettled(entityNet) && unsettledNames(rows).length === 0;
  return isSettled(entityNet);
}

// Human reason a removal is blocked, or null when it is allowed.
export function entityBlockReason(member: RemovalMember, entityNet: number, rows: BreakdownRow[]): string | null {
  if (entityRemovable(member, entityNet, rows)) return null;
  if (member.kind === 'family') {
    const names = unsettledNames(rows);
    const who = names.length ? names.join(', ') : (member.name ?? 'this family');
    return `Settle up first — outstanding balance for ${who}.`;
  }
  return 'Settle up this balance before removing.';
}

export const entityRemoveLabel = (member: RemovalMember): string =>
  member.kind === 'family' ? `Remove family (${member.family_members?.length ?? 0})` : 'Remove member';
