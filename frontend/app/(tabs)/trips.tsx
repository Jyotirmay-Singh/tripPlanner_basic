import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { api, spendSummary } from '../../src/api';
import { useTheme } from '../../src/ThemeContext';
import { SPACING } from '../../src/theme';
import T from '../../src/T';
import Badge from '../../src/Badge';
import { compositionLabel } from '../../src/composition';
import { formatTripDates } from '../../src/date';
import { isTripSettledWithActivity, type WithTransfers } from '../../src/tripSettled';
import { Screen, Card, Button, ListRow, EmptyState, SkeletonCard, Icon } from '../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; start_date?: string; end_date?: string; travel_date?: string; budget?: number; currency: string; members: Member[] };

export default function Trips() {
  const { colors } = useTheme();
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [settledMap, setSettledMap] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await api<Trip[]>('/trips');
      setTrips(list);
      // Per-trip "Settled" badge signal. Same tolerant N+1 pattern the dashboard already runs:
      // a trip reads "Settled" only if it has real spend (spendSummary.count > 0) AND no residual
      // transfers (isTripSettled). Balance math is never recomputed on the client.
      const map: Record<string, boolean> = {};
      await Promise.all(list.map(async (t) => {
        try {
          const [bal, spend] = await Promise.all([
            api<WithTransfers>(`/trips/${t.id}/balances`),
            spendSummary(t.id),
          ]);
          map[t.id] = isTripSettledWithActivity(bal, spend.count > 0);
        } catch { map[t.id] = false; }
      }));
      setSettledMap(map);
    } catch {}
    setRefreshing(false);
    setLoaded(true);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <Screen refreshing={refreshing} onRefresh={load}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="h1">Trips</T>
        <Button label="New" icon="plus" size="sm" onPress={() => router.push('/create-trip')} testID="trips-new-btn" />
      </View>

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
        trips.map((t) => (
          <ListRow
            key={t.id}
            testID={`trip-item-${t.id}`}
            icon="plane"
            title={t.name}
            subtitle={`${formatTripDates(t)} · ${t.currency}${t.budget ? ` · Budget ${t.budget}` : ''}`}
            meta={`${compositionLabel(t.members)} · Code ${t.code}`}
            onPress={() => router.push(`/trip/${t.id}`)}
            right={settledMap[t.id]
              ? <View style={{ alignSelf: 'flex-start' }} testID={`trip-settled-${t.id}`}>
                  <Badge label="Settled" color={colors.success} />
                </View>
              : undefined}
          />
        ))
      )}
    </Screen>
  );
}
