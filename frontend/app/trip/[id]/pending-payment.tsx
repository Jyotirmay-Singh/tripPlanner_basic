import React, { useCallback, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { offlineStore } from '../../../src/offlineStore';
import { paymentCaptureActive, type PendingPayment } from '../../../src/offlinePayments';
import { pendingStatusLabel, reviewReason } from '../../../src/offlineExpenses';
import { syncCoordinator } from '../../../src/syncWorker';
import { formatMoney } from '../../../src/format';
import { formatIST } from '../../../src/istTime';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import { Screen, Card, Button, EmptyState, useToast } from '../../../src/ui';
import ConfirmModal from '../../../src/ConfirmModal';
import T from '../../../src/T';

type SavedTrip = { members?: { id: string; name: string }[] };

export default function PendingPaymentDetail() {
  const { id, mutationId } = useLocalSearchParams<{ id: string; mutationId: string }>();
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [storedItem, setStoredItem] = useState<{ accountId: string; value: PendingPayment | null } | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadGeneration = useRef(0);
  const item = storedItem && storedItem.accountId === user?.id ? storedItem.value : null;

  const load = useCallback(async () => {
    if (!user?.id || !id || !mutationId) return;
    const generation = ++loadGeneration.current;
    try {
      const rows = await offlineStore.listOutbox(user.id);
      const snapshot = await offlineStore.getTripSnapshot(user.id, id).catch(() => null);
      if (generation !== loadGeneration.current) return;
      const found = rows.find((row) => row.clientMutationId === mutationId && row.tripId === id
        && row.operation === 'manual_payment_create' && row.state !== 'synced');
      setStoredItem({ accountId: user.id, value: found as PendingPayment | undefined ?? null });
      const trip = snapshot?.payload as SavedTrip | undefined;
      setNames(Object.fromEntries((trip?.members ?? []).map((member) => [member.id, member.name])));
      setReadError(false);
    } catch { if (generation === loadGeneration.current) setReadError(true); }
    finally { if (generation === loadGeneration.current) setLoaded(true); }
  }, [user?.id, id, mutationId]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]));
  useFocusEffect(useCallback(() => {
    if (!user?.id || !mutationId) return () => {};
    return syncCoordinator.subscribe((event) => {
      if (event.accountId === user.id && event.mutationId === mutationId) void load();
    });
  }, [user?.id, mutationId, load]));

  const retry = async () => {
    if (!user?.id || !item || busy) return;
    setBusy(true);
    try {
      const scheduled = item.state === 'awaiting_reconcile'
        ? (syncCoordinator.wake(user.id, item.clientMutationId), true)
        : await syncCoordinator.retry(user.id, item.clientMutationId);
      if (!scheduled) throw new Error('Retry unavailable');
    } catch {
      toast.show('Could not schedule a retry. This record remains saved.', 'error');
    } finally { setBusy(false); }
  };

  const discard = async () => {
    if (!user?.id || !item || busy) return;
    setBusy(true);
    try {
      await offlineStore.discardReviewPayment(user.id, item.clientMutationId);
      setConfirmDiscard(false);
      router.back();
    } catch {
      toast.show('Could not discard this pending payment. It remains saved on this device.', 'error');
    } finally { setBusy(false); }
  };

  if (!loaded) return <Screen><T>Loading pending payment…</T></Screen>;
  if (readError || !item) return <Screen><EmptyState icon="alert"
    title="Pending payment unavailable"
    body={readError ? 'Saved payments could not be read on this device.'
      : 'This pending payment is no longer here.'} /></Screen>;

  const payload = item.payload;
  const canRetry = item.state === 'queued' || item.state === 'awaiting_reconcile'
    || (item.state === 'needs_review' && !['invalid_write', 'invalid_local_payload',
      'client_mutation_conflict'].includes(item.lastSafeErrorCode ?? ''));
  const canEdit = item.state === 'needs_review' && !item.canonicalResourceId
    && item.lastSafeErrorCode !== 'client_mutation_conflict';

  return <Screen edges={['left', 'right', 'bottom']}>
    <ScrollView contentContainerStyle={{ padding: SPACING.md, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
        <T variant="h1">Pending payment record</T>
        <Card>
          <T variant="h3">{names[payload.from_member_id] || payload.from_member_id}
            {' paid '}{names[payload.to_member_id] || payload.to_member_id}</T>
          <T variant="caption" color={colors.warning} accessibilityLabel={pendingStatusLabel(item)}
            testID="pending-payment-status">{pendingStatusLabel(item)}</T>
          <T>{formatMoney(payload.amount, { currency: payload.expected_currency })}</T>
          <T variant="caption" muted>Saved on device: {formatIST(new Date(item.queuedAt).toISOString())}</T>
          {payload.note ? <T variant="caption" muted>{payload.note}</T> : null}
          <T variant="caption" muted>
            Saved on this device as a record of money already exchanged. The server must accept it before confirmed balances change.
          </T>
        </Card>
        {item.lastSafeErrorCode ? <Card>
          <T variant="caption" color={colors.warning}>{reviewReason(item.lastSafeErrorCode)}</T>
          {item.state === 'needs_review' ? <T variant="caption" muted>
            Check the actual amount and recipient against a current suggestion. The app will not change either for you.
          </T> : null}
        </Card> : null}
        {canRetry ? <Button label={item.state === 'needs_review' ? 'Retry same details' : 'Retry sync'}
          disabled={!paymentCaptureActive() || busy} onPress={() => { void retry(); }}
          testID="pending-payment-retry" /> : null}
        {canEdit ? <>
          <Button label="Edit and requeue" disabled={!paymentCaptureActive() || busy}
            onPress={() => router.push(`/trip/${id}/settle-up?reviewId=${encodeURIComponent(item.clientMutationId)}`)}
            testID="pending-payment-edit" />
          <Button label="Discard pending record" variant="secondary"
            onPress={() => setConfirmDiscard(true)} testID="pending-payment-discard" />
        </> : null}
        {item.state === 'needs_review' && !canEdit ? <Button label="Discard pending record"
          variant="secondary" onPress={() => setConfirmDiscard(true)}
          testID="pending-payment-discard" /> : null}
      </View>
    </ScrollView>
    <ConfirmModal visible={confirmDiscard} title="Discard pending payment?"
      message="This removes the saved record from this device. It does not undo money already exchanged. Confirmed trip balances are unchanged."
      onRequestClose={() => setConfirmDiscard(false)} actions={[
        { label: 'Keep', variant: 'cancel', onPress: () => setConfirmDiscard(false) },
        { label: 'Discard', variant: 'destructive', onPress: () => { void discard(); } },
      ]} />
  </Screen>;
}
