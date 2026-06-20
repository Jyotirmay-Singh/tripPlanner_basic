import React, { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { api } from '../../src/api';
import T from '../../src/T';
import { Screen, ListRow, EmptyState, SkeletonCard } from '../../src/ui';

type Trip = { id: string; name: string; currency: string };

export default function AddTab() {
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setTrips(await api<Trip[]>('/trips')); } catch {}
    setRefreshing(false);
    setLoaded(true);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <Screen refreshing={refreshing} onRefresh={load}>
      <T variant="h1">Add transaction</T>
      <T muted>Pick a trip to add an expense or income.</T>

      {!loaded ? (
        <SkeletonCard count={3} />
      ) : trips.length === 0 ? (
        <EmptyState
          icon="wallet"
          title="No trips to add to"
          body="Create a trip first, then you can start tracking expenses against it."
          ctaLabel="Create trip"
          ctaIcon="plus"
          onCta={() => router.push('/create-trip')}
          testID="add-empty"
        />
      ) : (
        trips.map((t) => (
          <ListRow
            key={t.id}
            testID={`add-tab-trip-${t.id}`}
            icon="plus"
            title={t.name}
            subtitle="Tap to add an expense"
            onPress={() => router.push(`/trip/${t.id}/add-expense`)}
          />
        ))
      )}
    </Screen>
  );
}
