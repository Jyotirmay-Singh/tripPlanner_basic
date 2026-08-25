const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NotificationTarget = 'trip_expenses' | 'settle_up';

export type NotificationRouteData = {
  eventKey: string;
  tripId: string;
  target: NotificationTarget;
};


export function parseNotificationRouteData(value: unknown): NotificationRouteData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (typeof data.eventKey !== 'string' || data.eventKey.length < 1 || data.eventKey.length > 200) {
    return null;
  }
  if (typeof data.tripId !== 'string' || !UUID_RE.test(data.tripId)) return null;
  if (data.target !== 'trip_expenses' && data.target !== 'settle_up') return null;
  return { eventKey: data.eventKey, tripId: data.tripId, target: data.target };
}


export function notificationHref(value: unknown): string | null {
  const data = parseNotificationRouteData(value);
  if (!data) return null;
  return data.target === 'trip_expenses'
    ? `/trip/${data.tripId}?tab=expenses`
    : `/trip/${data.tripId}/settle-up`;
}
