import React, { useCallback, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING } from '../../../src/theme';
import T from '../../../src/T';
import { Screen, Card, Button, Icon, EmptyState, AmountText, SkeletonCard, useToast } from '../../../src/ui';

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
  const toast = useToast();
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
      toast.show('Marked as paid', 'success');
      await load();
    } catch (e: any) { toast.show(e.message || 'Could not settle', 'error'); }
    finally { setBusyIdx(null); }
  };

  const nameOf = (mid: string) => bal?.members.find((m) => m.id === mid)?.name || '?';

  return (
    <Screen edges={['bottom']}>
      <T variant="h1">Settle Up</T>
      <T muted>The fewest transactions to zero everyone out.</T>

      {!bal ? (
        <SkeletonCard count={3} />
      ) : bal.transfers.length === 0 ? (
        <EmptyState icon="check-circle" title="All square!" body="No one owes anything on this trip." testID="settle-empty" />
      ) : (
        bal.transfers.map((t, i) => (
          <Card key={i} style={styles.card}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={styles.partyRow}>
                <View style={[styles.dot, { backgroundColor: colors.danger + '22' }]}>
                  <Icon name="arrow-up" size={14} color={colors.danger} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T variant="caption" muted>Pays</T>
                  <T variant="h4" color={colors.danger} numberOfLines={1}>{nameOf(t.from_member_id)}</T>
                </View>
              </View>
              <View style={[styles.connector, { borderColor: colors.border }]} />
              <View style={styles.partyRow}>
                <View style={[styles.dot, { backgroundColor: colors.success + '22' }]}>
                  <Icon name="arrow-down" size={14} color={colors.success} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T variant="caption" muted>Receives</T>
                  <T variant="h4" color={colors.success} numberOfLines={1}>{nameOf(t.to_member_id)}</T>
                </View>
              </View>
            </View>
            <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
              <AmountText value={t.amount} variant="money" />
              <T variant="caption" muted>{bal.currency}</T>
              <Button label={busyIdx === i ? '…' : 'Mark paid'} size="sm" loading={busyIdx === i} onPress={() => settle(i)} testID={`settle-${i}`} />
            </View>
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', gap: SPACING.md, alignItems: 'center' },
  partyRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  dot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  connector: { height: 12, marginLeft: 13, borderLeftWidth: 2, marginVertical: 2 },
});
