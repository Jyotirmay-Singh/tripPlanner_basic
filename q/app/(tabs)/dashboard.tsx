import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import { loadDashboardOverview, type DashboardOverview, type ReadResult } from '../../src/offlineReads';
import OfflineReadStatus from '../../src/OfflineReadStatus';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';
import { compositionLabel } from '../../src/composition';
import { formatTripDates } from '../../src/date';
import UnverifiedBanner from '../../src/UnverifiedBanner';
import TabPageHeader from '../../src/TabPageHeader';
import {
  BALANCE_COPY,
  groupBalancesByCurrency,
  type CurrencyBalance,
} from '../../src/tripBalance';
import {
  TabScreen, Card, Button, ListRow, EmptyState, AmountText, SkeletonCard,
} from '../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; start_date?: string; end_date?: string; travel_date?: string; budget?: number; currency: string; members: Member[]; last_activity_at: string };

export default function Dashboard() {
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
  const rows = read?.data?.balances ? Object.values(read.data.balances) : null;
  const currencyBalances: CurrencyBalance[] = rows ? groupBalancesByCurrency(rows) : [];
  const balancesAvailable = rows !== null;
  const tripCount = `${trips.length} trip${trips.length === 1 ? '' : 's'}`;
  const offlineView = sessionMode === 'offline' || read?.source === 'cache';

  return (
    <TabScreen refreshing={refreshing} onRefresh={load}>
      <TabPageHeader title="Dashboard" />

      <UnverifiedBanner />
      {read ? <OfflineReadStatus result={read} /> : null}

      <Card variant="primary" padding="lg" radius={RADIUS.xl}>
        <T variant="label" color={colors.primaryText} style={{ opacity: 0.85 }}>Net position</T>
        {!loaded ? (
          <T variant="h3" color={colors.primaryText} style={styles.balanceMessage}>
            Loading balances…
          </T>
        ) : !balancesAvailable ? (
          <T variant="h3" color={colors.primaryText} style={styles.balanceMessage}>
            {BALANCE_COPY.unavailable}
          </T>
        ) : currencyBalances.length <= 1 ? (
          <AmountText
            value={currencyBalances[0]?.value ?? 0}
            currency={currencyBalances[0]?.currency}
            currencyDisplay="code"
            variant="moneyLg"
            signed={(currencyBalances[0]?.units ?? 0) > 0}
            color={colors.primaryText}
            style={styles.balanceAmount}
          />
        ) : (
          <View style={styles.currencyBalances}>
            {currencyBalances.map((balance) => (
              <View key={balance.currency} style={styles.currencyBalanceRow}>
                <AmountText
                  value={balance.value}
                  currency={balance.currency}
                  currencyDisplay="code"
                  signed={balance.units > 0}
                  color={colors.primaryText}
                />
              </View>
            ))}
          </View>
        )}
        <T color={colors.primaryText} style={styles.balanceSubtitle}>
          {read?.data ? tripCount : loaded ? 'Trip count unavailable' : 'Loading trips…'}
        </T>
      </Card>

      <View style={styles.actions}>
        <View style={styles.actionButton}>
          <Button label="New Trip" icon="plus" onPress={() => router.push('/create-trip')} disabled={offlineView} fullWidth testID="dash-new-trip" />
        </View>
        <View style={styles.actionButton}>
          <Button label="Join Trip" icon="users" variant="secondary" onPress={() => router.push('/join-trip')} disabled={offlineView} fullWidth testID="dash-join-trip" />
        </View>
      </View>

      <T variant="label" muted style={{ marginTop: SPACING.sm }}>Recent trips</T>

      {!loaded ? (
        <SkeletonCard count={3} />
      ) : !read?.data ? (
        <EmptyState icon="alert" title="Trips unavailable offline"
          body={read?.error || 'Open your trips online to save a copy on this device.'}
          testID="dash-unavailable" />
      ) : trips.length === 0 ? (
        <EmptyState
          icon="ship"
          title={offlineView ? 'No trips in saved list' : 'No trips yet'}
          body={offlineView ? 'Connect to refresh your trip list.'
            : 'Create your first trip and start splitting expenses with your crew.'}
          ctaLabel={offlineView ? undefined : 'Create a trip'}
          ctaIcon={offlineView ? undefined : 'plus'}
          onCta={offlineView ? undefined : () => router.push('/create-trip')}
          testID="dash-empty"
        />
      ) : (
        trips.slice(0, 2).map((trip) => (
          <ListRow
            key={trip.id}
            testID={`dash-trip-${trip.id}`}
            icon="briefcase"
            title={trip.name}
            subtitle={`${formatTripDates(trip)} · ${trip.currency} · Code ${trip.code}`}
            meta={compositionLabel(trip.members)}
            onPress={() => router.push(`/trip/${trip.id}`)}
          />
        ))
      )}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  balanceAmount: { marginTop: SPACING.xs, textAlign: 'left' },
  balanceMessage: { marginTop: SPACING.sm },
  balanceSubtitle: { opacity: 0.8, marginTop: SPACING.xs },
  currencyBalances: { marginTop: SPACING.sm, gap: SPACING.xs },
  currencyBalanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
  },
  actions: { flexDirection: 'row', gap: SPACING.sm },
  actionButton: { flex: 1 },
});
