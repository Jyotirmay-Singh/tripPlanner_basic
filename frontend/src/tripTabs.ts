export type TripTabKey = 'summary' | 'expenses' | 'balances' | 'members' | 'chat';


// Notification links intentionally expose only the Expenses tab. All other external/untrusted
// query values fall back to the existing Summary default.
export function tripTabFromParam(value: string | string[] | undefined): TripTabKey {
  const scalar = Array.isArray(value) ? value[0] : value;
  return scalar === 'expenses' ? 'expenses' : 'summary';
}
