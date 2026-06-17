import React, { useCallback, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS, LAYOUT } from '../../src/theme';
import T from '../../src/T';
import { compositionLabel } from '../../src/composition';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; travel_date: string; budget?: number; currency: string; members: Member[] };

export default function Dashboard() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [owing, setOwing] = useState(0);
  const [owed, setOwed] = useState(0);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await api<Trip[]>('/trips');
      setTrips(list);
      // Aggregate balances (optional, simple)
      let _owe = 0, _owed = 0;
      for (const t of list) {
        try {
          const b = await api<any>(`/trips/${t.id}/balances`);
          // find member linked to current user
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
  }, [user?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md, paddingBottom: LAYOUT.scrollBottomInset }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />}
      >
        <View>
          <T variant="label" muted>Hello, {user?.name?.split(' ')[0]}</T>
          <T variant="h1" style={{ marginTop: 2 }}>Dashboard</T>
        </View>

        {/* Bento balance */}
        <View style={[styles.netCard, { backgroundColor: colors.primary }]}>
          <T variant="label" color={colors.primaryText} style={{ opacity: 0.8 }}>Net position</T>
          <T variant="money" color={colors.primaryText} style={{ marginTop: 4 }}>
            {owed - owing >= 0 ? '+' : ''}{(owed - owing).toFixed(2)}
          </T>
          <T color={colors.primaryText} style={{ opacity: 0.75 }}>Across {trips.length} trip{trips.length === 1 ? '' : 's'}</T>
        </View>

        <View style={{ flexDirection: 'row', gap: SPACING.md }}>
          <View style={[styles.miniCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <T variant="label" muted>You owe</T>
            <T variant="h2" color={colors.owing} style={{ marginTop: 4 }}>{owing.toFixed(2)}</T>
          </View>
          <View style={[styles.miniCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <T variant="label" muted>You're owed</T>
            <T variant="h2" color={colors.owed} style={{ marginTop: 4 }}>{owed.toFixed(2)}</T>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm }}>
          <TouchableOpacity testID="dash-new-trip"
            onPress={() => router.push('/create-trip')}
            style={[styles.actionBtn, { backgroundColor: colors.primary }]}>
            <Ionicons name="add" size={18} color={colors.primaryText} />
            <T color={colors.primaryText} style={{ fontWeight: '700' }}>New Trip</T>
          </TouchableOpacity>
          <TouchableOpacity testID="dash-join-trip"
            onPress={() => router.push('/join-trip')}
            style={[styles.actionBtn, { backgroundColor: colors.surfaceMuted, borderColor: colors.border, borderWidth: 1 }]}>
            <Ionicons name="people-outline" size={18} color={colors.textMain} />
            <T style={{ fontWeight: '700' }}>Join Trip</T>
          </TouchableOpacity>
        </View>

        <T variant="label" muted style={{ marginTop: SPACING.md }}>Recent trips</T>
        {trips.length === 0 && (
          <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Ionicons name="airplane-outline" size={36} color={colors.textMuted} />
            <T muted style={{ marginTop: SPACING.sm }}>No trips yet. Create one to get started!</T>
          </View>
        )}
        {trips.slice(0, 5).map((t) => (
          <TouchableOpacity
            testID={`dash-trip-${t.id}`}
            key={t.id}
            onPress={() => router.push(`/trip/${t.id}`)}
            style={[styles.tripCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <View style={{ flex: 1 }}>
              <T variant="h3">{t.name}</T>
              <T muted variant="caption" style={{ marginTop: 2 }}>
                {t.travel_date} · {t.currency} · Code {t.code}
              </T>
              <T muted variant="caption" style={{ marginTop: 2 }}>
                {compositionLabel(t.members)}
              </T>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  netCard: { padding: SPACING.lg, borderRadius: RADIUS.xl },
  miniCard: { flex: 1, padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1 },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: SPACING.xs, paddingVertical: 14, borderRadius: RADIUS.pill,
  },
  empty: {
    padding: SPACING.xl, borderRadius: RADIUS.lg, borderWidth: 1,
    alignItems: 'center',
  },
  tripCard: {
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center',
  },
});
