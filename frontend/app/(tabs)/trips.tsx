import React, { useCallback, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/api';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS, LAYOUT } from '../../src/theme';
import T from '../../src/T';
import { compositionLabel } from '../../src/composition';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; travel_date: string; budget?: number; currency: string; members: Member[] };

export default function Trips() {
  const { colors } = useTheme();
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setTrips(await api<Trip[]>('/trips')); } catch {}
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={{ padding: SPACING.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="h1">Trips</T>
        <TouchableOpacity testID="trips-new-btn" onPress={() => router.push('/create-trip')}
          style={{ flexDirection: 'row', backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.pill, gap: 6, alignItems: 'center' }}>
          <Ionicons name="add" size={18} color={colors.primaryText} />
          <T color={colors.primaryText} style={{ fontWeight: '700' }}>New</T>
        </TouchableOpacity>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md, paddingBottom: LAYOUT.scrollBottomInset }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />}
      >
        <TouchableOpacity testID="trips-join-btn" onPress={() => router.push('/join-trip')}
          style={[styles.join, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Ionicons name="key-outline" size={18} color={colors.primary} />
          <T color={colors.primary} style={{ fontWeight: '700' }}>Join a trip with code</T>
        </TouchableOpacity>
        {trips.length === 0 && (
          <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Ionicons name="briefcase-outline" size={36} color={colors.textMuted} />
            <T muted style={{ marginTop: SPACING.sm }}>No trips yet</T>
          </View>
        )}
        {trips.map((t) => (
          <TouchableOpacity
            testID={`trip-item-${t.id}`}
            key={t.id}
            onPress={() => router.push(`/trip/${t.id}`)}
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <View style={{ flex: 1 }}>
              <T variant="h3">{t.name}</T>
              <T muted variant="caption" style={{ marginTop: 2 }}>
                {t.travel_date} · {t.currency}{t.budget ? ` · Budget ${t.budget}` : ''}
              </T>
              <T muted variant="caption" style={{ marginTop: 2 }}>
                {compositionLabel(t.members)}
              </T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                <Ionicons name="link-outline" size={12} color={colors.textMuted} />
                <T variant="caption" muted>Code {t.code}</T>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  join: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: SPACING.sm, padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1,
  },
  card: { padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1, flexDirection: 'row', alignItems: 'center' },
  empty: { padding: SPACING.xl, borderRadius: RADIUS.lg, borderWidth: 1, alignItems: 'center' },
});
