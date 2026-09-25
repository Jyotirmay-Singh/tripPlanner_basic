import React, { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { offlineStore } from '../../../src/offlineStore';
import { expenseCaptureActive, pendingStatusLabel, reviewReason, type PendingExpense } from '../../../src/offlineExpenses';
import { syncCoordinator } from '../../../src/syncWorker';
import { familyMemberIds } from '../../../src/familyParticipation';
import { formatMoney } from '../../../src/format';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import { Screen, Card, Button, EmptyState, useToast } from '../../../src/ui';
import ConfirmModal from '../../../src/ConfirmModal';
import T from '../../../src/T';

type SavedTrip = { members?: { id: string; name: string; kind: string;
  family_members: string[]; family_member_ids?: string[] }[] };

export default function PendingExpenseDetail() {
  const { id, mutationId } = useLocalSearchParams<{ id: string; mutationId: string }>();
  const { user, sessionMode } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [item, setItem] = useState<PendingExpense | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmBudget, setConfirmBudget] = useState(false);

  useFocusEffect(useCallback(() => {
    if (!user?.id || !id || !mutationId) return;
    let active = true;
    setLoaded(false);
    Promise.all([offlineStore.listOutbox(user.id), offlineStore.getTripSnapshot(user.id, id)])
      .then(([rows, snapshot]) => {
        if (!active) return;
        const found = rows.find((row) => row.clientMutationId === mutationId
          && row.tripId === id && row.operation === 'expense_create' && row.state !== 'synced');
        setItem(found as PendingExpense | undefined ?? null);
        const trip = snapshot?.payload as SavedTrip | undefined;
        const rosterNames: Record<string, string> = {};
        for (const member of trip?.members ?? []) {
          rosterNames[member.id] = member.name;
          if (member.kind === 'family') {
            familyMemberIds(member).forEach((personId, index) => {
              rosterNames[personId] = member.family_members[index] ?? personId;
            });
          }
        }
        setNames(rosterNames);
        setReadError(false);
      })
      .catch(() => { if (active) setReadError(true); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [user?.id, id, mutationId]));

  useFocusEffect(useCallback(() => {
    if (!user?.id || !id || !mutationId) return () => {};
    return syncCoordinator.subscribe((event) => {
      if (event.accountId !== user.id || event.mutationId !== mutationId) return;
      void offlineStore.listOutbox(user.id).then((rows) => {
        setItem(rows.find((row) => row.clientMutationId === mutationId && row.tripId === id
          && row.state !== 'synced') as PendingExpense | undefined ?? null);
      }).catch(() => setReadError(true));
    });
  }, [user?.id, id, mutationId]));

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

  const payload = item.payload;
  const amount = Number(payload.amount ?? payload.original_amount ?? 0);
  const currency = String(payload.currency ?? payload.original_currency ?? '');
  const exact = payload.custom_amounts ?? payload.original_custom_amounts;
  const exactRows = exact && typeof exact === 'object'
    ? Object.entries(exact as Record<string, number>) : [];
  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, alignItems: 'center' }}>
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
          <T variant="h1">Pending transaction</T>
          <Card>
            <T variant="h3">{String(payload.description || payload.category)}</T>
            <T variant="caption" color={colors.warning} testID="pending-detail-status">
              {pendingStatusLabel(item)}
            </T>
            <T>{formatMoney(amount, { currency })}</T>
            <T variant="caption" muted>{String(payload.date)} · {String(payload.category)}</T>
            <T variant="caption" muted>Paid by {names[payload.paid_by_member_id] || payload.paid_by_member_id}</T>
            <T variant="caption" muted>Split: {String(payload.split_mode).replace('_', ' ').toLowerCase()}</T>
            <T variant="caption" muted>
              Participants: {payload.split_member_ids.map((memberId) => names[memberId] || memberId).join(', ')}
            </T>
            {exactRows.length ? <T variant="caption" muted>
              Exact amounts: {exactRows.map(([memberId, value]) =>
                `${names[memberId] || memberId} ${formatMoney(value, { currency })}`).join(', ')}
            </T> : null}
            <T variant="caption" muted>
              Saved on this device. Confirmed totals stay unchanged until the server accepts it.
            </T>
            <T variant="caption" muted>Attach a receipt after sync.</T>
          </Card>
          {item.lastSafeErrorCode && item.state !== 'needs_review' ? <Card>
            <T variant="caption" muted>{reviewReason(item.lastSafeErrorCode)}</T>
          </Card> : null}
          {item.state === 'needs_review' ? (
            <Card>
              <T variant="label" color={colors.warning}>Review needed</T>
              <T variant="caption" muted>{typeof (item.reviewContext as { warning?: unknown } | null)?.warning === 'string'
                ? String((item.reviewContext as { warning: string }).warning)
                : reviewReason(item.lastSafeErrorCode)}</T>
              {!expenseCaptureActive() ? <T variant="caption" muted>
                Editing pending expenses is temporarily unavailable.
              </T> : null}
              <View style={{ gap: SPACING.sm, marginTop: SPACING.sm }}>
                {item.lastSafeErrorCode === 'budget_confirmation_required' ? (
                  <Button label="Review and approve budget overage"
                    disabled={!expenseCaptureActive() || sessionMode !== 'online' || actionBusy}
                    onPress={() => setConfirmBudget(true)} testID="pending-budget-approve" />
                ) : item.lastSafeErrorCode !== 'invalid_write'
                  && item.lastSafeErrorCode !== 'invalid_local_payload'
                  && item.lastSafeErrorCode !== 'client_mutation_conflict' ? (
                  <Button label="Retry same transaction" disabled={!expenseCaptureActive() || actionBusy}
                    onPress={() => { void retry(); }} testID="pending-retry" />
                ) : null}
                <Button label="Edit and requeue" disabled={!expenseCaptureActive()
                  || item.lastSafeErrorCode === 'client_mutation_conflict'}
                  onPress={() => router.push({ pathname: '/trip/[id]/add-expense',
                    params: { id, reviewId: item.clientMutationId } })} testID="pending-edit" />
                <Button label="Discard pending expense" variant="secondary"
                  onPress={() => setConfirmDiscard(true)} testID="pending-discard" />
              </View>
            </Card>
          ) : null}
          {(item.state === 'queued' || item.state === 'awaiting_reconcile') ? (
            <Button label="Retry sync" disabled={!expenseCaptureActive() || actionBusy}
              onPress={() => { void retry(); }} testID="pending-retry" />
          ) : null}
        </View>
      </ScrollView>
      <ConfirmModal visible={confirmDiscard} title="Discard pending expense?"
        message="This removes the saved pending expense from this device. Confirmed trip records are unchanged."
        onRequestClose={() => setConfirmDiscard(false)} actions={[
          { label: 'Keep', variant: 'cancel', onPress: () => setConfirmDiscard(false) },
          { label: 'Discard', variant: 'destructive', onPress: () => { void discard(); } },
        ]} />
      <ConfirmModal visible={confirmBudget} title="Approve budget overage?"
        message={typeof (item.reviewContext as { warning?: unknown } | null)?.warning === 'string'
          ? String((item.reviewContext as { warning: string }).warning)
          : 'This transaction exceeds the trip budget. Save it anyway?'}
        onRequestClose={() => setConfirmBudget(false)} actions={[
          { label: 'Keep for review', variant: 'cancel', onPress: () => setConfirmBudget(false) },
          { label: 'Save anyway', variant: 'primary', onPress: () => { void approveBudget(); } },
        ]} />
    </Screen>
  );
}
