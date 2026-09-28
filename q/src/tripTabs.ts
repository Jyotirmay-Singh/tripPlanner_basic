export type TripTabKey = 'summary' | 'expenses' | 'balances' | 'members' | 'chat';


// Notification links may open the activity tab they were issued for. Unknown values still fall
// back to Summary; backend authorization remains authoritative for every tab's data.
export function tripTabFromParam(value: string | string[] | undefined): TripTabKey {
  const scalar = Array.isArray(value) ? value[0] : value;
  return scalar === 'expenses' || scalar === 'members' || scalar === 'chat' ? scalar : 'summary';
}
