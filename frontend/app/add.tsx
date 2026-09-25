import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../src/AuthContext';
import { loadTripList, type ReadResult } from '../src/offlineReads';
import OfflineReadStatus from '../src/OfflineReadStatus';
import T from '../src/T';
import { Screen, ListRow, EmptyState, SkeletonCard } from '../src/ui';

type Trip = { id: string; name: string; currency: string };

export default function AddTab() {
  const { user, sessionMode } = useAuth();
  const router = useRouter();
  const [storedRead, setStoredRead] = useState<{
    accountId: string; result: ReadResult<Trip[]>;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setRefreshing(true);
    try {
      if (user?.id) {
        const result = await loadTripList<Trip>(user.id, sessionMode === 'offline');
        if (current === generation.current) setStoredRead({ accountId: user.id, result });
      }
    } finally {
      if (current === generation.current) {
        setRefreshing(false);
        setLoaded(true);
      }
    }
  }, [user?.id, sessionMode]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]));

  const read = storedRead && storedRead.accountId === user?.id ? storedRead.result : null;
  const trips = read?.data ?? [];
  const offlineView = sessionMode === 'offline' || read?.source === 'cache';

  return (
    <Screen edges={['left', 'right', 'bottom']} refreshing={refreshing} onRefresh={load}>
      <T variant="h1">Add transaction</T>
      <T muted>Pick a trip to add an expense (or a negative amount for money back).</T>
      {read ? <OfflineReadStatus result={read} /> : null}

      {!loaded ? (
        <SkeletonCard count={3} />
      ) : !read?.data ? (
        <EmptyState icon="alert" title="Trip picker unavailable offline"
          body={read?.error || 'Open your trips online to save a list on this device.'}
          testID="add-unavailable" />
      ) : trips.length === 0 ? (
        <EmptyState
          icon="wallet"
          title={offlineView ? 'No trips in saved list' : 'No trips to add to'}
          body={offlineView ? 'Connect to refresh your trip list.'
            : 'Create a trip first, then you can start tracking expenses against it.'}
          ctaLabel={offlineView ? undefined : 'Create trip'}
          ctaIcon={offlineView ? undefined : 'plus'}
          onCta={offlineView ? undefined : () => router.push('/create-trip')}
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
