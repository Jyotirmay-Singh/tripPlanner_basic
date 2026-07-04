// Client-side mirror of the backend Owner / Admin / Member control matrix.
// The single source of truth lives server-side in backend/utils/permissions.py
// (role_of + capability predicates) and the deps.py guards. Hiding a control with
// these predicates is a UX nicety only — the server stays authoritative and every
// rejected call still surfaces the backend's `detail`.

export type ExpenseLike = { created_by?: string | null };
export type TripLike = { admin_ids?: string[] | null };

/**
 * True iff the given user may edit/delete the expense: they created it, or they are a
 * trip admin. A missing `created_by` (legacy rows) makes the creator branch false, so
 * only an admin can modify — matching the backend's safe default. An undefined user
 * (not signed in / still loading) can never modify.
 */
export function canModifyExpense(
  expense: ExpenseLike,
  userId: string | undefined,
  trip: TripLike,
): boolean {
  if (!userId) return false;
  return expense.created_by === userId || (trip.admin_ids ?? []).includes(userId);
}

// ---------------------------------------------------------------------------
// Trip role matrix (mirror of backend/utils/permissions.py)
// ---------------------------------------------------------------------------
export type Role = 'owner' | 'admin' | 'member';
export type RoleTrip = {
  owner_id?: string | null;
  admin_ids?: string[] | null;
  user_ids?: string[] | null;
};

/**
 * Resolve a user's role on a trip: 'owner' (the creator / root admin) supersedes
 * 'admin' (in admin_ids), which supersedes 'member' (in user_ids). Returns null when
 * the user is undefined/loading or not on the trip. Tolerant of missing arrays so a
 * partially-loaded trip never throws.
 */
export function roleOf(trip: RoleTrip, userId: string | undefined): Role | null {
  if (!userId) return null;
  if (trip.owner_id && trip.owner_id === userId) return 'owner';
  if ((trip.admin_ids ?? []).includes(userId)) return 'admin';
  if ((trip.user_ids ?? []).includes(userId)) return 'member';
  return null;
}

// Owner or admin
export function canManageMembers(trip: RoleTrip, userId: string | undefined): boolean {
  const r = roleOf(trip, userId);
  return r === 'owner' || r === 'admin';
}
export function canEditTripSettings(trip: RoleTrip, userId: string | undefined): boolean {
  const r = roleOf(trip, userId);
  return r === 'owner' || r === 'admin';
}

/**
 * True iff the viewer may remove this member row (UX gate). Removal is an admin/owner power, but the
 * owner's own member row (the trip root) is never removable — mirrors the backend, which protects the
 * owner row and otherwise lets admins remove any *settled* member. Settled-ness is data-driven (from
 * the balance engine), so it lives in src/removal.ts, not here.
 */
export function canRemoveMemberRow(
  trip: RoleTrip,
  member: { user_id?: string | null },
  userId: string | undefined,
): boolean {
  if (!canManageMembers(trip, userId)) return false;
  return !(member.user_id && trip.owner_id && member.user_id === trip.owner_id);
}

/**
 * UX mirror of backend can_mark_settlement_paid (Phase 10): a pending settlement may be flipped to
 * paid only by a trip admin/owner OR by the LENDER — the app user linked to the creditor member
 * (settlement.to_member_id). This stops a borrower from self-marking their own debt paid. An
 * undefined user or an unmatched/unlinked creditor member resolves to false. The server stays
 * authoritative; hiding the button is a nicety only.
 */
export function canMarkSettlementPaid(
  trip: RoleTrip,
  settlement: { to_member_id: string },
  userId: string | undefined,
  members: { id: string; user_id?: string | null }[],
): boolean {
  if (!userId) return false;
  const r = roleOf(trip, userId);
  if (r === 'owner' || r === 'admin') return true;
  const lender = members.find((m) => m.id === settlement.to_member_id);
  return !!(lender && lender.user_id && lender.user_id === userId);
}

/**
 * UX mirror of backend can_record_payment (Phase 20): a partial payment along a suggested
 * debtor->creditor pair may be recorded/edited/deleted only by a trip admin/owner OR by the RECEIVER
 * — the app user linked to the creditor member (the pair's to_member_id). The payer can never
 * self-record. An undefined user or an unmatched/unlinked creditor resolves to false. The server
 * stays authoritative; hiding the controls is a nicety only.
 */
export function canRecordPayment(
  trip: RoleTrip,
  toMemberId: string,
  userId: string | undefined,
  members: { id: string; user_id?: string | null }[],
): boolean {
  if (!userId) return false;
  const r = roleOf(trip, userId);
  if (r === 'owner' || r === 'admin') return true;
  const receiver = members.find((m) => m.id === toMemberId);
  return !!(receiver && receiver.user_id && receiver.user_id === userId);
}

// Owner only
export function canManageAdmins(trip: RoleTrip, userId: string | undefined): boolean {
  return roleOf(trip, userId) === 'owner';
}
export function canTransferOwnership(trip: RoleTrip, userId: string | undefined): boolean {
  return roleOf(trip, userId) === 'owner';
}
export function canDeleteTrip(trip: RoleTrip, userId: string | undefined): boolean {
  return roleOf(trip, userId) === 'owner';
}
