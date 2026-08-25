import { notificationHref, parseNotificationRouteData } from '../notificationRouting';


const TRIP_ID = '12345678-1234-4678-9234-567812345678';


describe('notification routing', () => {
  it('maps private expense activity to the Expenses tab', () => {
    expect(notificationHref({
      eventKey: 'expense.created:e1', tripId: TRIP_ID, target: 'trip_expenses',
    })).toBe(`/trip/${TRIP_ID}?tab=expenses`);
  });

  it('maps payment and settlement activity to Settle Up', () => {
    expect(notificationHref({
      eventKey: 'payment.recorded:p1', tripId: TRIP_ID, target: 'settle_up',
    })).toBe(`/trip/${TRIP_ID}/settle-up`);
  });

  it('rejects arbitrary URLs, targets, ids, and malformed data', () => {
    expect(parseNotificationRouteData(null)).toBeNull();
    expect(notificationHref({ eventKey: 'e1', tripId: '../profile', target: 'trip_expenses' })).toBeNull();
    expect(notificationHref({ eventKey: 'e1', tripId: TRIP_ID, target: 'https://evil.test' })).toBeNull();
    expect(notificationHref({ tripId: TRIP_ID, target: 'settle_up' })).toBeNull();
  });
});
