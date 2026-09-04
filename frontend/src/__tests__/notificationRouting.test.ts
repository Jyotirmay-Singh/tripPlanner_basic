import { notificationHref, parseNotificationRouteData } from '../notificationRouting';


const TRIP_ID = '12345678-1234-4678-9234-567812345678';
const SOURCE_ID = '87654321-4321-4765-8123-210987654321';

function payload(
  eventType: 'expense.created' | 'payment.recorded' | 'settlement.paid' | 'chat.message.created',
  target: 'trip_expenses' | 'settle_up' | 'trip_chat',
  idKey: 'expenseId' | 'paymentId' | 'settlementId' | 'messageId',
) {
  return {
    payloadVersion: 1,
    eventKey: `${eventType}:${SOURCE_ID}`,
    eventType,
    tripId: TRIP_ID,
    target,
    sourceId: SOURCE_ID,
    [idKey]: SOURCE_ID,
  };
}

describe('notification routing', () => {
  it('maps typed activity to its exact trip destination', () => {
    expect(notificationHref(payload('expense.created', 'trip_expenses', 'expenseId')))
      .toBe(`/trip/${TRIP_ID}?tab=expenses&expenseId=${SOURCE_ID}`);
    expect(notificationHref(payload('payment.recorded', 'settle_up', 'paymentId')))
      .toBe(`/trip/${TRIP_ID}/settle-up?paymentId=${SOURCE_ID}`);
    expect(notificationHref(payload('settlement.paid', 'settle_up', 'settlementId')))
      .toBe(`/trip/${TRIP_ID}/settle-up?settlementId=${SOURCE_ID}`);
    expect(notificationHref(payload('chat.message.created', 'trip_chat', 'messageId')))
      .toBe(`/trip/${TRIP_ID}?tab=chat&messageId=${SOURCE_ID}`);
  });

  it('keeps already-delivered legacy financial notification taps working', () => {
    expect(notificationHref({
      eventKey: 'expense.created:legacy-id', tripId: TRIP_ID, target: 'trip_expenses',
    })).toBe(`/trip/${TRIP_ID}?tab=expenses`);
  });

  it('rejects arbitrary URLs, malformed ids, and mismatched event contracts', () => {
    expect(parseNotificationRouteData(null)).toBeNull();
    expect(notificationHref({
      ...payload('expense.created', 'trip_expenses', 'expenseId'), tripId: '../profile',
    })).toBeNull();
    expect(notificationHref({
      ...payload('expense.created', 'trip_expenses', 'expenseId'), target: 'https://evil.test',
    })).toBeNull();
    expect(notificationHref({
      ...payload('expense.created', 'trip_expenses', 'expenseId'), target: 'trip_chat',
    })).toBeNull();
    expect(notificationHref({
      ...payload('expense.created', 'trip_expenses', 'expenseId'), expenseId: TRIP_ID,
    })).toBeNull();
    expect(notificationHref({
      ...payload('expense.created', 'trip_expenses', 'expenseId'), messageId: SOURCE_ID,
    })).toBeNull();
    expect(notificationHref({
      ...payload('expense.created', 'trip_expenses', 'expenseId'),
      eventKey: `payment.recorded:${SOURCE_ID}`,
    })).toBeNull();
    expect(notificationHref({
      payloadVersion: 99, eventKey: 'e1', tripId: TRIP_ID, target: 'settle_up',
    })).toBeNull();
  });
});
