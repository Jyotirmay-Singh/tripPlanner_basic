import React, { useCallback, useState } from 'react';
import { View, StyleSheet, Modal, Pressable, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { api, listPayments, recordPayment, editPayment, deletePayment } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS } from '../../../src/theme';
import T from '../../../src/T';
import ConfirmModal from '../../../src/ConfirmModal';
import { memberDisplayNames } from '../../../src/displayNames';
import { canRecordPayment } from '../../../src/permissions';
import type { RoleTrip } from '../../../src/permissions';
import type { Transfer } from '../../../src/settlements';
import { validatePaymentAmount } from '../../../src/payments';
import type { Payment } from '../../../src/payments';
import {
  currentSuggestedAmount,
  formatPreciseMoney,
  usesWholeUnits,
} from '../../../src/settlementProjection';
import type { BalanceResponse } from '../../../src/settlementProjection';
import { formatMoney, formatWholeMoney } from '../../../src/format';
import { formatIST } from '../../../src/istTime';
import {
  Screen, Card, Button, Icon, IconButton, Input, EmptyState, AmountText, SkeletonCard, useToast,
} from '../../../src/ui';

type Member = {
  id: string;
  name: string;
  kind?: string;
  user_id?: string | null;
  family_member_user_ids?: (string | null)[];
};
type Balances = BalanceResponse<Member>;
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
  const [showRounding, setShowRounding] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The amount editor (record OR edit); when set, its Modal is mounted fresh.
  const [editor, setEditor] = useState<
    | null
    | { mode: 'record' | 'edit'; fromId: string; toId: string; fromName: string; toName: string;
        initial: number; max: number; paymentId?: string; note?: string; originalAmount?: number }
  >(null);
  // The shared themed guard-rail (native Alert renders no buttons on web).
  const [confirm, setConfirm] = useState<
    | null
    | { title: string; message?: string; yesLabel: string; yesVariant: 'primary' | 'destructive';
        onYes: () => void; yesId?: string }
  >(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [b, p, t] = await Promise.all([
        api<Balances>(`/trips/${id}/balances`),
        listPayments(id),
        api<Trip>(`/trips/${id}`),
      ]);
      setBal(b);
      setPayments(p);
      setTrip(t);
    } catch (error: any) {
      setLoadError(error?.message || 'Settlement is temporarily unavailable.');
    }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const members = bal?.members ?? [];
  const displayNames = memberDisplayNames(members);
  const nameOf = (mid: string) => displayNames[mid] || '?';
  const currency = bal?.currency ?? '';
  const loading = !bal || !payments || !trip;

  const recommendations = bal?.transfers ?? [];
  const history = [...(payments ?? [])].sort((a, b) =>
    (a.created_at || '') < (b.created_at || '') ? 1 : -1,
  );
  const projection = bal?.settlement_projection;
  const wholeUnit = usesWholeUnits(projection);

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
  const doEdit = async (paymentId: string, amount: number, originalAmount: number, note?: string) => {
    setBusy(true);
    try {
      const body: { amount?: number; note: string } = { note: note ?? '' };
      // Omitting an unchanged amount lets a legacy decimal record receive a note-only edit after
      // whole-unit policy is enabled. Any actual amount edit must satisfy the new policy.
      if (amount !== originalAmount) body.amount = amount;
      await editPayment(id, paymentId, body);
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
  const openRecord = (transfer: Transfer) =>
    setEditor({
      mode: 'record', fromId: transfer.from_member_id, toId: transfer.to_member_id,
      fromName: nameOf(transfer.from_member_id), toName: nameOf(transfer.to_member_id),
      initial: transfer.amount, max: transfer.amount,
    });

  const openEdit = (payment: Payment) =>
    setEditor({
      mode: 'edit', fromId: payment.from_member_id, toId: payment.to_member_id,
      fromName: nameOf(payment.from_member_id), toName: nameOf(payment.to_member_id),
      // Cap on edit = current residual + this payment's own effect (mirrors the backend).
      initial: payment.amount,
      max: wholeUnit
        ? currentSuggestedAmount(
          recommendations, payment.from_member_id, payment.to_member_id,
        ) + payment.amount
        : round2(currentSuggestedAmount(
          recommendations, payment.from_member_id, payment.to_member_id,
        ) + payment.amount),
      paymentId: payment.id,
      note: payment.note ?? '',
      originalAmount: payment.amount,
    });

  const onEditorSubmit = (amount: number, note: string) => {
    const e = editor;
    if (!e) return;
    const remark = note.trim();
    setEditor(null);
    setConfirm({
      title: e.mode === 'edit' ? 'Update payment?' : 'Confirm payment',
      message: `Confirm ${e.fromName} paid ${wholeUnit && Number.isInteger(amount)
        ? formatWholeMoney(amount, { currency })
        : formatMoney(amount, { currency })} to ${e.toName}?`,
      yesLabel: e.mode === 'edit' ? 'Update' : 'Confirm',
      yesVariant: 'primary',
      yesId: 'payment-confirm',
      onYes: () => {
        setConfirm(null);
        if (e.mode === 'edit' && e.paymentId) {
          doEdit(e.paymentId, amount, e.originalAmount ?? e.initial, remark);
        }
        else doRecord(e.fromId, e.toId, amount, remark);
      },
    });
  };

  const askDelete = (payment: Payment) =>
    setConfirm({
      title: 'Remove this payment?',
      message: `This deletes "${nameOf(payment.from_member_id)} paid ${formatMoney(payment.amount, { currency })} to ${nameOf(payment.to_member_id)}" and re-opens that much of the balance.`,
      yesLabel: 'Remove',
      yesVariant: 'destructive',
      yesId: `payment-delete-${payment.id}`,
      onYes: () => { setConfirm(null); doDelete(payment.id); },
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

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <T variant="h1">Settle Up</T>
      <T muted>
        {wholeUnit
          ? 'Whole-rupee recommendations. Payments are rounded together so the group stays balanced.'
          : 'A deterministic payment plan calculated from the trip ledger.'}
      </T>
      {projection ? (
        <T variant="caption" muted>
          {projection.routing.optimal ? 'Minimum payment plan' : 'Simplified payment plan'}
          {' · '}Recommendations recalculate after every recorded payment, so the remaining recipient may change.
        </T>
      ) : null}

      {loadError ? (
        <EmptyState
          icon="alert"
          title="Settlement unavailable"
          body={loadError}
          ctaLabel="Try again"
          onCta={load}
          testID="settle-error"
        />
      ) : loading ? (
        <SkeletonCard count={3} />
      ) : recommendations.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title={projection?.status === 'settled_within_rounding' ? 'Settled within rounding' : 'All square!'}
          body={projection?.status === 'settled_within_rounding'
            ? (wholeUnit
              ? 'No whole-rupee payment remains. Small exact balances are kept and will carry into future expenses.'
              : 'No 0.01-unit payment remains. Small exact balances are kept and will carry into future expenses.')
            : 'No one owes anything on this trip.'}
          testID="settle-empty"
        />
      ) : (
        recommendations.map((transfer, index) => (
          <Card key={`${transfer.from_member_id}-${transfer.to_member_id}-${index}`} style={styles.card}>
            <View style={styles.cardTop}>
              <Parties from={transfer.from_member_id} to={transfer.to_member_id} />
              <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
                <AmountText
                  value={transfer.amount}
                  currency={currency}
                  whole={wholeUnit}
                  variant="money"
                  testID={`payable-${index}`}
                />
                {allow(transfer.to_member_id) ? (
                  <Button
                    label="Settle up"
                    size="sm"
                    loading={busy}
                    onPress={() => openRecord(transfer)}
                    testID={`settle-${index}`}
                  />
                ) : null}
              </View>
            </View>
          </Card>
        ))
      )}

      {projection?.enabled ? (
        <Card style={styles.detailsCard}>
          <T variant="h3">Whole-rupee recommendations</T>
          <T muted>
            Exact balances are kept for records and future expenses. Only the payment plan is rounded.
          </T>
          <Button
            label={showRounding ? 'Hide rounding details' : 'How rounding was applied'}
            variant="secondary"
            size="sm"
            onPress={() => setShowRounding((shown) => !shown)}
            testID="rounding-details-toggle"
          />
          {showRounding ? members.map((member) => (
            <View key={member.id} style={[styles.detailRow, { borderTopColor: colors.border }]}>
              <T variant="h4">{nameOf(member.id)}</T>
              <View style={styles.detailValues}>
                <T variant="caption" muted>Exact balance</T>
                <T variant="caption">{formatPreciseMoney(projection.precise_net[member.id], currency)}</T>
                <T variant="caption" muted>Rounded to pay/receive</T>
                <T variant="caption">{formatWholeMoney(
                  projection.rounded_net[member.id], { currency, signed: true },
                )}</T>
                <T variant="caption" muted>Rounding adjustment</T>
                <T variant="caption">{formatPreciseMoney(projection.rounding_adjustments[member.id], currency)}</T>
              </View>
            </View>
          )) : null}
        </Card>
      ) : null}

      {history.length > 0 ? (
        <View style={styles.historySection}>
          <T variant="h3">Payment history</T>
          <T muted>Recorded payments stay in chronological history even when the current plan reroutes.</T>
          {history.map((payment) => (
            <Card key={payment.id} style={styles.card}>
              <View style={styles.cardTop}>
                <Parties from={payment.from_member_id} to={payment.to_member_id} />
                <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
                  <T variant="caption" muted>{formatMoney(payment.amount, { currency })}</T>
                  <Badge label="Paid" color={colors.success} icon="check-circle" />
                </View>
              </View>
              <View style={[styles.log, { borderTopColor: colors.border }]}>
                <View style={styles.logRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T variant="caption" muted>{formatIST(payment.created_at)}</T>
                    {payment.note?.trim() ? (
                      <T variant="caption" muted numberOfLines={2}>{payment.note.trim()}</T>
                    ) : null}
                  </View>
                  {allow(payment.to_member_id) ? (
                    <View style={styles.logActions}>
                      <IconButton
                        name="pencil" size={16} variant="plain" accessibilityLabel="Edit payment"
                        onPress={() => openEdit(payment)} testID={`payment-edit-${payment.id}`}
                      />
                      <IconButton
                        name="trash" size={16} color={colors.danger} accessibilityLabel="Delete payment"
                        onPress={() => askDelete(payment)} testID={`payment-delete-btn-${payment.id}`}
                      />
                    </View>
                  ) : null}
                </View>
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {editor ? (
        <AmountModal
          title={editor.mode === 'edit' ? 'Edit payment' : 'Record payment'}
          subtitle={`${editor.fromName} pays ${editor.toName}`}
          initial={editor.initial}
          max={editor.max}
          currency={currency}
          wholeUnit={wholeUnit}
          allowLegacyDecimal={editor.mode === 'edit' && !Number.isInteger(editor.initial)}
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
  title, subtitle, initial, max, currency, initialNote, submitLabel, wholeUnit = false,
  allowLegacyDecimal = false, onCancel, onSubmit,
}: {
  title: string; subtitle: string; initial: number; max: number; currency: string;
  initialNote: string; submitLabel: string; wholeUnit?: boolean; allowLegacyDecimal?: boolean;
  onCancel: () => void;
  onSubmit: (amount: number, note: string) => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [amountStr, setAmountStr] = useState(String(wholeUnit ? initial : round2(initial)));
  const [noteStr, setNoteStr] = useState(initialNote);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const parsed = Number(amountStr);
    const unchangedLegacy = allowLegacyDecimal && parsed === initial;
    const amt = unchangedLegacy ? parsed : (wholeUnit ? parsed : round2(parsed));
    const v = validatePaymentAmount(amt, max, { wholeUnit: wholeUnit && !unchangedLegacy });
    if (!v.ok) { setError(v.error); return; }
    onSubmit(amt, noteStr);
  };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* Tap-outside-to-dismiss (kept). The KeyboardAvoidingView lifts the centered card above the
          keyboard so the pinned Cancel/Continue footer stays reachable; the body scrolls if it can't
          fit (small screens / keyboard open). */}
      <Pressable style={styles.scrim} onPress={onCancel}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[
            styles.modalKav,
            {
              paddingTop: insets.top + SPACING.lg,
              paddingBottom: insets.bottom + SPACING.lg,
              paddingLeft: insets.left + SPACING.lg,
              paddingRight: insets.right + SPACING.lg,
            },
          ]}
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
                keyboardType={wholeUnit ? 'number-pad' : 'decimal-pad'}
                inputMode={wholeUnit ? 'numeric' : 'decimal'}
                helper={wholeUnit
                  ? (allowLegacyDecimal && !Number.isInteger(initial)
                    ? `Keep the current decimal for a note-only edit, or enter a whole ${currency} amount up to ${formatWholeMoney(Math.floor(max), { currency })}`
                    : `Whole ${currency} amounts only · Max ${formatWholeMoney(Math.floor(max), { currency })}`)
                  : `Max ${formatMoney(max, { currency })}`}
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
            <View style={styles.modalFooter}>
              <View style={styles.modalAction}>
                <Button label="Cancel" variant="secondary" onPress={onCancel} fullWidth />
              </View>
              <View style={styles.modalAction}>
                <Button label={submitLabel} onPress={submit} fullWidth testID="payment-amount-continue" />
              </View>
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
  detailsCard: { gap: SPACING.sm, marginTop: SPACING.lg },
  detailRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: SPACING.sm,
    gap: SPACING.xs,
  },
  detailValues: { gap: 2 },
  historySection: { marginTop: SPACING.lg, gap: SPACING.sm },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  // KAV owns the centering + outer padding so `behavior:'padding'` can add keyboard-height inset
  // and slide the card up on iOS.
  modalKav: { flex: 1, justifyContent: 'center' },
  // maxHeight bounds the card so the body ScrollView can scroll; header + footer stay pinned.
  modalCard: { borderRadius: RADIUS.lg, borderWidth: 1, padding: SPACING.lg, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.xs },
  modalFooter: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  modalAction: { flex: 1 },
  // flexShrink lets the scroll area absorb overflow (keyboard open / small screen) while the
  // header and footer keep their natural height.
  modalBody: { flexGrow: 0, flexShrink: 1 },
  // Negative margins overlap the card padding so the 44px ✕ hit target aligns to the top-right
  // edge without growing the header (mirrors src/ui/Toast.tsx `close`).
  modalClose: { marginVertical: -SPACING.sm, marginRight: -SPACING.sm },
});
