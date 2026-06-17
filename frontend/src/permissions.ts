// Client-side mirror of the backend RBAC rule for expense mutation.
// Source of truth lives server-side in backend/utils/deps.py::can_modify_expense
// (creator OR trip admin; the trip owner is always seeded into admin_ids). Hiding a
// control with this predicate is a UX nicety only — the server stays authoritative.

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
