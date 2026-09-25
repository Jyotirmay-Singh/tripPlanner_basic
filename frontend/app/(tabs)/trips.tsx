import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import { loadDashboardOverview, type DashboardOverview, type ReadResult } from '../../src/offlineReads';
import OfflineReadStatus from '../../src/OfflineReadStatus';
import { useTheme } from '../../src/ThemeContext';
import { COMPONENT_SIZE, SPACING } from '../../src/theme';
import T from '../../src/T';
import { compositionLabel } from '../../src/composition';
import { formatTripDates } from '../../src/date';
import { formatMoney } from '../../src/format';
import TabPageHeader from '../../src/TabPageHeader';
import TripListCard from '../../src/TripListCard';
import { offlineStore } from '../../src/offlineStore';
import type { StoredOutboxItem } from '../../src/offlineStore.shared';
import { pendingStatusLabel, reviewReason } from '../../src/offlineExpenses';
import { offlineWritesActive } from '../../src/offlineActivation';
import { syncCoordinator } from '../../src/syncWorker';
import ConfirmModal from '../../src/ConfirmModal';
import {
  tripBalanceState,
  type TripBalanceState,
} from '../../src/tripBalance';
import { TabScreen, Card, Button, EmptyState, SkeletonCard, Icon, IconButton, useToast } from '../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code?: string; start_date?: string; end_date?: string; travel_date?: string; budget?: number; currency: string; members: Member[]; last_activity_at: string };

const UNAVAILABLE_BALANCE = tripBalanceState(null);

function tripSubtitle(trip: Trip): string {
  return [
    formatTripDates(trip),
    trip.currency,
    trip.budget != null
      ? `Budget ${formatMoney(trip.budget, { currency: trip.currency, showCurrency: false })}`
      : null,
  ].filter((value): value is string => Boolean(value)).join(' · ');
}

function tripMeta(trip: Trip): string {
  return [
    compositionLabel(trip.members),
    trip.code ? `Code ${trip.code}` : null,
  ].filter((value): value is string => Boolean(value)).join(' · ');
}

