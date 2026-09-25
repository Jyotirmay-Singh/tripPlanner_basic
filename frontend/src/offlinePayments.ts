import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { offlineWritesActive } from './offlineActivation';
import { offlineStore } from './offlineStore';
import type { StoredOutboxItem } from './offlineStore.shared';
import { canRecordPayment, type RoleTrip } from './permissions';
import { validatePaymentAmount } from './payments';
import type { Transfer } from './settlements';
import { syncCoordinator } from './syncWorker';

type Member = { id: string; kind?: string; user_id?: string | null;
  family_member_user_ids?: (string | null)[] };
export type PaymentCaptureTrip = RoleTrip & {
  id: string; currency: string; members: Member[];
};
export type PaymentCaptureBalances = { currency: string; transfers: Transfer[] };
export type ManualPaymentPayload = {
  from_member_id: string;
  to_member_id: string;
  amount: number;
  note?: string;
  client_mutation_id: string;
  expected_payable: number;
  expected_currency: string;
};
export type PendingPayment = StoredOutboxItem & { payload: ManualPaymentPayload };

export function paymentCaptureActive(): boolean {
  return offlineWritesActive();
}

export function makePaymentOutboxItem(
  accountId: string, trip: PaymentCaptureTrip, balances: PaymentCaptureBalances,
  transfer: Transfer, amount: number, note: string, fetchedAt: number,
  clientMutationId: string = Crypto.randomUUID(), queuedAt: number = Date.now(),
  isSuperAdmin = false,
): PendingPayment {
  if (!accountId || !trip.id || !Number.isFinite(fetchedAt)
    || balances.currency !== trip.currency || transfer.from_member_id === transfer.to_member_id) {
    throw new Error('The saved payment suggestion is unavailable. Refresh the trip.');
  }
  const suggested = balances.transfers.find((row) =>
    row.from_member_id === transfer.from_member_id && row.to_member_id === transfer.to_member_id);
  if (!suggested || suggested.amount !== transfer.amount || !Number.isSafeInteger(transfer.amount)
    || transfer.amount <= 0 || !trip.members.some((member) => member.id === transfer.from_member_id)
    || !trip.members.some((member) => member.id === transfer.to_member_id)) {
    throw new Error('The saved payment suggestion changed. Review the current pair.');
  }
  if (!canRecordPayment(trip, transfer.to_member_id, accountId, trip.members, isSuperAdmin)) {
    throw new Error('This account cannot record a payment to the selected receiver.');
  }
  const validation = validatePaymentAmount(amount, transfer.amount,
    { wholeUnit: true, currency: trip.currency });
  if (!validation.ok || !Number.isSafeInteger(amount)) {
    throw new Error(validation.error || 'Enter a whole payment amount.');
  }
  const payload: ManualPaymentPayload = {
    from_member_id: transfer.from_member_id,
    to_member_id: transfer.to_member_id,
    amount,
    ...(note.trim() ? { note: note.trim() } : {}),
    client_mutation_id: clientMutationId,
    expected_payable: transfer.amount,
    expected_currency: trip.currency,
  };
  return {
    clientMutationId, accountId, tripId: trip.id, operation: 'manual_payment_create',
    payload, precondition: { expectedPayable: transfer.amount, currency: trip.currency, fetchedAt },
    queuedAt, state: 'queued', attemptCount: 0, nextRetryAt: null,
    lastSafeErrorCode: null, canonicalResourceId: null, acknowledgedResponse: null,
  };
}

export async function capturePayment(item: PendingPayment, reviewId?: string): Promise<void> {
  if (await offlineStore.getPaymentProtocolVersion(item.accountId) !== 1) {
    throw new Error('Payment sync is unavailable. Connect and try again.');
  }
  try {
    if (reviewId) await offlineStore.replaceReviewPayment(item.accountId, reviewId, item);
    else await offlineStore.enqueueOutbox(item);
  } catch (error) {
    // An I/O error can be reported after commit. Reuse the captured UUID if the row exists.
    const rows = await offlineStore.listOutbox(item.accountId).catch(() => []);
    const saved = rows.some((row) => row.clientMutationId === item.clientMutationId
      && row.accountId === item.accountId && row.tripId === item.tripId
      && row.operation === item.operation
      && JSON.stringify(row.payload) === JSON.stringify(item.payload));
    if (!saved) throw error;
  }
  syncCoordinator.wake(item.accountId);
}

export async function listPendingPayments(
  accountId: string, tripId: string, confirmedIds: string[],
): Promise<PendingPayment[]> {
  if (Platform.OS !== 'android') return [];
  const confirmed = new Set(confirmedIds);
  const seen = new Set<string>();
  const rows = await offlineStore.listOutbox(accountId);
  return rows.filter((row): row is PendingPayment => {
    if (row.accountId !== accountId || row.tripId !== tripId || row.operation !== 'manual_payment_create'
      || row.state === 'synced' || (row.canonicalResourceId && confirmed.has(row.canonicalResourceId))
      || seen.has(row.clientMutationId)) return false;
    seen.add(row.clientMutationId);
    return true;
  }).sort((a, b) => b.queuedAt - a.queuedAt);
}
