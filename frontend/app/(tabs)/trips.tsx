import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { api } from '../../src/api';
import { useTheme } from '../../src/ThemeContext';
import { SPACING } from '../../src/theme';
import T from '../../src/T';
import { compositionLabel } from '../../src/composition';
import { Screen, Card, Button, ListRow, EmptyState, SkeletonCard, Icon } from '../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; travel_date: string; budget?: number; currency: string; members: Member[] };

export default function Trips() {
  const { colors } = useTheme();
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
            subtitle={`${t.travel_date} · ${t.currency}${t.budget ? ` · Budget ${t.budget}` : ''}`}
            meta={`${compositionLabel(t.members)} · Code ${t.code}`}
            onPress={() => router.push(`/trip/${t.id}`)}
          />
        ))
      )}
    </Screen>
  );
}
