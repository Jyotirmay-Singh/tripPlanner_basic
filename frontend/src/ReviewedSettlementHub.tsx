import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api, getToken } from './api';
import { coverage, requireFinancialConnection, type ReviewedIntent } from './financialReview';
import { settlementError, settlementMoney, validCoverage, walletPeople, uncertainSendingShares, type SettlementTrip, type SettlementTransfer } from './expenseSettlement';
import useExpenseSettlement from './useExpenseSettlement';
import useFinancialRefresh from './useFinancialRefresh';
import useReviewedRecovery from './useReviewedRecovery';
import ReviewedSettlementFlow, { type SettlementSelection } from './ReviewedSettlementFlow';
import ReviewedIntentPanel from './ReviewedIntentPanel';
import { retryReviewedMutation } from './reviewedSettlement';
import T from './T';
import Button from './ui/Button';
import { SPACING } from './theme';

export default function ReviewedSettlementHub({ trip, accountId, sessionMode, isAdmin, expenseNames, focusIntentId,
  focusAttemptId, onChanged, onAdminReview }: { trip: SettlementTrip; accountId: string; sessionMode: string;
  isAdmin: boolean; expenseNames: Record<string, string>; focusIntentId?: string; focusAttemptId?: string;
  onChanged: () => unknown; onAdminReview: () => void }) {
  const progress = useExpenseSettlement({ tripId: trip.id, accountId, sessionMode, active: false, preferCache: sessionMode !== 'online' });
  const scope = JSON.stringify([accountId, trip.id]);
  const recovery = useReviewedRecovery(scope);
  const [intents, setIntents] = useState<ReviewedIntent[]>([]);
  const [transfers, setTransfers] = useState<SettlementTransfer[]>([]);
  const [selection, setSelection] = useState<SettlementSelection | null>(null);
  const [activeIntentId, setActiveIntentId] = useState<string | null>(focusIntentId ?? null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const read = useRef<AbortController | null>(null);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const load = async () => {
    const pass = ++generation.current;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    const valid = () => pass === generation.current && scopeRef.current === scope && !controller.signal.aborted;
    setLoaded(false); setError('');
    try {
      const snapshot = await progress.refresh();
      if (!valid() || sessionMode !== 'online' || !snapshot || !validCoverage(snapshot)) return;
      await requireFinancialConnection(sessionMode);
      const token = await getToken(); if (!token || !valid()) return;
      const options = { authToken: token, signal: controller.signal, timeoutMs: 15000 };
      const [work, balances] = await Promise.all([
        api<ReviewedIntent[]>(`/trips/${trip.id}/settlement-intents`, options),
        api<{ transfers: SettlementTransfer[] }>(`/trips/${trip.id}/balances`, options),
      ]);
      await coverage(trip.id, [], { ...options, snapshot: snapshot.snapshot_id! });
      if (!valid()) return;
      setIntents(work); setTransfers(balances.transfers); setLoaded(true);
      const matched = work.find(row => row.id === focusIntentId || row.cash_legs.some(leg => leg.payment_attempt_id === focusAttemptId));
      if (matched) setActiveIntentId(matched.id);
    } catch (failure) { if (valid()) setError(settlementError(failure)); }
  };
  useEffect(() => {
    setIntents([]); setTransfers([]); setSelection(null); setActiveIntentId(focusIntentId ?? null);
    void load();
    return () => { generation.current += 1; read.current?.abort(); };
    // Reads belong to the account/trip visit; the refresh subscription uses the latest closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, sessionMode, focusIntentId, focusAttemptId]);
  useFinancialRefresh(accountId, trip.id, load);
  const live = loaded && progress.source === 'live' && !progress.loading && sessionMode === 'online';
  const canStart = live && recovery.ready && !recovery.pending && !uncertainSendingShares(intents).size && progress.data?.availability.new_starts_available;
  const mine = new Set(trip.members.filter(wallet => walletPeople(wallet).some(person => person.userId === accountId)).map(wallet => wallet.id));
  const names = Object.fromEntries(trip.members.map(wallet => [wallet.id, wallet.name]));
  const afterAction = async () => { onChanged(); await load(); };
  const ordered = [...intents].sort((a, b) => Number(b.id === activeIntentId) - Number(a.id === activeIntentId));
  return <View style={{ gap: SPACING.md }} testID="reviewed-settlement-hub">
    {progress.source === 'cache' && <T>Saved progress — last confirmed {progress.data?.generated_at ? new Date(progress.data.generated_at).toLocaleString() : 'time unavailable'}. Connect and refresh before acting.</T>}
    {progress.data?.availability.status === 'new_starts_disabled' && <T>New payments are paused. Existing reviews and history remain available.</T>}
    {loaded && (focusIntentId || focusAttemptId) && !intents.some(row => row.id === focusIntentId
      || row.cash_legs.some(leg => leg.payment_attempt_id === focusAttemptId)) && <T>The requested review item is unavailable. Refresh current work or open Financial review.</T>}
    {selection && progress.data?.snapshot_id ? <ReviewedSettlementFlow key={JSON.stringify(selection)} trip={trip} accountId={accountId}
      sessionMode={sessionMode} scope={scope} selection={selection} snapshotId={progress.data.snapshot_id} live={live}
      isAdmin={isAdmin} expenseNames={expenseNames} shareDescriptions={{}} onComplete={afterAction} onBack={() => setSelection(null)}
      onCommitted={row => { setActiveIntentId(row.id); setSelection(null); }} onAdminReview={onAdminReview} /> : <>
      <T variant="h3">Simplified group payments</T>
      <T>Review actual cash, related expenses, offsets, and every dependent payment before sending. Pending reports are not approved expense coverage.</T>
      {uncertainSendingShares(intents).size > 0 && <T>Check your expired or canceled UPI work below before starting a group payment. Expiry does not prove that money was not sent.</T>}
      {transfers.map(transfer => <View key={`${transfer.from_member_id}:${transfer.to_member_id}`} style={{ gap: SPACING.sm }}>
        <T>{names[transfer.from_member_id] ?? 'Historical wallet'} → {names[transfer.to_member_id] ?? 'Historical wallet'}: {settlementMoney(String(transfer.amount), trip.currency)}</T>
        <Button label="Review payment and expense coverage" variant="secondary" disabled={!canStart || busy || !mine.has(transfer.from_member_id)}
          onPress={() => setSelection({ mode: 'group', transfer })} testID={`reviewed-group-${transfer.from_member_id}-${transfer.to_member_id}`} />
      </View>)}
      {!transfers.length && progress.data?.expenses?.some(row => row.remaining_amount && row.remaining_amount !== '0')
        && <T>Group balance is zero; expense shares still need settlement or offset approval. Open the expense to pay directly or propose an offset.</T>}
      <T variant="h3">Existing payments and approvals</T>
      {ordered.map(row => <View key={row.id} style={{ gap: SPACING.sm }} testID={`reviewed-work-${row.id}`}>
        <T>{row.allocation_status === 'applied' ? 'Approved coverage and history' : row.mode === 'offset' ? 'View offset approval' : 'Continue existing payment / View pending review'}</T>
        <ReviewedIntentPanel trip={trip} row={row} accountId={accountId} sessionMode={sessionMode} isAdmin={isAdmin} scope={scope}
          live={live} expenseNames={expenseNames} onComplete={afterAction} onAdminReview={onAdminReview} />
      </View>)}
    </>}
    {recovery.pending && <Button label="Check or retry previous submission" disabled={busy || !live} loading={busy} onPress={() => {
      if (busy) return;
      setBusy(true);
      const pass = generation.current;
      void requireFinancialConnection(sessionMode).then(getToken).then(async token => {
        const valid = () => pass === generation.current && scopeRef.current === scope;
        if (token && valid()) { await retryReviewedMutation(scope, token, valid); await afterAction(); }
      }).catch(failure => { if (pass === generation.current) setError(settlementError(failure)); }).finally(() => setBusy(false));
    }} />}
    {error || recovery.error || progress.message ? <T accessibilityRole="alert">{error || recovery.error || progress.message}</T> : null}
    <Button label="Refresh payments and shares" variant="ghost" disabled={progress.loading} onPress={() => void load()} />
  </View>;
}
