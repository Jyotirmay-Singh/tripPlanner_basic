import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { SPACING } from '../../src/theme';
import T from '../../src/T';
import { compositionLabel } from '../../src/composition';
import { formatTripDates } from '../../src/date';
import TabPageHeader from '../../src/TabPageHeader';
import TripListCard from '../../src/TripListCard';
import {
  resolveUserTripBalance,
  tripBalanceState,
  type TripBalancePayload,
  type TripBalanceState,
} from '../../src/tripBalance';
import { Screen, Card, Button, EmptyState, SkeletonCard, Icon } from '../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; start_date?: string; end_date?: string; travel_date?: string; budget?: number; currency: string; members: Member[] };

const UNAVAILABLE_BALANCE = tripBalanceState(null);

export default function Trips() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [balanceMap, setBalanceMap] = useState<Record<string, TripBalanceState>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    try {
      const list = await api<Trip[]>('/trips');
      const results = await Promise.allSettled(
        list.map((trip) => api<TripBalancePayload>(`/trips/${trip.id}/balances`)),
      );
      const nextBalances: Record<string, TripBalanceState> = {};

      results.forEach((result, index) => {
        const tripId = list[index].id;
        nextBalances[tripId] = result.status === 'fulfilled'
          ? tripBalanceState(resolveUserTripBalance(result.value, user?.id))
          : UNAVAILABLE_BALANCE;
      });

      if (generation !== loadGeneration.current) return;
      setTrips(list);
      setBalanceMap(nextBalances);
    } catch {
      // Preserve the last complete list; pull-to-refresh can retry a transient failure.
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

  return (
    <Screen refreshing={refreshing} onRefresh={load}>
      <TabPageHeader
        title="Trips"
        action={<Button label="New" icon="plus" size="sm" onPress={() => router.push('/create-trip')} testID="trips-new-btn" />}
      />

      <Card onPress={() => router.push('/join-trip')} testID="trips-join-btn" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm }}>
        <Icon name="key" size={18} color={colors.primary} />
        <T color={colors.primary} style={{ fontWeight: '700' }}>Join a trip with code</T>
      </Card>

      {!loaded ? (
        <SkeletonCard count={4} />
      ) : trips.length === 0 ? (
        <EmptyState
          icon="briefcase"
          title="No trips yet"
          body="Start a new trip or join one with a code your friend shares."
          ctaLabel="Create a trip"
          ctaIcon="plus"
          onCta={() => router.push('/create-trip')}
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
            subtitle={`${formatTripDates(trip)} · ${trip.currency}${trip.budget ? ` · Budget ${trip.budget}` : ''}`}
            meta={`${compositionLabel(trip.members)} · Code ${trip.code}`}
            currency={trip.currency}
            balance={balanceMap[trip.id] ?? UNAVAILABLE_BALANCE}
            onPress={() => router.push(`/trip/${trip.id}`)}
          />
        ))
      )}
    </Screen>
  );
}
