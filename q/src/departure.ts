import type { DepartureBlocker, TripDeletionAction, TripDeletionImpact } from './api';
import { roundWholeMoney } from './currencies';
import { formatMoney } from './format';


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

export function positionLabel(value: string | null, currency: string): string {
  const numeric = Number(value ?? '0');
  return formatMoney(numeric, {
    currency,
    currencyDisplay: 'code',
    signed: roundWholeMoney(numeric) > 0,
  });
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
