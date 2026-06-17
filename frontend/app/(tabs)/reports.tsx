import React, { useCallback, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api, getToken } from '../../src/api';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS, LAYOUT } from '../../src/theme';
import T from '../../src/T';

type Trip = { id: string; name: string; currency: string };

export default function Reports() {
  const { colors } = useTheme();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setTrips(await api<Trip[]>('/trips')); } catch {}
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openXlsx = async (tripId: string) => {
    const token = await getToken();
    if (!token) return;
    const base = process.env.EXPO_PUBLIC_BACKEND_URL;
    await Linking.openURL(`${base}/api/trips/${tripId}/report.xlsx?token=${encodeURIComponent(token)}`);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md, paddingBottom: LAYOUT.scrollBottomInset }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />}
      >
        <T variant="h1">Reports</T>
        <T muted>Download XLSX reports per trip.</T>

        {trips.length === 0 && (
          <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Ionicons name="document-outline" size={36} color={colors.textMuted} />
            <T muted style={{ marginTop: SPACING.sm }}>No trips to report.</T>
          </View>
        )}

        {trips.map((t) => (
          <View key={t.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <T variant="h3">{t.name}</T>
              <T muted variant="caption">{t.currency}</T>
            </View>
            <TouchableOpacity
              testID={`report-xlsx-${t.id}`}
              onPress={() => openXlsx(t.id)}
              style={[styles.dlBtn, { backgroundColor: colors.primary }]}
            >
              <Ionicons name="download-outline" size={16} color={colors.primaryText} />
              <T color={colors.primaryText} style={{ fontWeight: '700' }}>XLSX</T>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  empty: { padding: SPACING.xl, borderRadius: RADIUS.lg, borderWidth: 1, alignItems: 'center' },
  card: {
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
  },
  dlBtn: { flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.pill, alignItems: 'center' },
});
