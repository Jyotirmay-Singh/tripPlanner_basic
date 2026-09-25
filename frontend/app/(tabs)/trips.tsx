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
import {
  tripBalanceState,
  type TripBalanceState,
} from '../../src/tripBalance';
import { TabScreen, Card, Button, EmptyState, SkeletonCard, Icon, IconButton } from '../../src/ui';

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
  const [storedRead, setStoredRead] = useState<{
    accountId: string; result: ReadResult<DashboardOverview<Trip>>;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    try {
      if (user?.id) {
        const result = await loadDashboardOverview<Trip>(user.id, sessionMode === 'offline');
        if (generation === loadGeneration.current) setStoredRead({ accountId: user.id, result });
      }
    } finally {
      if (generation === loadGeneration.current) {
        setRefreshing(false);
        setLoaded(true);
      }
    }
  }, [user?.id, sessionMode]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]));

  const read = storedRead && storedRead.accountId === user?.id ? storedRead.result : null;
  const trips = read?.data?.trips ?? [];
  const offlineView = sessionMode === 'offline' || read?.source === 'cache';
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
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  headerAction: { minHeight: COMPONENT_SIZE.headerControl },
});
