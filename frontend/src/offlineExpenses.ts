import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { familyMemberIds } from './familyParticipation';
import { offlineStore } from './offlineStore';
import type { StoredOutboxItem } from './offlineStore.shared';
import { ANDROID_OFFLINE_WRITES_ENABLED, offlineWritesActive } from './offlineActivation';
import { syncCoordinator } from './syncWorker';

export const ANDROID_EXPENSE_CAPTURE_ENABLED = ANDROID_OFFLINE_WRITES_ENABLED;

export type ExpenseCaptureMember = {
  id: string;
  kind: string;
  family_members: string[];
  family_member_ids?: string[] | null;
};
export type ExpenseCaptureTrip = {
  id: string;
  currency: string;
  members: ExpenseCaptureMember[];
};
export type ExpenseCreatePayload = Record<string, unknown> & {
  paid_by_member_id: string;
  split_member_ids: string[];
  split_mode: 'PER_CAPITA' | 'PER_FAMILY' | 'EXACT';
  category: string;
  date: string;
};
export type PendingExpense = StoredOutboxItem & { payload: ExpenseCreatePayload };

export function expenseCaptureActive(): boolean {
  return offlineWritesActive();
}

export function makeExpenseOutboxItem(
  accountId: string, trip: ExpenseCaptureTrip, body: ExpenseCreatePayload,
  clientMutationId: string = Crypto.randomUUID(), queuedAt: number = Date.now(),
): PendingExpense {
  const sourceCurrency = body.currency ?? body.original_currency;
  if (sourceCurrency !== trip.currency || body.conversion != null) {
    throw new Error('Foreign-currency conversion needs internet.');
  }
  const selected = body.split_member_ids;
  if (!Array.isArray(selected) || selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new Error('Choose at least one participant.');
  }
  const relevantIds = new Set([...selected, body.paid_by_member_id]);
  const members = [...relevantIds].sort().map((id) => {
    const member = trip.members.find((candidate) => candidate.id === id);
    if (!member || (member.kind !== 'individual' && member.kind !== 'family')) {
      throw new Error('The saved trip roster does not match this split.');
    }
    return {
      id,
      kind: member.kind,
      family_member_ids: member.kind === 'family' ? familyMemberIds(member) : [],
    };
  });
  const expectedRoster = { currency: trip.currency, members };
  const payload: ExpenseCreatePayload = {
    ...body,
    split_member_ids: [...selected],
    client_mutation_id: clientMutationId,
    expected_roster: expectedRoster,
  };
  return {
    clientMutationId, accountId, tripId: trip.id, operation: 'expense_create',
    payload, precondition: expectedRoster, queuedAt, state: 'queued',
    attemptCount: 0, nextRetryAt: null, lastSafeErrorCode: null,
    canonicalResourceId: null, acknowledgedResponse: null,
  };
}

export async function captureExpense(item: PendingExpense, reviewId?: string): Promise<void> {
  if (await offlineStore.getExpenseProtocolVersion(item.accountId) !== 1) {
    throw new Error('Expense sync is unavailable. Connect and try again.');
  }
  try {
    if (reviewId) {
      await offlineStore.replaceReviewExpense(item.accountId, reviewId, item);
    } else {
      await offlineStore.enqueueOutbox(item);
    }
  } catch (error) {
    // A storage API can fail after the commit. Never make another UUID for this draft.
    // A readable, matching row is evidence that the write completed.
    const rows = await offlineStore.listOutbox(item.accountId).catch(() => []);
    const saved = rows.some((row) => row.clientMutationId === item.clientMutationId
      && row.accountId === item.accountId && row.tripId === item.tripId
      && row.operation === item.operation
      && JSON.stringify(row.payload) === JSON.stringify(item.payload));
    if (!saved) throw error;
  }
  syncCoordinator.wake(item.accountId);
}

export async function listPendingExpenses(
  accountId: string, tripId: string, confirmedIds: string[],
): Promise<PendingExpense[]> {
  if (Platform.OS !== 'android') return [];
  const confirmed = new Set(confirmedIds);
  const seen = new Set<string>();
  const rows = await offlineStore.listOutbox(accountId);
  return rows.filter((row): row is PendingExpense => {
    if (row.accountId !== accountId || row.tripId !== tripId
      || row.operation !== 'expense_create' || row.state === 'synced'
      || (row.canonicalResourceId && confirmed.has(row.canonicalResourceId))
      || seen.has(row.clientMutationId)) return false;
    seen.add(row.clientMutationId);
    return true;
  }).sort((a, b) => b.queuedAt - a.queuedAt);
}

export function reviewReason(code: string | null): string {
  switch (code) {
    case 'expense_roster_changed': return 'Trip participants changed. Review the split.';
    case 'budget_confirmation_required': return 'The trip budget needs online confirmation.';
    case 'expense_retry_unavailable':
    case 'expense_create_protocol_unavailable':
    case 'manual_payment_create_protocol_unavailable': return 'Sync is temporarily unavailable.';
    case 'permission_lost': return 'Your permission to add this expense changed.';
    case 'trip_unavailable': return 'This trip is unavailable to your account.';
    case 'invalid_write':
    case 'invalid_local_payload': return 'This transaction needs changes before the server can accept it.';
    case 'client_mutation_conflict': return 'This save ID conflicts with an earlier server request.';
    case 'eligibility_changed':
    case 'business_conflict': return 'Trip details changed. Review this transaction.';
    case 'payment_recommendation_changed': return 'The suggested payment changed. Keep this record for review.';
    case 'authentication_required': return 'Sign in to this account again to resume sync.';
    case 'reconciliation_pending': return 'The server accepted this transaction. Confirmed data is still refreshing.';
    case 'server_unavailable':
    case 'network_unavailable': return 'Waiting for the server. Your transaction remains saved.';
    case 'rate_limited': return 'The server asked this device to wait before retrying.';
    default: return 'Review this pending transaction before trying to sync it.';
  }
}

export function pendingStatusLabel(item: StoredOutboxItem): string {
  switch (item.state) {
    case 'sending': return 'Syncing · Pending sync';
    case 'awaiting_reconcile': return 'Accepted by server · Refreshing confirmed data';
    case 'needs_review': return 'Needs review · Pending sync';
    case 'paused_auth': return 'Sign in to sync · Pending sync';
    case 'queued': return item.nextRetryAt ? 'Waiting to retry · Pending sync' : 'Pending sync';
    case 'synced': return 'Synced';
  }
}