export default function Trips() {
  const { user, sessionMode } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [storedRead, setStoredRead] = useState<{
    accountId: string; result: ReadResult<DashboardOverview<Trip>>;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [paymentToDiscard, setPaymentToDiscard] = useState<StoredOutboxItem | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [storedQueue, setStoredQueue] = useState<{
    accountId: string; items: StoredOutboxItem[]; lastSyncedAt: number | null; error: boolean;
  } | null>(null);
  const loadGeneration = useRef(0);

  const loadQueue = useCallback(async (accountId: string) => {
    try {
      const items = (await offlineStore.listOutbox(accountId))
        .filter((item) => item.state !== 'synced');
      const meta = await Promise.all([...new Set(items.map((item) => item.tripId))]
        .map((tripId) => offlineStore.getSyncMeta(accountId, tripId)));
      const lastSyncedAt = Math.max(0, ...meta.map((row) => row?.lastSuccessfulRefreshAt ?? 0)) || null;
      setStoredQueue({ accountId, items, lastSyncedAt, error: false });
    } catch {
      setStoredQueue({ accountId, items: [], lastSyncedAt: null, error: true });
    }
  }, []);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    try {
      if (user?.id) {
        const queue = loadQueue(user.id);
        const result = await loadDashboardOverview<Trip>(user.id, sessionMode === 'offline');
        if (generation === loadGeneration.current) setStoredRead({ accountId: user.id, result });
        await queue;
      }
    } finally {
      if (generation === loadGeneration.current) {
        setRefreshing(false);
        setLoaded(true);
      }
    }
  }, [user?.id, sessionMode, loadQueue]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]));

  useFocusEffect(useCallback(() => {
    if (!user?.id) return () => {};
    const accountId = user.id;
    return syncCoordinator.subscribe((event) => {
      if (event.accountId === accountId) void loadQueue(accountId);
    });
  }, [user?.id, loadQueue]));

  const read = storedRead && storedRead.accountId === user?.id ? storedRead.result : null;
  const trips = read?.data?.trips ?? [];
  const offlineView = sessionMode === 'offline' || read?.source === 'cache';
  const queue = storedQueue?.accountId === user?.id ? storedQueue : null;
  const oldest = queue?.items.length ? Math.min(...queue.items.map((item) => item.queuedAt)) : null;
  const oldestMinutes = oldest === null ? null : Math.max(0, Math.floor((Date.now() - oldest) / 60_000));

  const discardPayment = async () => {
    if (!user?.id || !paymentToDiscard || discarding) return;
    setDiscarding(true);
    try {
      await offlineStore.discardReviewPayment(user.id, paymentToDiscard.clientMutationId);
      setPaymentToDiscard(null);
      await loadQueue(user.id);
    } catch {
      toast.show('Could not discard this pending payment. It remains saved on this device.', 'error');
    } finally { setDiscarding(false); }
  };
  const balanceMap: Record<string, TripBalanceState> = {};
  for (const trip of trips) {
    const row = read?.data?.balances?.[trip.id];
    balanceMap[trip.id] = row
      ? tripBalanceState(row.balance, row.currency || trip.currency) : UNAVAILABLE_BALANCE;
  }

  return (
    <TabScreen refreshing={refreshing} onRefresh={load}>
      <TabPageHeader
        title="Trips"
        action={(
          <Button
            label="New"
            icon="plus"
            size="sm"
            onPress={() => router.push('/create-trip')}
            disabled={offlineView}
            accessibilityLabel="Create new trip"
            testID="trips-new-btn"
            style={styles.headerAction}
          />
        )}
        compactAction={(
          <IconButton
            name="plus"
            variant="primary"
            onPress={() => router.push('/create-trip')}
            disabled={offlineView}
            accessibilityLabel="Create new trip"
            testID="trips-new-btn-compact"
            touchSize={COMPONENT_SIZE.minTouchTarget}
          />
        )}
      />

      {read ? <OfflineReadStatus result={read} /> : null}
      {queue?.error ? <T variant="caption" color={colors.warning} testID="trips-queue-error">
        Pending transactions could not be read on this device.
      </T> : null}
      {queue && queue.items.length > 0 ? <Card testID="trips-sync-queue">
        <T variant="h3">Pending sync: {queue.items.length}</T>
        <T variant="caption" muted>
          Oldest saved {oldestMinutes !== null && oldestMinutes >= 60
            ? `${Math.floor(oldestMinutes / 60)} hours ago` : `${oldestMinutes ?? 0} minutes ago`}.
          {' '}Last successful sync: {queue.lastSyncedAt
            ? new Date(queue.lastSyncedAt).toLocaleString() : 'not yet available'}.
        </T>
        {queue.items.map((item) => <Card key={item.clientMutationId}
          testID={`trips-pending-${item.clientMutationId}`}>
          <T variant="label">{item.operation === 'expense_create' ? 'Pending transaction' : 'Pending payment'}</T>
          <T variant="caption" muted accessibilityLabel={pendingStatusLabel(item)}>
            {pendingStatusLabel(item)}
          </T>
          <T variant="caption" muted>Trip {item.tripId}</T>
          {item.operation === 'manual_payment_create' && item.payload
            && typeof item.payload === 'object' ? <T variant="caption" muted>
              {String((item.payload as Record<string, unknown>).from_member_id ?? '?')}
              {' → '}{String((item.payload as Record<string, unknown>).to_member_id ?? '?')}
              {' · '}{String((item.payload as Record<string, unknown>).amount ?? '?')}
              {' '}{String((item.payload as Record<string, unknown>).expected_currency ?? '')}
            </T> : null}
          {item.lastSafeErrorCode ? <T variant="caption" muted>
            {reviewReason(item.lastSafeErrorCode)}
          </T> : null}
          {item.operation === 'expense_create' ? <Button label="Review"
            onPress={() => router.push(`/trip/${item.tripId}/pending-expense?mutationId=${encodeURIComponent(item.clientMutationId)}`)}
            testID={`trips-review-${item.clientMutationId}`} /> : null}
          {(item.state === 'queued' || item.state === 'awaiting_reconcile') ? <Button
            label="Retry sync" disabled={!offlineWritesActive()}
            onPress={() => { if (item.state === 'awaiting_reconcile') {
              syncCoordinator.wake(user!.id, item.clientMutationId);
            } else { void syncCoordinator.retry(user!.id, item.clientMutationId); } }}
            testID={`trips-retry-${item.clientMutationId}`} /> : null}
          {item.operation === 'manual_payment_create' && item.state === 'needs_review' ? <>
            {['permission_lost', 'trip_unavailable', 'business_conflict'].includes(
              item.lastSafeErrorCode ?? '') ? <Button label="Retry same payment"
              disabled={!offlineWritesActive()}
              onPress={() => { void syncCoordinator.retry(user!.id, item.clientMutationId); }}
              testID={`trips-retry-${item.clientMutationId}`} /> : null}
            <Button label="Discard pending payment" variant="secondary"
              onPress={() => setPaymentToDiscard(item)}
              testID={`trips-discard-${item.clientMutationId}`} />
          </> : null}
        </Card>)}
      </Card> : null}
      <Card onPress={offlineView ? undefined : () => router.push('/join-trip')} testID="trips-join-btn" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm }}>
        <Icon name="key" size={18} color={colors.primary} />
        <T color={colors.primary} style={{ fontWeight: '700' }}>Join a trip with code</T>
      </Card>

      {!loaded ? (
        <SkeletonCard count={4} />
      ) : !read?.data ? (
        <EmptyState icon="alert" title="Trips unavailable offline"
          body={read?.error || 'Open your trips online to save a copy on this device.'}
          testID="trips-unavailable" />
      ) : trips.length === 0 ? (
        <EmptyState
          icon="briefcase"
          title={offlineView ? 'No trips in saved list' : 'No trips yet'}
          body={offlineView ? 'Connect to refresh your trip list.'
            : 'Start a new trip or join one with a code your friend shares.'}
          ctaLabel={offlineView ? undefined : 'Create a trip'}
          ctaIcon={offlineView ? undefined : 'plus'}
          onCta={offlineView ? undefined : () => router.push('/create-trip')}
          testID="trips-empty"
        />
      ) : (
        trips.map((trip) => (
          <TripListCard
            key={trip.id}
            testID={`trip-item-${trip.id}`}
            balanceTestID={`trip-balance-${trip.id}`}
            settledTestID={`trip-settled-${trip.id}`}
            title={trip.name}
            subtitle={tripSubtitle(trip)}
            meta={tripMeta(trip)}
            currency={trip.currency}
            balance={balanceMap[trip.id] ?? UNAVAILABLE_BALANCE}
            onPress={() => router.push(`/trip/${trip.id}`)}
          />
        ))
      )}
      <ConfirmModal visible={!!paymentToDiscard} title="Discard pending payment?"
        message="This removes the saved pending payment from this device. Confirmed balances are unchanged."
        onRequestClose={() => setPaymentToDiscard(null)} actions={[
          { label: 'Keep', variant: 'cancel', onPress: () => setPaymentToDiscard(null) },
          { label: 'Discard', variant: 'destructive', onPress: () => { void discardPayment(); } },
        ]} />
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  headerAction: { minHeight: COMPONENT_SIZE.headerControl },
});
