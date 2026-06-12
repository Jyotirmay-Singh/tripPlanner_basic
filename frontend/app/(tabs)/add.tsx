import React, { useCallback, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/api';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';

type Trip = { id: string; name: string; currency: string };

export default function AddTab() {
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
      <ScrollView
        contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />}
      >
        <T variant="h1">Add transaction</T>
        <T muted>Pick a trip to add an expense or income.</T>

        {trips.length === 0 && (
          <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Ionicons name="wallet-outline" size={36} color={colors.textMuted} />
            <T muted style={{ marginTop: SPACING.sm, textAlign: 'center' }}>
              Create a trip first to start tracking expenses.
            </T>
            <TouchableOpacity onPress={() => router.push('/create-trip')}
              style={[styles.cta, { backgroundColor: colors.primary }]}>
              <T color={colors.primaryText} style={{ fontWeight: '700' }}>Create trip</T>
            </TouchableOpacity>
          </View>
        )}

        {trips.map((t) => (
          <TouchableOpacity
            testID={`add-tab-trip-${t.id}`}
            key={t.id}
            onPress={() => router.push(`/trip/${t.id}/add-expense`)}
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <View style={[styles.iconCircle, { backgroundColor: colors.surfaceMuted }]}>
              <Ionicons name="add" size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <T variant="h3">{t.name}</T>
              <T muted variant="caption">Tap to add an expense</T>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  empty: { padding: SPACING.xl, borderRadius: RADIUS.lg, borderWidth: 1, alignItems: 'center', gap: SPACING.md },
  cta: { paddingHorizontal: SPACING.lg, paddingVertical: 12, borderRadius: RADIUS.pill },
  card: {
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
  },
  iconCircle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
