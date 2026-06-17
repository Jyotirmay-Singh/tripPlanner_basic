import React, { useCallback, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, Alert, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../../src/api';
import { useTheme } from '../../../../src/ThemeContext';
import { SPACING, RADIUS, LAYOUT } from '../../../../src/theme';
import T from '../../../../src/T';

type Member = { id: string; name: string };
type Trip = { id: string; name: string; currency: string; members: Member[] };
type Expense = { id: string; kind: string; amount: number; category: string; description?: string; date: string; paid_by_member_id: string };

export default function CategoryDetail() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const decoded = decodeURIComponent(name as string);
  const { colors } = useTheme();
  const router = useRouter();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [t, e] = await Promise.all([api<Trip>(`/trips/${id}`), api<Expense[]>(`/trips/${id}/expenses`)]);
      setTrip(t); setExpenses(e);
    } catch (err: any) { Alert.alert('Error', err.message); }
    setRefreshing(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = expenses.filter((e) => e.kind === 'expense' && e.category === decoded);
  const total = filtered.reduce((s, e) => s + e.amount, 0);
  const memberById = (mid: string) => trip?.members.find((m) => m.id === mid)?.name || '?';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md, paddingBottom: LAYOUT.scrollBottomInset }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />}
      >
        <View style={[styles.header, { backgroundColor: colors.primary }]}>
          <T variant="label" color={colors.primaryText} style={{ opacity: 0.8 }}>{decoded}</T>
          <T variant="money" color={colors.primaryText} style={{ marginTop: 4 }}>
            {total.toFixed(2)} {trip?.currency || ''}
          </T>
          <T color={colors.primaryText} style={{ opacity: 0.75, marginTop: 4 }}>
            {filtered.length} transaction{filtered.length === 1 ? '' : 's'}
          </T>
        </View>

        {filtered.length === 0 && <T muted style={{ padding: SPACING.md }}>No transactions in this category.</T>}
        {filtered.map((e) => (
          <TouchableOpacity key={e.id}
            onPress={() => router.push({ pathname: '/trip/[id]/edit-expense', params: { id: id as string, eid: e.id } })}
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <T variant="h3">{e.description || decoded}</T>
              <T variant="caption" muted>{e.date} · by {memberById(e.paid_by_member_id)}</T>
            </View>
            <T variant="h3">{e.amount.toFixed(2)}</T>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { padding: SPACING.lg, borderRadius: RADIUS.xl },
  card: { padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
});
