import CategoryBadge from '../../../src/ui/CategoryBadge';
import React, { useCallback, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { offlineStore } from '../../../src/offlineStore';
import { captureExpense, expenseCaptureActive, pendingStatusLabel, reviewReason,
  type PendingExpense } from '../../../src/offlineExpenses';
import { approvedForeignExpense, conversionQuoteFromItem,
  quoteMatchesExpense } from '../../../src/offlineConversion';
import { syncCoordinator } from '../../../src/syncWorker';
import { pendingDisplay, pendingMemberName, pendingPayload, type DisplayTrip } from '../../../src/pendingDisplay';
import { formatMoney } from '../../../src/format';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import { Screen, Card, Button, EmptyState, useToast } from '../../../src/ui';
import ConfirmModal from '../../../src/ConfirmModal';
import T from '../../../src/T';

export default function PendingExpenseDetail() {
  const { id, mutationId } = useLocalSearchParams<{ id: string; mutationId: string }>();
  const { user, sessionMode } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [stored, setStored] = useState<{ accountId: string; item: PendingExpense | null;
    trip?: DisplayTrip } | null>(null);
  const item = stored?.accountId === user?.id && stored?.item?.tripId === id
    && stored?.item?.clientMutationId === mutationId ? stored.item : null;
  const trip = stored?.accountId === user?.id ? stored?.trip : undefined;
  const generation = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmBudget, setConfirmBudget] = useState(false);

  const load = useCallback(async () => {
    if (!user?.id || !id || !mutationId) return;
    const current = ++generation.current;
    try {
      const [rows, snapshot] = await Promise.all([offlineStore.listOutbox(user.id),
        offlineStore.getTripSnapshot(user.id, id).catch(() => null)]);
      if (current !== generation.current) return;
      const found = rows.find((row) => row.clientMutationId === mutationId
        && row.accountId === user.id && row.tripId === id
        && row.operation === 'expense_create' && row.state !== 'synced');
      setStored({ accountId: user.id, item: found as PendingExpense | undefined ?? null,
        trip: snapshot?.payload as DisplayTrip | undefined });
      setReadError(false);
    } catch { if (current === generation.current) setReadError(true); }
    finally { if (current === generation.current) setLoaded(true); }
  }, [user?.id, id, mutationId]);
  useFocusEffect(useCallback(() => {
    setLoaded(false);
    setConfirmDiscard(false);
    setConfirmBudget(false);
    void load();
    return () => { generation.current += 1; };
  }, [load]));

  useFocusEffect(useCallback(() => {
    if (user?.id && sessionMode === 'online' && mutationId) {
      syncCoordinator.wake(user.id);
    }
  }, [user?.id, sessionMode, mutationId]));

  useFocusEffect(useCallback(() => {
    if (!user?.id || !id || !mutationId) return () => {};
    return syncCoordinator.subscribe((event) => {
      if (event.accountId !== user.id || event.mutationId !== mutationId) return;
      void load();
    });
  }, [user?.id, id, mutationId, load]));

  const retry = async () => {
    if (!user?.id || !item || actionBusy) return;
    setActionBusy(true);
    try {
      if (item.state === 'awaiting_reconcile') syncCoordinator.wake(user.id, item.clientMutationId);
      else await syncCoordinator.retry(user.id, item.clientMutationId);
    } catch {
      toast.show('Could not schedule a retry. This transaction remains saved.', 'error');
    } finally { setActionBusy(false); }
  };

  const approveBudget = async () => {
    if (!user?.id || !item || actionBusy || sessionMode !== 'online') return;
    setConfirmBudget(false);
    setActionBusy(true);
    try {
      if (!await syncCoordinator.approveBudget(user.id, item.clientMutationId)) {
        throw new Error('Budget review is no longer available');
      }
    } catch {
      toast.show('Could not save budget approval. The pending transaction remains unchanged.', 'error');
    } finally { setActionBusy(false); }
  };

  const approveConversion = async () => {
    if (!user?.id || !item || actionBusy || sessionMode !== 'online') return;
    const quote = conversionQuoteFromItem(item);
    if (!quote || !quoteMatchesExpense(item, quote)) {
      toast.show('This quote expired. Request a current quote before approving.', 'error');
      syncCoordinator.wake(user.id, item.clientMutationId);
      return;
    }
    setActionBusy(true);
    try {
      const approved = approvedForeignExpense(item, quote);
      await captureExpense(approved as PendingExpense, item.clientMutationId);
      router.back();
    } catch {
      toast.show('Could not save conversion approval. The original expense remains pending.', 'error');
    } finally { setActionBusy(false); }
  };

  const discard = async () => {
    if (!user?.id || !item || discarding) return;
    setDiscarding(true);
    try {
      await offlineStore.discardReviewExpense(user.id, item.clientMutationId);
      setConfirmDiscard(false);
      router.back();
    } catch {
      toast.show('Could not discard this pending expense. It remains saved on this device.', 'error');
    } finally { setDiscarding(false); }
  };

  if (!loaded) return <Screen><T>Loading pending transaction…</T></Screen>;
  if (readError || !item) return <Screen><EmptyState icon="alert"
    title="Pending expense unavailable"
    body={readError ? 'Saved transactions could not be read on this device.'
      : 'This pending expense is no longer here.'} /></Screen>;

  const payload = pendingPayload(item);
  const display = pendingDisplay(item, trip);
  const nameOf = (memberId: string) => pendingMemberName(item, memberId, trip);
  const currency = String(payload.original_currency ?? payload.currency ?? trip?.currency ?? '');
  const exact = payload.original_custom_amounts ?? payload.custom_amounts;
  const exactRows = exact && typeof exact === 'object'
    ? Object.entries(exact as Record<string, number>) : [];
  const conversionReview = item.lastSafeErrorCode === 'conversion_review_needed';
  const quote = conversionReview ? conversionQuoteFromItem(item) : null;
  const quoteCurrent = conversionReview && quoteMatchesExpense(item, quote);
  const quoteError = (item.reviewContext as { quoteError?: string } | null)?.quoteError;
  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, alignItems: 'center' }}>
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
          <Card>
            <T variant="h3">{display.identity}</T>
            <T variant="caption" muted>{display.tripName}</T>
            <T variant="caption" color={colors.warning} testID="pending-detail-status">
              {pendingStatusLabel(item)}
            </T>
            <T>{display.amount}</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><CategoryBadge name={String(payload.category)} /><T style={{ flex: 1 }}>{String(payload.category)}</T></View>
            <T variant="caption" muted>{String(payload.date)}</T>
            <T variant="caption" muted>Paid by {nameOf(String(payload.paid_by_member_id))}</T>
            <T variant="caption" muted>Split: {String(payload.split_mode).replace('_', ' ').toLowerCase()}</T>
            <T variant="caption" muted>
              Participants: {Array.isArray(payload.split_member_ids)
                ? payload.split_member_ids.map((memberId) => nameOf(String(memberId))).join(', ')
                : 'Participants unavailable'}
            </T>
            {exactRows.length ? <T variant="caption" muted>
              Exact amounts: {exactRows.map(([memberId, value]) =>
                `${nameOf(memberId)} ${formatMoney(value, { currency, currencyDisplay: 'code' })}`).join(', ')}
            </T> : null}
            <T variant="caption" muted>Confirmed totals update after sync.</T>
          </Card>
          {item.lastSafeErrorCode && item.state !== 'needs_review' ? <Card>
            <T variant="caption" muted>{reviewReason(item.lastSafeErrorCode)}</T>
          </Card> : null}
          {item.state === 'needs_review' ? (
            <Card>
              <T variant="h4" color={colors.warning}>
                {conversionReview ? 'Currency conversion' : 'Review needed'}
              </T>
              {!conversionReview ? <T variant="caption" muted>
                {typeof (item.reviewContext as { warning?: unknown } | null)?.warning === 'string'
                  ? String((item.reviewContext as { warning: string }).warning)
                  : reviewReason(item.lastSafeErrorCode)}
              </T> : null}
              {conversionReview ? (
                <View style={{ gap: SPACING.xs }} testID="pending-conversion-review">
                  {quoteCurrent && quote ? <>
                    <T variant="label">
                      {formatMoney(Number(quote.source_amount), { currency: quote.source_currency,
                        currencyDisplay: 'code' })}
                      {' ≈ '}
                      {formatMoney(Number(quote.target_amount), { currency: quote.target_currency,
                        currencyDisplay: 'code' })}
                    </T>
                    <T variant="caption" muted>
                      1 {quote.source_currency} = {quote.rate} {quote.target_currency}
                      {' · Reference date '}{quote.effective_rate_date || quote.requested_date}
                    </T>
                    {quote.stale ? <T variant="caption" color={colors.warning}>
                      This quote uses an older cached rate.
                    </T> : null}
                    <T variant="caption" muted>Approve this rate to sync.</T>
                  </> : <T variant="caption" muted testID="pending-conversion-wait">
                    {quote ? 'The previous quote expired. Request a current quote.'
                      : quoteError === 'multi_currency_disabled'
                        ? 'Conversion is unavailable right now. Your original amount is saved.'
                        : quoteError === 'quote_unavailable'
                          ? 'Conversion rate unavailable. Try again later; your amount is saved.'
                          : 'Getting a conversion quote. Your original amount is saved.'}
                  </T>}
                </View>
              ) : null}
              {!expenseCaptureActive() ? <T variant="caption" muted>
                Editing pending expenses is temporarily unavailable.
              </T> : null}
              <View style={{ gap: SPACING.sm, marginTop: SPACING.sm }}>
                {conversionReview ? <>
                  {quoteCurrent ? <Button label="Use this conversion" fullWidth accessibilityLabel={display.actionLabel('Use this conversion')}
                    disabled={!expenseCaptureActive() || sessionMode !== 'online' || actionBusy}
                    onPress={() => { void approveConversion(); }} testID="pending-conversion-approve" /> : null}
                  <Button fullWidth accessibilityLabel={display.actionLabel(quoteCurrent ? 'Refresh conversion quote' : 'Get conversion quote')} label={quoteCurrent ? 'Refresh conversion quote' : 'Get conversion quote'}
                    variant={quoteCurrent ? 'secondary' : 'primary'}
                    disabled={!expenseCaptureActive() || sessionMode !== 'online' || actionBusy}
                    onPress={() => { if (user?.id) syncCoordinator.wake(user.id, item.clientMutationId); }}
                    testID="pending-conversion-refresh" />
                </> : item.lastSafeErrorCode === 'budget_confirmation_required' ? (
                  <Button label="Review and approve budget overage" fullWidth accessibilityLabel={display.actionLabel('Review and approve budget overage')}
                    disabled={!expenseCaptureActive() || sessionMode !== 'online' || actionBusy}
                    onPress={() => setConfirmBudget(true)} testID="pending-budget-approve" />
                ) : item.lastSafeErrorCode !== 'invalid_write'
                  && item.lastSafeErrorCode !== 'invalid_local_payload'
                  && item.lastSafeErrorCode !== 'client_mutation_conflict' ? (
                  <Button label="Retry same transaction" fullWidth accessibilityLabel={display.actionLabel('Retry same transaction')} disabled={!expenseCaptureActive() || actionBusy}
                    onPress={() => { void retry(); }} testID="pending-retry" />
                ) : null}
                <Button label="Edit and requeue" fullWidth accessibilityLabel={display.actionLabel('Edit and requeue')} variant="secondary" disabled={!expenseCaptureActive()
                  || item.lastSafeErrorCode === 'client_mutation_conflict'}
                  onPress={() => router.push({ pathname: '/trip/[id]/add-expense',
                    params: { id, reviewId: item.clientMutationId } })} testID="pending-edit" />
                <Button label="Discard pending expense" fullWidth accessibilityLabel={display.actionLabel('Discard pending expense')} variant="secondary"
                  onPress={() => setConfirmDiscard(true)} testID="pending-discard" />
              </View>
            </Card>
          ) : null}
          {(item.state === 'queued' || item.state === 'awaiting_reconcile') ? (
            <Button label="Retry sync" fullWidth accessibilityLabel={display.actionLabel('Retry sync')} disabled={!expenseCaptureActive() || actionBusy}
              onPress={() => { void retry(); }} testID="pending-retry" />
          ) : null}
        </View>
      </ScrollView>
      <ConfirmModal visible={confirmDiscard} title="Discard pending expense?"
        message="This removes the saved pending expense from this device. Confirmed group records are unchanged."
        onRequestClose={() => setConfirmDiscard(false)} actions={[
          { label: 'Keep', variant: 'cancel', onPress: () => setConfirmDiscard(false) },
          { label: 'Discard', variant: 'destructive', onPress: () => { void discard(); } },
        ]} />
      <ConfirmModal visible={confirmBudget} title="Approve budget overage?"
        message={typeof (item.reviewContext as { warning?: unknown } | null)?.warning === 'string'
          ? String((item.reviewContext as { warning: string }).warning)
          : 'This transaction exceeds the group budget. Save it anyway?'}
        onRequestClose={() => setConfirmBudget(false)} actions={[
          { label: 'Keep for review', variant: 'cancel', onPress: () => setConfirmBudget(false) },
          { label: 'Save anyway', variant: 'primary', onPress: () => { void approveBudget(); } },
        ]} />
    </Screen>
  );
}
