import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';
import { compositionLabel } from '../../src/composition';
import { formatTripDates } from '../../src/date';
import UnverifiedBanner from '../../src/UnverifiedBanner';
import {
  Screen, Card, Button, StatCard, ListRow, EmptyState, AmountText, SkeletonCard, Fab,
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
  const [owing, setOwing] = useState(0);
  const [owed, setOwed] = useState(0);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await api<Trip[]>('/trips');
      setTrips(list);
      let _owe = 0, _owed = 0;
      for (const t of list) {
        try {
          const b = await api<any>(`/trips/${t.id}/balances`);
          const myMember = (b.members as any[]).find((m) => m.user_id === user?.id);
          if (myMember) {
            const net = b.net[myMember.id] || 0;
            if (net < 0) _owe += -net; else _owed += net;
          }
        } catch {}
      }
      setOwing(_owe); setOwed(_owed);
    } catch {}
    setRefreshing(false);
    setLoaded(true);
  }, [user?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const net = owed - owing;

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={load}
      fab={<Fab icon="plus" accessibilityLabel="Add transaction" testID="dash-fab" onPress={() => router.push('/add')} />}
    >
      <View>
        <T variant="label" muted>Hello, {user?.name?.split(' ')[0] || 'traveller'}</T>
        <T variant="h1" style={{ marginTop: 2 }}>Dashboard</T>
      </View>

      <UnverifiedBanner />

      {/* Bento: full-width net position card */}
      <Card variant="primary" padding="lg" radius={RADIUS.xl}>
        <T variant="label" color={colors.primaryText} style={{ opacity: 0.85 }}>Net position</T>
        <AmountText
          value={net}
          variant="moneyLg"
          signed
          color={colors.primaryText}
          style={{ marginTop: SPACING.xs }}
        />
        <T color={colors.primaryText} style={{ opacity: 0.8, marginTop: 2 }}>
          {net >= 0 ? 'You come out ahead' : 'You owe overall'} · {trips.length} trip{trips.length === 1 ? '' : 's'}
        </T>
      </Card>

      {/* Bento: two columns */}
      <View style={{ flexDirection: 'row', gap: SPACING.md }}>
        <StatCard label="You owe" value={owing.toFixed(2)} valueColor={colors.danger} testID="dash-you-owe" />
        <StatCard label="You're owed" value={owed.toFixed(2)} valueColor={colors.success} testID="dash-you-owed" />
      </View>

      <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
        <View style={{ flex: 1 }}>
          <Button label="New Trip" icon="plus" onPress={() => router.push('/create-trip')} fullWidth testID="dash-new-trip" />
        </View>
        <View style={{ flex: 1 }}>
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
        trips.slice(0, 5).map((t) => (
          <ListRow
            key={t.id}
            testID={`dash-trip-${t.id}`}
            icon="plane"
            title={t.name}
            subtitle={`${formatTripDates(t)} · ${t.currency} · Code ${t.code}`}
            meta={compositionLabel(t.members)}
            onPress={() => router.push(`/trip/${t.id}`)}
          />
        ))
      )}
    </Screen>
  );
}
