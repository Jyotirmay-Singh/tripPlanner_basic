const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NotificationTarget = 'trip_expenses' | 'settle_up' | 'trip_chat';
export type NotificationEventType =
  | 'expense.created'
  | 'payment.recorded'
  | 'settlement.paid'
  | 'chat.message.created';

export type NotificationRouteData = {
  payloadVersion: 1;
  eventKey: string;
  eventType: NotificationEventType;
  tripId: string;
  target: NotificationTarget;
  sourceId: string;
  expenseId?: string;
  paymentId?: string;
  settlementId?: string;
  messageId?: string;
};

type LegacyNotificationRouteData = {
  payloadVersion: 0;
  eventKey: string;
  tripId: string;
  target: Exclude<NotificationTarget, 'trip_chat'>;
};

export type ParsedNotificationRouteData = NotificationRouteData | LegacyNotificationRouteData;

const EVENT_RULES: Record<NotificationEventType, {
  target: NotificationTarget;
  idKey: 'expenseId' | 'paymentId' | 'settlementId' | 'messageId';
}> = {
  'expense.created': { target: 'trip_expenses', idKey: 'expenseId' },
  'payment.recorded': { target: 'settle_up', idKey: 'paymentId' },
  'settlement.paid': { target: 'settle_up', idKey: 'settlementId' },
  'chat.message.created': { target: 'trip_chat', idKey: 'messageId' },
};
const EVENT_ID_KEYS = ['expenseId', 'paymentId', 'settlementId', 'messageId'] as const;

function validEventKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200;
}

export function parseNotificationRouteData(value: unknown): ParsedNotificationRouteData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (!validEventKey(data.eventKey)) return null;
  if (typeof data.tripId !== 'string' || !UUID_RE.test(data.tripId)) return null;

  // Keep taps on already-delivered pre-v1 financial notifications working during rollout.
  if (data.payloadVersion == null) {
    if (data.target !== 'trip_expenses' && data.target !== 'settle_up') return null;
    return {
      payloadVersion: 0,
      eventKey: data.eventKey,
      tripId: data.tripId,
      target: data.target,
    };
  }

  if (data.payloadVersion !== 1 || typeof data.eventType !== 'string') return null;
  if (!(data.eventType in EVENT_RULES)) return null;
  const eventType = data.eventType as NotificationEventType;
  const rule = EVENT_RULES[eventType];
  if (data.target !== rule.target) return null;
  if (typeof data.sourceId !== 'string' || !UUID_RE.test(data.sourceId)) return null;
  if (data[rule.idKey] !== data.sourceId) return null;
  if (EVENT_ID_KEYS.some((key) => key !== rule.idKey && data[key] != null)) return null;
  if (data.eventKey !== `${eventType}:${data.sourceId}`) return null;

  return {
    payloadVersion: 1,
    eventKey: data.eventKey,
    eventType,
    tripId: data.tripId,
    target: rule.target,
    sourceId: data.sourceId,
    [rule.idKey]: data.sourceId,
  } as NotificationRouteData;
}

export function notificationHref(value: unknown): string | null {
  const data = parseNotificationRouteData(value);
  if (!data) return null;
  const tripId = encodeURIComponent(data.tripId);
  if (data.payloadVersion === 0) {
    return data.target === 'trip_expenses'
      ? `/trip/${tripId}?tab=expenses`
      : `/trip/${tripId}/settle-up`;
  }
  const sourceId = encodeURIComponent(data.sourceId);
  switch (data.eventType) {
    case 'expense.created':
      return `/trip/${tripId}?tab=expenses&expenseId=${sourceId}`;
    case 'payment.recorded':
      return `/trip/${tripId}/settle-up?paymentId=${sourceId}`;
    case 'settlement.paid':
      return `/trip/${tripId}/settle-up?settlementId=${sourceId}`;
    case 'chat.message.created':
      return `/trip/${tripId}?tab=chat&messageId=${sourceId}`;
  }
}
