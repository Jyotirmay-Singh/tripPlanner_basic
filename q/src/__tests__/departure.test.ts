import {
  positionLabel,
  normalizedTripDeletionName,
  primaryResolution,
  selectedTripsRequireAcknowledgement,
} from '../departure';
import type { DepartureBlocker, TripDeletionImpact } from '../api';


function trip(overrides: Partial<TripDeletionImpact> = {}): TripDeletionImpact {
  return {
    trip_id: 'trip-1', trip_name: 'Coast', currency: 'INR', identity: null,
    position: '0', family_position: null, unsettled_family_members: [],
    settled: true, leave_eligible: true, dissolve_family_eligible: false,
    requires_family_dissolution: false, available_actions: ['keep', 'leave'],
    default_action: 'keep', active_payment_blocker: false,
    ownership: {
      is_owner: false, transfer_required: false, successor: null,
      requires_trip_deletion: false,
    },
    blockers: [],
    ...overrides,
  };
}


test('formats signed positions as whole grouped money', () => {
  expect(positionLabel('0.000000000001', 'INR')).toBe('INR 0');
  expect(positionLabel('-12.5000', 'USD')).toBe('USD -13');
  expect(positionLabel('12345', 'INR')).toBe('INR +12,345');
  expect(positionLabel('0', 'LKR')).toBe('LKR 0');
});

test('requires acknowledgement only for unsettled trips retained by default', () => {
  const unsettled = trip({ settled: false, position: '-5' });
  expect(selectedTripsRequireAcknowledgement([unsettled], {})).toBe(true);
  expect(selectedTripsRequireAcknowledgement(
    [unsettled], { 'trip-1': 'leave' },
  )).toBe(false);
});

test('prioritizes payment, settlement, and trip-deletion resolutions', () => {
  const blockers: DepartureBlocker[] = [
    { code: 'owner', message: 'owner', resolution: 'delete_trip_first', actions: ['leave'] },
    { code: 'settle', message: 'settle', resolution: 'settle_up', actions: ['leave'] },
    { code: 'payment', message: 'payment', resolution: 'resolve_payment', actions: ['leave'] },
  ];
  expect(primaryResolution(blockers)?.code).toBe('payment');
});

test('normalizes the required trip deletion value to trimmed lowercase', () => {
  expect(normalizedTripDeletionName('  Summer In GOA  ')).toBe('summer in goa');
});
