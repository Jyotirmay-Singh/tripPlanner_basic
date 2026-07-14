import React, { useCallback, useState } from 'react';
import { View, StyleSheet, Modal, Pressable, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { api, listPayments, recordPayment, editPayment, deletePayment } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS } from '../../../src/theme';
import T from '../../../src/T';
import ConfirmModal from '../../../src/ConfirmModal';
import { memberDisplayNames } from '../../../src/displayNames';
import { canRecordPayment, RoleTrip } from '../../../src/permissions';
import { Transfer } from '../../../src/settlements';
import { Payment, PairBlock, buildPairBlocks, validatePaymentAmount } from '../../../src/payments';
import { formatMoney } from '../../../src/format';
import { formatIST } from '../../../src/istTime';
import {
  Screen, Card, Button, Icon, IconButton, Input, EmptyState, AmountText, SkeletonCard, ProgressBar, useToast,
} from '../../../src/ui';

type Member = { id: string; name: string; user_id?: string | null };
type Balances = {
  net: Record<string, number>;
  transfers: Transfer[];
  members: Member[];
  currency: string;
};
type Trip = RoleTrip & { members: Member[] };

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export default function SettleUp() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { colors } = useTheme();
  const toast = useToast();
  const [bal, setBal] = useState<Balances | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [busy, setBusy] = useState(false);

  // The amount editor (record OR edit); when set, its Modal is mounted fresh.
  const [editor, setEditor] = useState<
    | null
    | { mode: 'record' | 'edit'; fromId: string; toId: string; fromName: string; toName: string;
        initial: number; max: number; paymentId?: string; note?: string }
  >(null);
  // The shared themed guard-rail (native Alert renders no buttons on web).
  const [confirm, setConfirm] = useState<
    | null
    | { title: string; message?: string; yesLabel: string; yesVariant: 'primary' | 'destructive';
        onYes: () => void; yesId?: string }
  >(null);

  const load = useCallback(async () => {
    try {
      const [b, p, t] = await Promise.all([
        api<Balances>(`/trips/${id}/balances`),
        listPayments(id),
        api<Trip>(`/trips/${id}`),
      ]);
      setBal(b);
      setPayments(p);
      setTrip(t);
    } catch {}
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const members = bal?.members ?? [];
  const displayNames = memberDisplayNames(members);
  const nameOf = (mid: string) => displayNames[mid] || '?';
  const currency = bal?.currency ?? '';
  const loading = !bal || !payments || !trip;

  const blocks = buildPairBlocks(bal?.transfers ?? [], payments ?? []);
  const active = blocks.filter((b) => b.current_payable > 0.01);
  const settled = blocks.filter((b) => b.current_payable <= 0.01);

  const allow = (toId: string) => !!trip && canRecordPayment(trip, toId, user?.id, members);

  // ---- Async mutations (only reached AFTER the ConfirmModal guard-rail) ----
  const doRecord = async (fromId: string, toId: string, amount: number, note?: string) => {
    setBusy(true);
    try {
      await recordPayment(id, { from_member_id: fromId, to_member_id: toId, amount, ...(note ? { note } : {}) });
      toast.show('Payment recorded', 'success');
      await load();
    } catch (e: any) {
      toast.show(e.message || 'Could not record payment', 'error');
      await load(); // self-heal: a 409 (or any failure) refreshes balances so the user can retry
    } finally {
      setBusy(false);
    }
  };
  const doEdit = async (paymentId: string, amount: number, note?: string) => {
    setBusy(true);
    try {
      await editPayment(id, paymentId, { amount, note: note ?? '' });
      toast.show('Payment updated', 'success');
      await load();
    } catch (e: any) {
      toast.show(e.message || 'Could not update payment', 'error');
      await load(); // self-heal: a 409 (or any failure) refreshes balances so the user can retry
    } finally {
      setBusy(false);
    }
  };
  const doDelete = async (paymentId: string) => {
    setBusy(true);
    try {
      await deletePayment(id, paymentId);
      toast.show('Payment removed', 'success');
      await load();
    } catch (e: any) {
      toast.show(e.message || 'Could not remove payment', 'error');
    } finally {
      setBusy(false);
    }
  };

  // ---- Flows: editor -> guard-rail -> mutation ----
  const openRecord = (b: PairBlock) =>
    setEditor({
      mode: 'record', fromId: b.from_member_id, toId: b.to_member_id,
      fromName: nameOf(b.from_member_id), toName: nameOf(b.to_member_id),
      initial: b.current_payable, max: b.current_payable,
    });

  const openEdit = (b: PairBlock, p: Payment) =>
    setEditor({
      mode: 'edit', fromId: b.from_member_id, toId: b.to_member_id,
      fromName: nameOf(b.from_member_id), toName: nameOf(b.to_member_id),
      // Cap on edit = current residual + this payment's own effect (mirrors the backend).
      initial: p.amount, max: round2(b.current_payable + p.amount), paymentId: p.id,
      note: p.note ?? '',
    });

  const onEditorSubmit = (amount: number, note: string) => {
    const e = editor;
    if (!e) return;
    const remark = note.trim();
    setEditor(null);
    setConfirm({
      title: e.mode === 'edit' ? 'Update payment?' : 'Confirm payment',
      message: `Confirm ${e.fromName} paid ${formatMoney(amount, { currency })} to ${e.toName}?`,
      yesLabel: e.mode === 'edit' ? 'Update' : 'Confirm',
      yesVariant: 'primary',
      yesId: 'payment-confirm',
      onYes: () => {
        setConfirm(null);
        if (e.mode === 'edit' && e.paymentId) doEdit(e.paymentId, amount, remark);
        else doRecord(e.fromId, e.toId, amount, remark);
      },
    });
  };

  const askDelete = (b: PairBlock, p: Payment) =>
    setConfirm({
      title: 'Remove this payment?',
      message: `This deletes "${nameOf(b.from_member_id)} paid ${formatMoney(p.amount, { currency })} to ${nameOf(b.to_member_id)}" and re-opens that much of the balance.`,
      yesLabel: 'Remove',
      yesVariant: 'destructive',
      yesId: `payment-delete-${p.id}`,
      onYes: () => { setConfirm(null); doDelete(p.id); },
    });

  // ---- Presentational pieces ----
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

  const PaymentLog = ({ b }: { b: PairBlock }) => {
    if (b.payments.length === 0) return null;
    const canEdit = allow(b.to_member_id);
    return (
      <View style={[styles.log, { borderTopColor: colors.border }]}>
        {b.payments.map((p) => (
          <View key={p.id} style={styles.logRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T variant="caption">
                {nameOf(b.from_member_id)} paid {formatMoney(p.amount, { currency })} to {nameOf(b.to_member_id)}
              </T>
              <T variant="caption" muted>{formatIST(p.created_at)}</T>
              {p.note && p.note.trim() ? (
                <T variant="caption" muted numberOfLines={2}>{p.note.trim()}</T>
              ) : null}
            </View>
            {canEdit ? (
              <View style={styles.logActions}>
                <IconButton
                  name="pencil" size={16} variant="plain"
                  accessibilityLabel="Edit payment"
                  onPress={() => openEdit(b, p)} testID={`payment-edit-${p.id}`}
                />
                <IconButton
                  name="trash" size={16} color={colors.danger}
                  accessibilityLabel="Delete payment"
                  onPress={() => askDelete(b, p)} testID={`payment-delete-btn-${p.id}`}
                />
              </View>
            ) : null}
          </View>
        ))}
      </View>
    );
  };

  return (
    <Screen edges={['bottom']}>
      <T variant="h1">Settle Up</T>
      <T muted>The fewest transfers to zero everyone out. Tap Settle up to record a payment.</T>

      {loading ? (
        <SkeletonCard count={3} />
      ) : active.length === 0 && settled.length === 0 ? (
        <EmptyState icon="check-circle" title="All square!" body="No one owes anything on this trip." testID="settle-empty" />
      ) : (
        <>
          {active.map((b, i) => (
            <Card key={`active-${b.from_member_id}-${b.to_member_id}`} style={styles.card}>
              <View style={styles.cardTop}>
                <Parties from={b.from_member_id} to={b.to_member_id} />
                <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
                  <AmountText value={b.current_payable} variant="money" testID={`payable-${i}`} />
                  <T variant="caption" muted>{currency}</T>
                  {b.status === 'partial' ? (
                    <Badge label="Partially Paid" color={colors.warning} icon="clock" />
                  ) : null}
                  {allow(b.to_member_id) ? (
                    <Button
                      label="Settle up"
                      size="sm"
                      loading={busy}
                      onPress={() => openRecord(b)}
                      testID={`settle-${i}`}
                    />
                  ) : null}
                </View>
              </View>
              {b.status === 'partial' ? (
                <View style={{ marginTop: SPACING.sm }}>
                  <ProgressBar progress={b.original_payable > 0 ? b.paid / b.original_payable : 0} />
                  <T variant="caption" muted style={{ marginTop: 4 }}>
                    {formatMoney(b.paid, { currency })} paid of {formatMoney(b.original_payable, { currency })}
                  </T>
                </View>
              ) : null}
              <PaymentLog b={b} />
            </Card>
          ))}

          {settled.length > 0 ? (
            <View style={{ marginTop: SPACING.lg, gap: SPACING.sm }}>
              <T variant="h3">Settled</T>
              <T muted>Fully paid off. Recorded payments are listed below.</T>
              {settled.map((b) => (
                <Card key={`settled-${b.from_member_id}-${b.to_member_id}`} style={styles.card}>
                  <View style={styles.cardTop}>
                    <Parties from={b.from_member_id} to={b.to_member_id} />
                    <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
                      <T variant="caption" muted>{formatMoney(b.paid, { currency })}</T>
                      <Badge label="Paid" color={colors.success} icon="check-circle" />
                    </View>
                  </View>
                  <PaymentLog b={b} />
                </Card>
              ))}
            </View>
          ) : null}
        </>
      )}

      {editor ? (
        <AmountModal
          title={editor.mode === 'edit' ? 'Edit payment' : 'Record payment'}
          subtitle={`${editor.fromName} pays ${editor.toName}`}
          initial={editor.initial}
          max={editor.max}
          currency={currency}
          initialNote={editor.note ?? ''}
          submitLabel={editor.mode === 'edit' ? 'Continue' : 'Continue'}
          onCancel={() => setEditor(null)}
          onSubmit={onEditorSubmit}
        />
      ) : null}

      <ConfirmModal
        visible={!!confirm}
        title={confirm?.title || ''}
        message={confirm?.message}
        onRequestClose={() => setConfirm(null)}
        actions={[
          { label: 'Cancel', variant: 'cancel', onPress: () => setConfirm(null) },
          {
            label: confirm?.yesLabel || 'Confirm',
            variant: confirm?.yesVariant || 'primary',
            onPress: () => confirm?.onYes(),
            testID: confirm?.yesId,
          },
        ]}
      />
    </Screen>
  );
}

// Themed amount-entry modal (mirrors ConfirmModal's look). Prefilled to the full payable with a
// "Max <amt>" hint and >0 / <=max validation; a valid submit hands the amount back so the caller can
// raise the ConfirmModal guard-rail.
// Exported (named) for a focused render test of the ✕/footer wiring — expo-router only consumes
// the file's default export, so this does not register a route.
export function AmountModal({
  title, subtitle, initial, max, currency, initialNote, submitLabel, onCancel, onSubmit,
}: {
  title: string; subtitle: string; initial: number; max: number; currency: string;
  initialNote: string; submitLabel: string; onCancel: () => void;
  onSubmit: (amount: number, note: string) => void;
}) {
  const { colors } = useTheme();
  const [amountStr, setAmountStr] = useState(String(round2(initial)));
  const [noteStr, setNoteStr] = useState(initialNote);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const amt = round2(Number(amountStr));
    const v = validatePaymentAmount(amt, max);
    if (!v.ok) { setError(v.error); return; }
    onSubmit(amt, noteStr);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      {/* Tap-outside-to-dismiss (kept). The KeyboardAvoidingView lifts the centered card above the
          keyboard so the pinned Cancel/Continue footer stays reachable; the body scrolls if it can't
          fit (small screens / keyboard open). */}
      <Pressable style={styles.scrim} onPress={onCancel}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalKav}
        >
          <Pressable
            onPress={() => {}}
            style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            {/* Header: title + explicit ✕ close (cancels WITHOUT recording). Reuses the canonical
                IconButton close pattern from src/ui/Toast.tsx (44px hit target, themed muted). */}
            <View style={styles.modalHeader}>
              <T variant="h3" style={{ flex: 1 }}>{title}</T>
              <IconButton
                name="close"
                onPress={onCancel}
                accessibilityLabel="Close"
                variant="plain"
                size={18}
                color={colors.textMuted}
                testID="payment-close"
                style={styles.modalClose}
              />
            </View>
            <ScrollView
              style={styles.modalBody}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: SPACING.xs }}
            >
              <T muted>{subtitle}</T>
              <Input
                label={`Amount (${currency})`}
                value={amountStr}
                onChangeText={(t) => { setAmountStr(t); if (error) setError(null); }}
                keyboardType="decimal-pad"
                inputMode="decimal"
                helper={`Max ${formatMoney(max, { currency })}`}
                error={error}
                autoFocus
                containerStyle={{ marginTop: SPACING.md }}
                testID="payment-amount-input"
              />
              <Input
                label="Remark (optional)"
                value={noteStr}
                onChangeText={setNoteStr}
                placeholder="Made the payment on Gpay app."
                multiline
                containerStyle={{ marginTop: SPACING.md }}
                testID="payment-remark-input"
              />
            </ScrollView>
            {/* Footer pinned below the scroll region — always visible/reachable. */}
            <View style={{ flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md }}>
              <Button label="Cancel" variant="secondary" onPress={onCancel} style={{ flex: 1 }} />
              <Button label={submitLabel} onPress={submit} style={{ flex: 1 }} testID="payment-amount-continue" />
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: { gap: SPACING.sm },
  cardTop: { flexDirection: 'row', gap: SPACING.md, alignItems: 'center' },
  partyRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  dot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  connector: { height: 12, marginLeft: 13, borderLeftWidth: 2, marginVertical: 2 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: RADIUS.pill,
  },
  log: { marginTop: SPACING.sm, paddingTop: SPACING.sm, borderTopWidth: StyleSheet.hairlineWidth, gap: SPACING.xs },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  logActions: { flexDirection: 'row', alignItems: 'center' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  // KAV owns the centering + outer padding so `behavior:'padding'` can add keyboard-height inset
  // and slide the card up on iOS.
  modalKav: { flex: 1, justifyContent: 'center', padding: SPACING.lg },
  // maxHeight bounds the card so the body ScrollView can scroll; header + footer stay pinned.
  modalCard: { borderRadius: RADIUS.lg, borderWidth: 1, padding: SPACING.lg, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.xs },
  // flexShrink lets the scroll area absorb overflow (keyboard open / small screen) while the
  // header and footer keep their natural height.
  modalBody: { flexGrow: 0, flexShrink: 1 },
  // Negative margins overlap the card padding so the 44px ✕ hit target aligns to the top-right
  // edge without growing the header (mirrors src/ui/Toast.tsx `close`).
  modalClose: { marginVertical: -SPACING.sm, marginRight: -SPACING.sm },
});
