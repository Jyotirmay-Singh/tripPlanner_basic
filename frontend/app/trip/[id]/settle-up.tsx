import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  View,
  StyleSheet,
  Modal,
  Pressable,
  Platform,
  ScrollView,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  deletePayment,
  editPayment,
  listPaymentAttempts,
  recordPayment,
  updatePaymentAttemptRecipient,
} from '../../../src/api';
import { loadTripReadBundle, type CompleteTrip, type ReadResult } from '../../../src/offlineReads';
import OfflineReadStatus from '../../../src/OfflineReadStatus';
import { offlineStore } from '../../../src/offlineStore';
import {
  capturePayment, listPendingPayments, makePaymentOutboxItem, paymentCaptureActive,
  type PendingPayment,
} from '../../../src/offlinePayments';
import { pendingStatusLabel, reviewReason } from '../../../src/offlineExpenses';
import { syncCoordinator } from '../../../src/syncWorker';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS } from '../../../src/theme';
import T from '../../../src/T';
import ConfirmModal from '../../../src/ConfirmModal';
import { memberDisplayNames } from '../../../src/displayNames';
import {
  canInitiateUpiPayment,
  canRecordPayment,
  canReviewUpiAttempt,
} from '../../../src/permissions';
import type { RoleTrip } from '../../../src/permissions';
import UpiPaymentSheet from '../../../src/UpiPaymentSheet';
import type { Transfer } from '../../../src/settlements';
import {
  activePaymentAttemptForDirection,
  validatePaymentAmount,
} from '../../../src/payments';
import type { Payment, PaymentAttempt, PaymentAttemptRecipientAction } from '../../../src/payments';
import {
  currentSuggestedAmount,
} from '../../../src/settlementProjection';
import type { BalanceResponse } from '../../../src/settlementProjection';
import { formatMoney } from '../../../src/format';
import { formatIST } from '../../../src/istTime';
import { currencyAmountPlaceholder } from '../../../src/currencies';
import {
  Screen, Card, Button, Icon, IconButton, Input, EmptyState, AmountText, SkeletonCard, useToast,
} from '../../../src/ui';
import { KeyboardAvoidingView } from '../../../src/KeyboardController';

type Member = {
  id: string;
  name: string;
  kind?: string;
  user_id?: string | null;
  family_member_user_ids?: (string | null)[];
};
type Balances = BalanceResponse<Member>;
type Trip = RoleTrip & { id: string; name: string; currency: string; members: Member[] };

const attemptStatusLabel = (status: PaymentAttempt['status']) => ({
  initiated: 'Waiting for payer',
  awaiting_confirmation: 'Confirmation requested',
  needs_review: 'Needs review',
  settled_recipient_confirmed: 'Recipient confirmed',
  canceled: 'Not paid',
  closed: 'Review closed',
  expired: 'Expired',
  voided: 'Payment removed',
}[status]);

function attemptExplanation(attempt: PaymentAttempt): string {
  switch (attempt.status) {
    case 'initiated':
      return 'The handoff was saved, but the payer has not reported a completed payment.';
    case 'awaiting_confirmation':
      return `The payer reported payment. ${attempt.selected_recipient_name_snapshot} must confirm receipt before the balance changes.`;
    case 'needs_review':
      return attempt.reason === 'no_current_payable'
        ? 'No current payable remained, so nothing was posted. A recipient or admin can retry or close this review.'
        : 'The payment was reported as not received. A recipient or admin can retry confirmation or close the review.';
    case 'settled_recipient_confirmed':
      return 'Receipt was confirmed and one linked payment was added to the ledger.';
    case 'canceled':
      return 'The payer canceled before reporting payment. No balance changed.';
    case 'closed':
      return 'The review was closed without posting to the ledger.';
    case 'expired':
      return 'The unresolved attempt expired after 24 hours. No balance changed.';
    case 'voided':
      return 'The linked ledger payment was removed; the confirmation audit remains.';
  }
}

