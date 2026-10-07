const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NotificationTarget =
  | 'trip_expenses' | 'settle_up' | 'trip_chat'
  | 'trip_members' | 'trip_summary' | 'join_request';
export type NotificationEventType =
  | 'settlement.approval_requested' | 'settlement.allocation_applied' | 'settlement.allocation_declined'
  | 'settlement.review_required' | 'financial_review.updated'
  | 'expense.created'
  | 'payment.recorded'
  | 'settlement.paid'
  | 'payment_attempt.confirmation_requested'
  | 'payment_attempt.confirmed'
  | 'payment_attempt.not_received'
  | 'payment_attempt.review_closed'
  | 'chat.message.created'
  | 'join.request.created'
  | 'join.request.approved'
  | 'join.request.rejected';

export type NotificationRouteData = {
  payloadVersion: 1 | 2;
  eventId?: string;
  eventKey: string;
  eventType: NotificationEventType;
  tripId: string;
  target: NotificationTarget;
  sourceId: string;
  expenseId?: string;
  paymentId?: string;
  settlementId?: string;
  paymentAttemptId?: string;
  messageId?: string;
  requestId?: string;
  intentId?: string;
  correctionId?: string;
};

type LegacyNotificationRouteData = {
  payloadVersion: 0;
  eventKey: string;
  tripId: string;
  target: 'trip_expenses' | 'settle_up';
};

export type ParsedNotificationRouteData = NotificationRouteData | LegacyNotificationRouteData;

const EVENT_RULES: Record<NotificationEventType, {
  target: NotificationTarget;
  idKey: 'expenseId' | 'paymentId' | 'settlementId' | 'paymentAttemptId' | 'messageId' | 'requestId' | 'intentId' | 'correctionId';
}> = {
  'settlement.approval_requested': { target: 'settle_up', idKey: 'intentId' },
  'settlement.allocation_applied': { target: 'settle_up', idKey: 'intentId' },
  'settlement.allocation_declined': { target: 'settle_up', idKey: 'intentId' },
  'settlement.review_required': { target: 'settle_up', idKey: 'intentId' },
  'financial_review.updated': { target: 'settle_up', idKey: 'correctionId' },
  'expense.created': { target: 'trip_expenses', idKey: 'expenseId' },
  'payment.recorded': { target: 'settle_up', idKey: 'paymentId' },
  'settlement.paid': { target: 'settle_up', idKey: 'settlementId' },
  'payment_attempt.confirmation_requested': {
    target: 'settle_up', idKey: 'paymentAttemptId',
  },
  'payment_attempt.confirmed': { target: 'settle_up', idKey: 'paymentAttemptId' },
  'payment_attempt.not_received': { target: 'settle_up', idKey: 'paymentAttemptId' },
  'payment_attempt.review_closed': { target: 'settle_up', idKey: 'paymentAttemptId' },
  'chat.message.created': { target: 'trip_chat', idKey: 'messageId' },
  'join.request.created': { target: 'trip_members', idKey: 'requestId' },
  'join.request.approved': { target: 'trip_summary', idKey: 'requestId' },
  'join.request.rejected': { target: 'join_request', idKey: 'requestId' },
};
const EVENT_ID_KEYS = [
  'expenseId', 'paymentId', 'settlementId', 'paymentAttemptId', 'messageId', 'requestId', 'intentId', 'correctionId',
] as const;

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

  if (![1, 2].includes(data.payloadVersion as number) || typeof data.eventType !== 'string') return null;
  if (!(data.eventType in EVENT_RULES)) return null;
  const eventType = data.eventType as NotificationEventType;
  const rule = EVENT_RULES[eventType];
  if (data.target !== rule.target) return null;
  if (typeof data.sourceId !== 'string' || !UUID_RE.test(data.sourceId)) return null;
  if (data[rule.idKey] !== data.sourceId) return null;
  if (EVENT_ID_KEYS.some((key) => key !== rule.idKey && data[key] != null)) return null;
  const validActionId = (value: unknown) => typeof value === 'string' && value.split(':').length <= 2
    && value.split(':').every(id => UUID_RE.test(id));
  if (data.payloadVersion === 2) {
    if (!validActionId(data.eventId) || data.eventKey !== `${eventType}:${data.eventId}`) return null;
  } else if (data.eventKey !== `${eventType}:${data.sourceId}`) {
    // Previously delivered reviewed v1 events used an action key while navigating by source id.
    if (!/^(payment_attempt\.|settlement\.|financial_review\.)/.test(eventType)
      || !data.eventKey.startsWith(`${eventType}:`) || !validActionId(data.eventKey.slice(eventType.length + 1))) return null;
  }

  return {
    payloadVersion: data.payloadVersion as 1 | 2,
    ...(data.payloadVersion === 2 ? { eventId: data.eventId as string } : {}),
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
    case 'settlement.approval_requested':
    case 'settlement.allocation_applied':
    case 'settlement.allocation_declined':
    case 'settlement.review_required':
      return `/trip/${tripId}/settle-up?intentId=${sourceId}`;
    case 'financial_review.updated':
      return `/trip/${tripId}/financial-review?correctionId=${sourceId}`;
    case 'expense.created':
      return `/trip/${tripId}?tab=expenses&expenseId=${sourceId}`;
    case 'payment.recorded':
      return `/trip/${tripId}/settle-up?paymentId=${sourceId}`;
    case 'settlement.paid':
      return `/trip/${tripId}/settle-up?settlementId=${sourceId}`;
    case 'payment_attempt.confirmation_requested':
    case 'payment_attempt.confirmed':
    case 'payment_attempt.not_received':
    case 'payment_attempt.review_closed':
      return `/trip/${tripId}/settle-up?paymentAttemptId=${sourceId}`;
    case 'chat.message.created':
      return `/trip/${tripId}?tab=chat&messageId=${sourceId}`;
    case 'join.request.created':
      return `/trip/${tripId}?tab=members&requestId=${sourceId}`;
    case 'join.request.approved':
      return `/trip/${tripId}`;
    case 'join.request.rejected':
      return `/join-trip?requestId=${sourceId}`;
  }
}
