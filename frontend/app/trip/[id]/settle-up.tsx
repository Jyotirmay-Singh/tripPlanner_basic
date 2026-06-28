import React, { useCallback, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { api } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS } from '../../../src/theme';
import T from '../../../src/T';
import ConfirmModal from '../../../src/ConfirmModal';
import { memberDisplayNames } from '../../../src/displayNames';
import { canMarkSettlementPaid, RoleTrip } from '../../../src/permissions';
import { Settlement, Transfer, partitionSettlements, isRecorded } from '../../../src/settlements';
import { Screen, Card, Button, Icon, EmptyState, AmountText, SkeletonCard, useToast } from '../../../src/ui';

type Member = { id: string; name: string; user_id?: string | null };
type Balances = {
  net: Record<string, number>;
  transfers: Transfer[];
  members: Member[];
  currency: string;
};
type Trip = RoleTrip & { members: Member[] };

export default function SettleUp() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { colors } = useTheme();
  const toast = useToast();
  const [bal, setBal] = useState<Balances | null>(null);
  const [settlements, setSettlements] = useState<Settlement[] | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // One themed ConfirmModal drives the guarded mark-as-paid (native Alert renders no buttons on web).
  const [confirm, setConfirm] = useState<
    null | { title: string; message?: string; onYes: () => void; yesId?: string }
  >(null);

  const load = useCallback(async () => {
    try {
      const [b, s, t] = await Promise.all([
        api<Balances>(`/trips/${id}/balances`),
        api<Settlement[]>(`/trips/${id}/settlements`),
        api<Trip>(`/trips/${id}`),
      ]);
      setBal(b);
      setSettlements(s);
      setTrip(t);
    } catch {}
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Record a suggested transfer as a durable PENDING settlement (moves no money, doesn't offset).
  const record = async (t: Transfer, i: number) => {
    setBusyKey(`rec-${i}`);
    try {
      await api(`/trips/${id}/settlements`, {
        method: 'POST',
        body: { from_member_id: t.from_member_id, to_member_id: t.to_member_id, amount: t.amount },
      });
      toast.show('Recorded as pending', 'success');
      await load();
    } catch (e: any) {
      toast.show(e.message || 'Could not record', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  // Flip a pending settlement to paid (offsets balances). Only reached after the ConfirmModal.
  const markPaid = async (s: Settlement) => {
    setBusyKey(s.id);
    try {
      await api(`/trips/${id}/settlements/${s.id}`, { method: 'PATCH', body: { status: 'paid' } });
      toast.show('Marked as paid', 'success');
      await load();
    } catch (e: any) {
      toast.show(e.message || 'Could not mark paid', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const askMarkPaid = (s: Settlement) =>
    setConfirm({
      title: 'Mark as paid?',
      message:
        "Has the borrower actually paid this in full? This records the payment and updates everyone's balance.",
      onYes: () => { setConfirm(null); markPaid(s); },
      yesId: `mark-paid-confirm-${s.id}`,
    });

  const members = bal?.members ?? [];
  const displayNames = memberDisplayNames(members);
  const nameOf = (mid: string) => displayNames[mid] || '?';
  const currency = bal?.currency ?? '';
  const { pending, paid } = partitionSettlements(settlements);
  const loading = !bal || !settlements || !trip;

  const Parties = ({ from, to }: { from: string; to: string }) => (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={styles.partyRow}>
        <View style={[styles.dot, { backgroundColor: colors.danger + '22' }]}>
          <Icon name="arrow-up" size={14} color={colors.danger} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="caption" muted>Pays</T>
          <T variant="h4" color={colors.danger} numberOfLines={1}>{nameOf(from)}</T>
        </View>
      </View>
      <View style={[styles.connector, { borderColor: colors.border }]} />
      <View style={styles.partyRow}>
        <View style={[styles.dot, { backgroundColor: colors.success + '22' }]}>
          <Icon name="arrow-down" size={14} color={colors.success} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="caption" muted>Receives</T>
          <T variant="h4" color={colors.success} numberOfLines={1}>{nameOf(to)}</T>
        </View>
      </View>
    </View>
  );

  const Badge = ({ label, color, icon }: { label: string; color: string; icon?: 'check-circle' | 'clock' }) => (
    <View style={[styles.badge, { backgroundColor: color + '22' }]}>
      {icon ? <Icon name={icon} size={12} color={color} /> : null}
      <T variant="caption" color={color} style={{ fontWeight: '700' }}>{label}</T>
    </View>
  );

  return (
    <Screen edges={['bottom']}>
      <T variant="h1">Settle Up</T>
      <T muted>The fewest transfers to zero everyone out.</T>

      {loading ? (
        <SkeletonCard count={3} />
      ) : bal.transfers.length === 0 ? (
        <EmptyState icon="check-circle" title="All square!" body="No one owes anything on this trip." testID="settle-empty" />
      ) : (
        bal.transfers.map((t, i) => {
          const recorded = isRecorded(t, pending);
          return (
            <Card key={`suggest-${i}`} style={styles.card}>
              <Parties from={t.from_member_id} to={t.to_member_id} />
              <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
                <AmountText value={t.amount} variant="money" />
                <T variant="caption" muted>{currency}</T>
                {recorded ? (
                  <Badge label="Recorded" color={colors.textMuted} icon="clock" />
                ) : (
                  <Button
                    label="Record"
                    size="sm"
                    variant="secondary"
                    loading={busyKey === `rec-${i}`}
                    onPress={() => record(t, i)}
                    testID={`record-${i}`}
                  />
                )}
              </View>
            </Card>
          );
        })
      )}

      {/* ---------- Settlement history (pending + paid) ---------- */}
      {!loading && (pending.length > 0 || paid.length > 0) ? (
        <View style={{ marginTop: SPACING.lg, gap: SPACING.sm }}>
          <T variant="h3">Settlement history</T>
          <T muted>Recorded payments. Pending items do not change balances until marked paid.</T>

          {pending.map((s) => {
            const allowed = canMarkSettlementPaid(trip, s, user?.id, members);
            return (
              <Card key={s.id} style={styles.card}>
                <Parties from={s.from_member_id} to={s.to_member_id} />
                <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
                  <AmountText value={s.amount} variant="money" />
                  <T variant="caption" muted>{currency}</T>
                  {allowed ? (
                    <Button
                      label="Mark paid"
                      size="sm"
                      loading={busyKey === s.id}
                      onPress={() => askMarkPaid(s)}
                      testID={`mark-paid-${s.id}`}
                    />
                  ) : (
                    <Badge label="Pending" color={colors.textMuted} icon="clock" />
                  )}
                </View>
              </Card>
            );
          })}

          {paid.map((s) => (
            <Card key={s.id} style={styles.card}>
              <Parties from={s.from_member_id} to={s.to_member_id} />
              <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
                <AmountText value={s.amount} variant="money" />
                <T variant="caption" muted>{currency}</T>
                <Badge label="Paid" color={colors.success} icon="check-circle" />
                {s.paid_at ? <T variant="caption" muted>{s.paid_at.slice(0, 10)}</T> : null}
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      <ConfirmModal
        visible={!!confirm}
        title={confirm?.title || ''}
        message={confirm?.message}
        onRequestClose={() => setConfirm(null)}
        actions={[
          { label: 'Cancel', variant: 'cancel', onPress: () => setConfirm(null) },
          { label: 'Mark paid', variant: 'primary', onPress: () => confirm?.onYes(), testID: confirm?.yesId },
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', gap: SPACING.md, alignItems: 'center' },
  partyRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  dot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  connector: { height: 12, marginLeft: 13, borderLeftWidth: 2, marginVertical: 2 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: RADIUS.pill,
  },
});