export default function SettleUp() {
  const params = useLocalSearchParams<{
    id: string; paymentId?: string; settlementId?: string; paymentAttemptId?: string;
    reviewId?: string;
  }>();
  const {
    id,
    paymentId: notificationPaymentId,
    paymentAttemptId: notificationPaymentAttemptId,
    reviewId,
  } = params;
  const router = useRouter();
  const { user, sessionMode } = useAuth();
  const { colors } = useTheme();
  const toast = useToast();
  const [storedBal, setBal] = useState<Balances | null>(null);
  const [storedPayments, setPayments] = useState<Payment[] | null>(null);
  const [storedAttempts, setAttempts] = useState<PaymentAttempt[] | null>(null);
  const [storedTrip, setTrip] = useState<Trip | null>(null);
  const [storedRead, setRead] = useState<ReadResult<CompleteTrip<Trip, unknown, Balances, unknown, Payment>> | null>(null);
  const [storedPending, setStoredPending] = useState<{
    accountId: string; rows: PendingPayment[]; error: boolean;
  } | null>(null);
  const [storedPaymentProtocol, setStoredPaymentProtocol] = useState<{
    accountId: string; version: number;
  } | null>(null);
  const [readAccountId, setReadAccountId] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const modalAccountId = useRef(user?.id);
  const bal = readAccountId === user?.id ? storedBal : null;
  const payments = readAccountId === user?.id ? storedPayments : null;
  const attempts = readAccountId === user?.id ? storedAttempts : null;
  const trip = readAccountId === user?.id ? storedTrip : null;
  const read = readAccountId === user?.id ? storedRead : null;
  const pending = storedPending && storedPending.accountId === user?.id ? storedPending.rows : [];
  const pendingError = !!storedPending && storedPending.accountId === user?.id && storedPending.error;
  const paymentProtocolReady = !!storedPaymentProtocol && storedPaymentProtocol.accountId === user?.id
    && storedPaymentProtocol.version === 1;
  const [busy, setBusy] = useState(false);
  const [storedLoadError, setLoadError] = useState<string | null>(null);
  const loadError = readAccountId === user?.id ? storedLoadError : null;
  const [handoff, setHandoff] = useState<
    | null
    | {
        fromId: string;
        fromName: string;
        toId: string;
        toName: string;
        amount: number;
        attempt?: PaymentAttempt;
      }
  >(null);

  // The amount editor (record OR edit); when set, its Modal is mounted fresh.
  const [editor, setEditor] = useState<
    | null
    | { mode: 'record' | 'edit'; fromId: string; toId: string; fromName: string; toName: string;
        initial: number; max: number; paymentId?: string; note?: string; originalAmount?: number;
        amountLocked?: boolean; transfer?: Transfer; fetchedAt?: number;
        clientMutationId?: string; queuedAt?: number }
  >(null);
  // The shared themed guard-rail (native Alert renders no buttons on web).
  const [confirm, setConfirm] = useState<
    | null
    | { title: string; message?: string; yesLabel: string; yesVariant: 'primary' | 'destructive';
        onYes: () => void; yesId?: string }
  >(null);

  useEffect(() => {
    if (modalAccountId.current === user?.id) return;
    modalAccountId.current = user?.id;
    setEditor(null);
    setConfirm(null);
    setHandoff(null);
  }, [user?.id]);

  const load = useCallback(async () => {
    if (!user?.id || !id) return;
    const generation = ++loadGeneration.current;
    try {
      setLoadError(null);
      const [bundle, attemptResult, protocolVersion] = await Promise.all([
        loadTripReadBundle<Trip, unknown, Balances, unknown, Payment>(
          user.id, id, sessionMode === 'offline',
        ),
        sessionMode === 'offline' ? Promise.resolve({ data: null })
          : listPaymentAttempts(id).then((data) => ({ data })).catch(() => ({ data: null })),
        paymentCaptureActive() ? offlineStore.getPaymentProtocolVersion(user.id).catch(() => 0)
          : Promise.resolve(0),
      ]);
      const pendingResult = await listPendingPayments(user.id, id,
        bundle.data?.payments.map((payment) => payment.id) ?? [])
        .then((rows) => ({ rows, error: false }))
        .catch(() => ({ rows: [] as PendingPayment[], error: true }));
      if (generation !== loadGeneration.current) return;
      setReadAccountId(user.id);
      setStoredPending({ accountId: user.id, ...pendingResult });
      setStoredPaymentProtocol({ accountId: user.id, version: protocolVersion });
      setRead(bundle);
      setAttempts(attemptResult.data);
      if (bundle.data) {
        setBal(bundle.data.balances);
        setPayments(bundle.data.payments);
        setTrip(bundle.data.trip);
      } else {
        setBal(null); setPayments(null); setTrip(null);
        setLoadError(bundle.error || 'Settlement is temporarily unavailable.');
      }
    } catch (error: any) {
      if (generation === loadGeneration.current) {
        setReadAccountId(user.id);
        setLoadError(error?.message || 'Settlement is temporarily unavailable.');
        setBal(null); setPayments(null); setTrip(null);
      }
    }
  }, [id, user?.id, sessionMode]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]));

  useFocusEffect(useCallback(() => {
    if (!user?.id || !id) return () => {};
    return syncCoordinator.subscribe((event) => {
      if (event.accountId === user.id && event.tripId === id) void load();
    });
  }, [user?.id, id, load]));

  const members = bal?.members ?? [];
  const displayNames = memberDisplayNames(members);
  const nameOf = (mid: string) => displayNames[mid] || mid;
  const currency = bal?.currency ?? '';
  const loading = !bal || !payments || !trip;
  const offlineView = sessionMode === 'offline' || read?.source === 'cache';
  const queuedCaptureAvailable = paymentCaptureActive() && paymentProtocolReady
    && !!read?.data && !read.cacheError && !pendingError;
  const reviewItem = reviewId ? pending.find((item) => item.clientMutationId === reviewId) : null;
  const reviewReady = !reviewId || (reviewItem?.state === 'needs_review'
    && reviewItem.lastSafeErrorCode !== 'client_mutation_conflict');

  const recommendations = bal?.transfers ?? [];
  const history = [...(payments ?? [])].sort((a, b) =>
    (a.created_at || '') < (b.created_at || '') ? 1 : -1,
  );
  const attemptHistory = [...(attempts ?? [])].sort((a, b) =>
    (a.initiated_at || '') < (b.initiated_at || '') ? 1 : -1,
  );
  const projection = bal?.settlement_projection;
  const wholeUnit = true;

  const allow = (toId: string) => !!trip && !!reviewReady
    && (queuedCaptureAvailable || (!paymentCaptureActive() && !reviewId && !offlineView && !!attempts))
    && canRecordPayment(
    trip, toId, user?.id, members, user?.is_super_admin === true,
  );
  const canPayViaUpi = (fromId: string) => !offlineView && !!attempts && !!trip && canInitiateUpiPayment(
    trip, fromId, user?.id, members, user?.is_super_admin === true,
  );
  const canReviewUpi = (toId: string) => !offlineView && !!trip && canReviewUpiAttempt(
    trip, toId, user?.id, members, user?.is_super_admin === true,
  );

  // ---- Async mutations (only reached AFTER the ConfirmModal guard-rail) ----
  const doRecord = async (selected: Transfer, amount: number, note: string,
    preparedItem: PendingPayment | null, restoreEditor: () => void) => {
    if (!trip || !bal || !read || !user?.id) return;
    setBusy(true);
    try {
      if (preparedItem) {
        await capturePayment(preparedItem, reviewId);
        toast.show('Saved on this device. Pending sync.', 'success');
        if (reviewId) router.replace(`/trip/${id}/settle-up`);
        else await load();
      } else if (!paymentCaptureActive() && !offlineView && !reviewId && attempts) {
        await recordPayment(id, { from_member_id: selected.from_member_id,
          to_member_id: selected.to_member_id, amount, ...(note ? { note } : {}) });
        toast.show('Payment recorded', 'success');
        await load();
      } else {
        throw new Error('Connect and review this payment before recording it.');
      }
    } catch (e: any) {
      toast.show(e.message || 'Could not record payment', 'error');
      if (preparedItem) restoreEditor();
      else await load();
    } finally {
      setBusy(false);
    }
  };
  const doEdit = async (paymentId: string, amount: number, originalAmount: number, note?: string) => {
    if (offlineView || !attempts) return;
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
    if (offlineView || !attempts) return;
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

  const reviewAttempt = async (
    attempt: PaymentAttempt,
    action: PaymentAttemptRecipientAction,
  ) => {
    setBusy(true);
    try {
      const updated = await updatePaymentAttemptRecipient(id, attempt.id, action);
      const messages: Record<PaymentAttemptRecipientAction, string> = {
        confirm_received: updated.status === 'settled_recipient_confirmed'
          ? 'UPI payment confirmed and recorded'
          : 'Payment moved to review',
        report_not_received: 'Payment marked for review',
        close_review: 'Payment review closed',
      };
      toast.show(messages[action], 'success');
    } catch (error: any) {
      toast.show(error?.message || 'Could not update the UPI payment', 'error');
    } finally {
      await load();
      setBusy(false);
    }
  };

  // ---- Flows: editor -> guard-rail -> mutation ----
  const openRecord = (transfer: Transfer) =>
    setEditor({
      mode: 'record', fromId: transfer.from_member_id, toId: transfer.to_member_id,
      fromName: nameOf(transfer.from_member_id), toName: nameOf(transfer.to_member_id),
      initial: reviewItem ? Number(reviewItem.payload.amount) : transfer.amount,
      max: transfer.amount, note: reviewItem?.payload.note,
      transfer: { ...transfer }, fetchedAt: read?.fetchedAt ?? Date.now(),
    });

  const openUpiHandoff = (transfer: Transfer) => setHandoff({
    fromId: transfer.from_member_id,
    fromName: nameOf(transfer.from_member_id),
    toId: transfer.to_member_id,
    toName: nameOf(transfer.to_member_id),
    amount: transfer.amount,
  });

  const resumeUpiAttempt = (attempt: PaymentAttempt) => setHandoff({
    fromId: attempt.from_member_id,
    fromName: attempt.from_name_snapshot || nameOf(attempt.from_member_id),
    toId: attempt.to_member_id,
    toName: attempt.to_name_snapshot || nameOf(attempt.to_member_id),
    amount: Number(attempt.source_amount),
    attempt,
  });

  const openEdit = (payment: Payment) =>
    setEditor({
      mode: 'edit', fromId: payment.from_member_id, toId: payment.to_member_id,
      fromName: nameOf(payment.from_member_id), toName: nameOf(payment.to_member_id),
      // Cap on edit = current residual + this payment's own effect (mirrors the backend).
      initial: payment.amount,
      max: currentSuggestedAmount(
        recommendations, payment.from_member_id, payment.to_member_id,
      ) + payment.amount,
      paymentId: payment.id,
      note: payment.note ?? '',
      originalAmount: payment.amount,
      amountLocked: payment.source === 'upi_recipient_confirmed',
    });

  const onEditorSubmit = (amount: number, note: string) => {
    const e = editor;
    if (!e) return;
    const remark = note.trim();
    let preparedItem: PendingPayment | null = null;
    if (e.mode === 'record' && paymentCaptureActive() && !queuedCaptureAvailable) {
      toast.show('Payment sync is unavailable. Keep this form and reconnect to review the suggestion.', 'error');
      return;
    }
    if (e.mode === 'record' && queuedCaptureAvailable && e.transfer && trip && bal && user?.id) {
      try {
        preparedItem = makePaymentOutboxItem(user.id, trip, bal, e.transfer, amount, remark,
          e.fetchedAt ?? Date.now(), e.clientMutationId, e.queuedAt,
          user.is_super_admin === true);
      } catch (error: any) {
        toast.show(error?.message || 'This payment suggestion changed. Review it again.', 'error');
        return;
      }
    }
    setEditor(null);
    setConfirm({
      title: e.mode === 'edit'
        ? (e.amountLocked ? 'Update payment remark?' : 'Update payment?')
        : 'Confirm payment',
      message: e.amountLocked
        ? `Update the remark for ${e.fromName}’s recipient-confirmed UPI payment to ${e.toName}? The amount stays ${formatMoney(e.initial, { currency })}.`
        : preparedItem && e.mode === 'record'
          ? `Confirm ${e.fromName} already paid ${formatMoney(amount, { currency })} to ${e.toName}? This uses a last-confirmed suggestion and will stay pending until the server checks it. Confirmed balances stay unchanged until then.`
          : `Confirm ${e.fromName} paid ${formatMoney(amount, { currency })} to ${e.toName}?`,
      yesLabel: e.mode === 'edit' ? 'Update' : preparedItem ? 'Save pending record' : 'Confirm',
      yesVariant: 'primary',
      yesId: 'payment-confirm',
      onYes: () => {
        setConfirm(null);
        if (e.mode === 'edit' && e.paymentId) {
          doEdit(e.paymentId, amount, e.originalAmount ?? e.initial, remark);
        }
        else if (e.transfer) doRecord(e.transfer, amount, remark, preparedItem,
          () => setEditor({ ...e, initial: amount, note: remark,
            clientMutationId: preparedItem?.clientMutationId,
            queuedAt: preparedItem?.queuedAt }));
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
        A deterministic whole-unit payment plan calculated from the trip ledger.
      </T>
      {read ? <OfflineReadStatus result={read} /> : null}
      {offlineView ? (
        <T variant="caption" muted testID="settle-offline-note">
          {queuedCaptureAvailable
            ? 'These are the last server-confirmed balances and payments. You can save a manual record of money already exchanged. It will be pending until the server checks it.'
            : 'These are the last server-confirmed balances and payments. Connect to record or change a payment.'}
        </T>
      ) : null}
      {reviewId ? <T variant="caption" color={colors.warning} testID="payment-review-banner">
        {reviewReady
          ? 'Choose the suggested pair and confirm the amount and receiver to replace the pending record. Nothing changes automatically.'
          : 'This pending payment is no longer available for editing. Open its review to check the latest state.'}
      </T> : null}
      {pendingError ? <T variant="caption" color={colors.warning} testID="payment-pending-error">
        Pending payment records could not be read on this device.
      </T> : null}
      {!attempts && !loading && !loadError ? (
        <T variant="caption" muted testID="upi-attempts-unavailable">
          UPI payment activity and UPI actions are unavailable until you reconnect.
        </T>
      ) : null}
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
          title="All square!"
          body="No one owes anything on this trip."
          testID="settle-empty"
        />
      ) : (
        recommendations.map((transfer, index) => {
          const activeAttempt = activePaymentAttemptForDirection(
            attempts, transfer.from_member_id, transfer.to_member_id,
          );
          return (
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
                <View style={styles.recommendationActions}>
                  {canPayViaUpi(transfer.from_member_id) ? (
                    <Button
                      label={activeAttempt ? 'UPI pending' : 'Pay via UPI'}
                      size="sm"
                      icon="wallet"
                      onPress={() => openUpiHandoff(transfer)}
                      disabled={!!activeAttempt}
                      accessibilityLabel={activeAttempt
                        ? 'UPI payment already pending for this payer and recipient'
                        : 'Pay via UPI'}
                      testID={`upi-pay-${index}`}
                    />
                  ) : null}
                  {allow(transfer.to_member_id) ? (
                    <Button
                      label="Record payment"
                      variant={canPayViaUpi(transfer.from_member_id) ? 'secondary' : 'primary'}
                      size="sm"
                      loading={busy}
                      onPress={() => openRecord(transfer)}
                      testID={`record-payment-${index}`}
                    />
                  ) : null}
                </View>
              </View>
            </View>
          </Card>
          );
        })
      )}

      {attemptHistory.length > 0 ? (
        <View style={styles.attemptSection} testID="upi-attempts-section">
          <T variant="h3">UPI payment activity</T>
          <T muted>
            A payer report does not change balances until the recipient confirms receipt.
          </T>
          {attemptHistory.map((attempt) => {
            const sender = attempt.initiating_payer_user_id === user?.id;
            const reviewer = canReviewUpi(attempt.to_member_id);
            const settled = attempt.status === 'settled_recipient_confirmed';
            const statusColor = settled
              ? colors.success
              : attempt.status === 'needs_review'
                ? colors.warning
                : attempt.status === 'canceled' || attempt.status === 'closed'
                  || attempt.status === 'expired' || attempt.status === 'voided'
                  ? colors.textMuted
                  : colors.primary;
            return (
              <Card
                key={attempt.id}
                testID={`payment-attempt-${attempt.id}`}
                style={[
                  styles.card,
                  attempt.id === notificationPaymentAttemptId
                    ? { borderColor: colors.primary, borderWidth: 2 }
                    : undefined,
                ]}
              >
                <View style={styles.attemptHeader}>
                  <View style={styles.flex}>
                    <T variant="h4">
                      {attempt.from_name_snapshot || nameOf(attempt.from_member_id)} pays{' '}
                      {attempt.to_name_snapshot || nameOf(attempt.to_member_id)}
                    </T>
                    <T variant="caption" muted>{formatIST(attempt.updated_at)}</T>
                  </View>
                  <Badge
                    label={attemptStatusLabel(attempt.status)}
                    color={statusColor}
                    icon={settled ? 'check-circle' : 'clock'}
                  />
                </View>
                <View style={styles.attemptAmounts}>
                  <View style={styles.flex}>
                    <T variant="caption" muted>Reported outside Trip Splitter</T>
                    <T variant="h4">INR {attempt.inr_amount}</T>
                  </View>
                  {attempt.posted_amount != null ? (
                    <View style={styles.flex}>
                      <T variant="caption" muted>Posted at confirmation</T>
                      <T variant="h4">
                        {formatMoney(attempt.posted_amount, {
                          currency: attempt.posted_currency || currency,
                        })}
                      </T>
                    </View>
                  ) : null}
                </View>
                <T muted>{attemptExplanation(attempt)}</T>
                {attempt.transaction_reference ? (
                  <T variant="caption" muted testID={`payment-attempt-reference-${attempt.id}`}>
                    Payer-entered reference: {attempt.transaction_reference} (not bank verified)
                  </T>
                ) : null}
                {attempt.posted_amount != null
                  && Number(attempt.source_amount) !== attempt.posted_amount ? (
                    <T variant="caption" color={colors.warning} testID={`payment-attempt-capped-${attempt.id}`}>
                      The ledger amount was capped to the remaining payable; the original INR amount
                      and confirmation audit are unchanged.
                    </T>
                  ) : null}
                {attempt.status === 'initiated' && sender ? (
                  <Button
                    label="Resume payment"
                    variant="secondary"
                    size="sm"
                    onPress={() => resumeUpiAttempt(attempt)}
                    accessibilityLabel="Resume UPI payment and report paid or not paid"
                    testID={`payment-attempt-resume-${attempt.id}`}
                  />
                ) : null}
                {attempt.status === 'awaiting_confirmation' && reviewer ? (
                  <View style={styles.attemptActions}>
                    <Button
                      label="Confirm received"
                      size="sm"
                      loading={busy}
                      disabled={busy}
                      onPress={() => { void reviewAttempt(attempt, 'confirm_received'); }}
                      testID={`payment-attempt-confirm-${attempt.id}`}
                    />
                    <Button
                      label="Not received"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onPress={() => { void reviewAttempt(attempt, 'report_not_received'); }}
                      testID={`payment-attempt-not-received-${attempt.id}`}
                    />
                  </View>
                ) : null}
                {attempt.status === 'needs_review' && reviewer ? (
                  <View style={styles.attemptActions}>
                    <Button
                      label="Retry confirmation"
                      size="sm"
                      loading={busy}
                      disabled={busy}
                      onPress={() => { void reviewAttempt(attempt, 'confirm_received'); }}
                      testID={`payment-attempt-retry-${attempt.id}`}
                    />
                    <Button
                      label="Close review"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onPress={() => { void reviewAttempt(attempt, 'close_review'); }}
                      testID={`payment-attempt-close-${attempt.id}`}
                    />
                  </View>
                ) : null}
              </Card>
            );
          })}
        </View>
      ) : null}

      {pending.length > 0 || history.length > 0 ? (
        <View style={styles.historySection}>
          <T variant="h3">Payment history</T>
          <T muted>Pending records are saved on this device. Confirmed payments stay in history even when the current plan reroutes.</T>
          {pending.map((item) => (
            <Card key={item.clientMutationId}
              testID={`payment-pending-${item.clientMutationId}`}
              accessibilityLabel={`Manual payment ${pendingStatusLabel(item)}`} style={styles.card}>
              <View style={styles.cardTop}>
                <Parties from={item.payload.from_member_id} to={item.payload.to_member_id} />
                <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
                  <T variant="caption" muted>{formatMoney(item.payload.amount, { currency: item.payload.expected_currency })}</T>
                  <Badge label={pendingStatusLabel(item)} color={colors.warning} icon="clock" />
                </View>
              </View>
              <T variant="caption" muted>Saved on device: {formatIST(new Date(item.queuedAt).toISOString())}</T>
              {item.payload.note ? <T variant="caption" muted numberOfLines={2}>{item.payload.note}</T> : null}
              {item.lastSafeErrorCode ? <T variant="caption" muted>{reviewReason(item.lastSafeErrorCode)}</T> : null}
              <T variant="caption" muted>Confirmed balances and recommendations do not include this record yet.</T>
              <Button label="Review pending payment" variant="secondary"
                onPress={() => router.push(`/trip/${id}/pending-payment?mutationId=${encodeURIComponent(item.clientMutationId)}`)}
                testID={`payment-review-${item.clientMutationId}`} />
            </Card>
          ))}
          {history.map((payment) => (
            <Card
              key={payment.id}
              testID={`payment-history-${payment.id}`}
              style={[
                styles.card,
                payment.id === notificationPaymentId
                  ? { borderColor: colors.primary, borderWidth: 2 }
                  : undefined,
              ]}
            >
              <View style={styles.cardTop}>
                <Parties from={payment.from_member_id} to={payment.to_member_id} />
                <View style={{ alignItems: 'flex-end', gap: SPACING.sm }}>
                  <T variant="caption" muted>{formatMoney(payment.amount, { currency })}</T>
                  <Badge
                    label={payment.source === 'upi_recipient_confirmed'
                      ? 'UPI — recipient confirmed'
                      : 'Paid'}
                    color={colors.success}
                    icon="check-circle"
                  />
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

      {editor && readAccountId === user?.id ? (
        <AmountModal
          title={editor.mode === 'edit'
            ? (editor.amountLocked ? 'Edit payment remark' : 'Edit payment')
            : 'Record payment'}
          subtitle={`${editor.fromName} pays ${editor.toName}`}
          initial={editor.initial}
          max={editor.max}
          currency={currency}
          amountLocked={editor.amountLocked}
          initialNote={editor.note ?? ''}
          submitLabel={editor.mode === 'edit' ? 'Continue' : 'Continue'}
          onCancel={() => setEditor(null)}
          onSubmit={onEditorSubmit}
        />
      ) : null}

      {handoff && trip && readAccountId === user?.id ? (
        <UpiPaymentSheet
          visible
          tripId={id}
          tripName={trip.name}
          fromMemberId={handoff.fromId}
          fromName={handoff.fromName}
          toMemberId={handoff.toId}
          toName={handoff.toName}
          initialAmount={handoff.amount}
          currency={currency}
          wholeUnit={wholeUnit}
          initialAttempt={handoff.attempt ?? null}
          onAttemptChanged={async () => { await load(); }}
          onClose={() => {
            setHandoff(null);
            void load();
          }}
        />
      ) : null}

      <ConfirmModal
        visible={!!confirm && readAccountId === user?.id}
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
  title, subtitle, initial, max, currency, initialNote, submitLabel,
  amountLocked = false, onCancel, onSubmit,
}: {
  title: string; subtitle: string; initial: number; max: number; currency: string;
  initialNote: string; submitLabel: string;
  /** Deprecated compatibility props; whole-unit input is now application-wide. */
  wholeUnit?: boolean; allowLegacyDecimal?: boolean;
  amountLocked?: boolean;
  onCancel: () => void;
  onSubmit: (amount: number, note: string) => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [amountStr, setAmountStr] = useState(String(initial));
  const [noteStr, setNoteStr] = useState(initialNote);
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef<TextInput>(null);

  const submit = () => {
    if (amountLocked) {
      onSubmit(initial, noteStr);
      return;
    }
    const parsed = Number(amountStr);
    const amt = parsed;
    const v = validatePaymentAmount(amt, max, {
      wholeUnit: true,
      currency,
      rawAmount: amountStr,
    });
    if (!v.ok) {
      const message = v.error || 'Enter a valid amount';
      setError(message);
      requestAnimationFrame(() => {
        amountRef.current?.focus();
        AccessibilityInfo.announceForAccessibility(message);
      });
      return;
    }
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
          behavior="padding"
          automaticOffset
          testID="payment-keyboard-view"
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
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: SPACING.xs }}
            >
              <T muted>{subtitle}</T>
              {amountLocked ? (
                <Card variant="muted" style={styles.lockedAmount} testID="payment-locked-amount">
                  <T variant="label" muted>Recipient-confirmed amount</T>
                  <AmountText value={initial} currency={currency} variant="money" />
                  <T variant="caption" muted>
                    This confirmed amount is part of the UPI audit and cannot be changed.
                  </T>
                </Card>
              ) : (
                <Input
                  ref={amountRef}
                  label={`Amount (${currency})`}
                  value={amountStr}
                  onChangeText={(t) => { setAmountStr(t); if (error) setError(null); }}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  placeholder={currencyAmountPlaceholder(currency)}
                  helper={`Whole ${currency} amounts only · Max ${formatMoney(max, { currency })}`}
                  error={error}
                  autoFocus
                  returnKeyType="next"
                  containerStyle={{ marginTop: SPACING.md }}
                  testID="payment-amount-input"
                />
              )}
              <Input
                label="Remark (optional)"
                value={noteStr}
                onChangeText={setNoteStr}
                placeholder="Made the payment on Gpay app."
                multiline
                autoFocus={amountLocked}
                submitBehavior="newline"
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
                <Button
                  label={submitLabel}
                  onPress={submit}
                  fullWidth
                  testID={amountLocked ? 'payment-remark-continue' : 'payment-amount-continue'}
                />
              </View>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
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
  recommendationActions: { alignItems: 'flex-end', gap: SPACING.sm },
  attemptSection: { marginTop: SPACING.lg, gap: SPACING.sm },
  attemptHeader: {
    flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm,
  },
  attemptAmounts: {
    flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md,
  },
  attemptActions: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm,
  },
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
  lockedAmount: { gap: SPACING.xs, marginTop: SPACING.md },
  // Negative margins overlap the card padding so the 44px ✕ hit target aligns to the top-right
  // edge without growing the header (mirrors src/ui/Toast.tsx `close`).
  modalClose: { marginVertical: -SPACING.sm, marginRight: -SPACING.sm },
});
