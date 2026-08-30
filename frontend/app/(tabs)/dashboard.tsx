import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
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
  netPositionMessage,
  resolveUserTripBalance,
  type CurrencyBalance,
  type TripBalancePayload,
} from '../../src/tripBalance';
import {
  TabScreen, Card, Button, ListRow, EmptyState, AmountText, SkeletonCard,
} from '../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; start_date?: string; end_date?: string; travel_date?: string; budget?: number; currency: string; members: Member[] };

export default function Dashboard() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [currencyBalances, setCurrencyBalances] = useState<CurrencyBalance[]>([]);
  const [balancesAvailable, setBalancesAvailable] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    try {
      const list = await api<Trip[]>('/trips');
      const results = await Promise.allSettled(
        list.map((trip) => api<TripBalancePayload>(`/trips/${trip.id}/balances`)),
      );
      const rows: { currency: string; balance: number }[] = [];
      let complete = true;

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          complete = false;
          return;
        }
        const balance = resolveUserTripBalance(result.value, user?.id);
        if (balance == null) {
          complete = false;
          return;
        }
        rows.push({
          currency: result.value.currency || list[index].currency,
          balance,
        });
      });

      if (generation !== loadGeneration.current) return;
      setTrips(list);
      if (complete) setCurrencyBalances(groupBalancesByCurrency(rows));
      setBalancesAvailable(complete);
    } catch {
      if (generation === loadGeneration.current) setBalancesAvailable(false);
    } finally {
      if (generation === loadGeneration.current) {
        setRefreshing(false);
        setLoaded(true);
      }
    }
  }, [user?.id]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]));

  const positionMessage = netPositionMessage(currencyBalances);
  const tripCount = `${trips.length} trip${trips.length === 1 ? '' : 's'}`;

  return (
    <TabScreen refreshing={refreshing} onRefresh={load}>
      <TabPageHeader title="Dashboard" />

      <UnverifiedBanner />

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
            variant="moneyLg"
            signed={(currencyBalances[0]?.cents ?? 0) > 0}
            color={colors.primaryText}
            style={{ marginTop: SPACING.xs }}
          />
        ) : (
          <View style={styles.currencyBalances}>
            {currencyBalances.map((balance) => (
              <View key={balance.currency} style={styles.currencyBalanceRow}>
                <T variant="label" color={colors.primaryText} style={{ opacity: 0.8 }}>
                  {balance.currency}
                </T>
                <AmountText
                  value={balance.value}
                  signed={balance.cents > 0}
                  color={colors.primaryText}
                />
              </View>
            ))}
          </View>
        )}
        <T color={colors.primaryText} style={styles.balanceSubtitle}>
          {!loaded
            ? tripCount
            : balancesAvailable
              ? `${positionMessage} · ${tripCount}`
              : `Pull to refresh · ${tripCount}`}
        </T>
      </Card>

      <View style={styles.actions}>
        <View style={styles.actionButton}>
          <Button label="New Trip" icon="plus" onPress={() => router.push('/create-trip')} fullWidth testID="dash-new-trip" />
        </View>
        <View style={styles.actionButton}>
          <Button label="Join Trip" icon="users" variant="secondary" onPress={() => router.push('/join-trip')} fullWidth testID="dash-join-trip" />
        </View>
      </View>

      <T variant="label" muted style={{ marginTop: SPACING.sm }}>Recent trips</T>

      {!loaded ? (
        <SkeletonCard count={3} />
      ) : trips.length === 0 ? (
        <EmptyState
          icon="ship"
          title="No trips yet"
          body="Create your first trip and start splitting expenses with your crew."
          ctaLabel="Create a trip"
          ctaIcon="plus"
          onCta={() => router.push('/create-trip')}
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
