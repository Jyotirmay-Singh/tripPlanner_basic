import type { DepartureBlocker, TripDeletionAction, TripDeletionImpact } from './api';


export const TRIP_ACTION_LABELS: Record<TripDeletionAction, string> = {
  keep: 'Keep',
  leave: 'Leave',
  dissolve_family: 'Dissolve family',
};

export function selectedTripsRequireAcknowledgement(
  trips: TripDeletionImpact[],
  actions: Record<string, TripDeletionAction>,
): boolean {
  return trips.some((trip) => (actions[trip.trip_id] ?? 'keep') === 'keep' && !trip.settled);
}

export function exactPositionLabel(value: string | null, currency: string): string {
  const raw = (value ?? '0').trim();
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric === 0) return `${currency} 0`;
  const negative = raw.startsWith('-');
  const unsigned = (negative ? raw.slice(1) : raw)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
  return `${currency} ${negative ? '-' : '+'}${unsigned}`;
}

export function primaryResolution(blockers: DepartureBlocker[]): DepartureBlocker | null {
  const priority = ['resolve_payment', 'settle_up', 'delete_trip_first', 'review_membership'];
  for (const resolution of priority) {
    const blocker = blockers.find((item) => item.resolution === resolution);
    if (blocker) return blocker;
  }
  return blockers[0] ?? null;
}

export function normalizedTripDeletionName(name: string): string {
  return name.trim().toLowerCase();
}
