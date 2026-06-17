import React, { useCallback, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, LAYOUT } from '../../../src/theme';
import T from '../../../src/T';

type Member = { id: string; name: string };
type Balances = {
  net: Record<string, number>;
  transfers: { from_member_id: string; to_member_id: string; amount: number }[];
  members: Member[];
  currency: string;
};

export default function SettleUp() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const [bal, setBal] = useState<Balances | null>(null);
  const [busyIdx, setBusyIdx] = useState<number | null>(null);

  const load = useCallback(async () => {
    try { setBal(await api<Balances>(`/trips/${id}/balances`)); } catch {}
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const settle = async (i: number) => {
    if (!bal) return;
    const t = bal.transfers[i];
    setBusyIdx(i);
    try {
      await api(`/trips/${id}/settle`, { method: 'POST', body: t });
      await load();
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setBusyIdx(null); }
  };

  const nameOf = (mid: string) => bal?.members.find((m) => m.id === mid)?.name || '?';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md, paddingBottom: LAYOUT.scrollBottomInset }}>
        <T variant="h1">Settle Up</T>
        <T muted>Minimum number of transactions to zero out everyone.</T>

        {!bal && <T muted>Loading…</T>}

        {bal && bal.transfers.length === 0 && (
          <View style={[styles.allSquare, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Ionicons name="checkmark-circle" size={48} color={colors.owed} />
            <T variant="h3" style={{ marginTop: SPACING.sm }}>All square!</T>
            <T muted>No one owes anything.</T>
          </View>
        )}

        {bal?.transfers.map((t, i) => (
          <View key={i} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <T variant="caption" muted>From</T>
              <T variant="h3" color={colors.owing}>{nameOf(t.from_member_id)}</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 4 }}>
                <Ionicons name="arrow-down" size={16} color={colors.textMuted} />
              </View>
              <T variant="caption" muted>To</T>
              <T variant="h3" color={colors.owed}>{nameOf(t.to_member_id)}</T>
            </View>
            <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
              <T variant="money">{t.amount.toFixed(2)}</T>
              <T variant="caption" muted>{bal.currency}</T>
              <TouchableOpacity testID={`settle-${i}`}
                disabled={busyIdx === i}
                onPress={() => settle(i)}
                style={[styles.btn, { backgroundColor: colors.primary }]}>
                <T color={colors.primaryText} style={{ fontWeight: '700' }}>
                  {busyIdx === i ? '…' : 'Mark paid'}
                </T>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', gap: SPACING.md, padding: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1,
  },
  btn: { paddingHorizontal: SPACING.md, paddingVertical: 10, borderRadius: RADIUS.pill },
  allSquare: { padding: SPACING.xl, borderRadius: RADIUS.lg, borderWidth: 1, alignItems: 'center' },
});
