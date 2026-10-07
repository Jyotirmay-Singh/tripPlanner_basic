import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { api, getToken } from './api';
import { coverage, requireFinancialConnection, type Coverage, type CoveragePerson, type ReviewedIntent } from './financialReview';
import { confirmedCoverage, eligibleFamilyShares, participantState, relevantIntents, settlementError,
  settlementMoney, sourceLabel, sumAmounts, units, walletPeople, uncertainSendingShares, type SettlementTrip, type SettlementTransfer } from './expenseSettlement';
import { hasUnresolvedSubmission, retryReviewedMutation } from './reviewedSettlement';
import ReviewedSettlementFlow, { type SettlementSelection } from './ReviewedSettlementFlow';
import ReviewedIntentPanel from './ReviewedIntentPanel';
import useReviewedRecovery from './useReviewedRecovery';
import useFinancialRefresh from './useFinancialRefresh';
import { useTheme } from './ThemeContext';
import T from './T';
import { Sheet, Button, Icon, Input } from './ui';
import { SPACING, COMPONENT_SIZE } from './theme';
import { formatMoney } from './format';

type Expense = { id: string; description?: string; category: string; amount: number; paid_by_member_id: string };
type Progress = { data: Coverage | null; source: 'live' | 'cache' | 'unavailable'; loading: boolean; message: string;
  refresh: (expenseId?: string) => Promise<Coverage | null> };

export function ParticipantShareRow({ row, state, selected, selectable, payerName, currency, narrow, onToggle }: {
  row: CoveragePerson; state: string; selected: boolean; selectable: boolean; payerName?: string; narrow: boolean; onToggle: () => void;
  currency: string;
}) {
  const { colors } = useTheme();
  const name = row.person_name ?? 'Historical participant (identity unavailable)';
  return <View style={[styles.participant, { borderColor: colors.border }]} testID={`settlement-share-${row.id}`}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
      {selectable ? <Pressable onPress={onToggle} testID={`settlement-select-${row.id}`} accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }} aria-checked={selected}
        accessibilityLabel={`${selected ? 'Paying for' : 'Pay for'} ${name}. ${selected ? 'Deselect' : 'Select'} share.`}
        {...(Platform.OS === 'web' ? { onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === ' ') { event.preventDefault(); onToggle(); }
        } } : {})}
        style={({ focused }: any) => [styles.check, focused && Platform.OS === 'web' && { outlineWidth: 2, outlineStyle: 'solid', outlineColor: colors.primary } as any]}>
        <Icon name={selected ? 'checkbox-on' : 'checkbox-off'} size={22} color={colors.primary} />
      </Pressable> : <Icon name={state === 'Settled' ? 'check-circle' : state === 'Needs review' ? 'alert' : 'clock'} size={20} color={colors.textMain} />}
      <View style={{ flex: 1, minWidth: 0, gap: SPACING.xs }}>
        <T variant="h4">{name}</T>
        <T variant="caption" testID={`settlement-share-status-${row.id}`}>{state}</T>
      </View>
    </View>
    <View style={{ flexDirection: narrow ? 'column' : 'row', flexWrap: 'wrap', gap: SPACING.sm }}>
      <T variant="caption" accessibilityLabel={`Share ${settlementMoney(row.original_share, currency, true)}`}>Share {settlementMoney(row.original_share, currency)}</T>
      <T variant="caption" accessibilityLabel={`Confirmed coverage ${settlementMoney(confirmedCoverage(row), currency, true)}`}>Confirmed coverage {settlementMoney(confirmedCoverage(row), currency)}</T>
      <T variant="caption" accessibilityLabel={`Remaining ${settlementMoney(row.remaining_amount, currency, true)}`}>Remaining {settlementMoney(row.remaining_amount, currency)}</T>
    </View>
    {selected && payerName && <T variant="caption">{payerName} is paying for {name}.</T>}
    {units(row.original_share.replace('-', '')) === 0n && <T variant="caption">No payment needed.</T>}
    {row.remaining_amount === '0' && <T variant="caption">This share is covered. Open coverage details for the explanation; another payment is unavailable.</T>}
    {units(row.coverage?.wallet_funding) !== null && units(row.coverage?.wallet_funding)! > 0n && <T variant="caption">Covered by paying wallet.</T>}
    {units(row.coverage?.historical_inferred) !== null && units(row.coverage?.historical_inferred)! > 0n && <T variant="caption">Inferred from history; receipt confirmation is not recorded here.</T>}
    {units(row.reserved_amount) !== null && units(row.reserved_amount)! > 0n && <T variant="caption">
      {settlementMoney(row.reserved_amount, currency)} is reserved by unresolved payment work. Confirmed remaining still includes this amount.
    </T>}
    {selectable && row.actionable_amount !== row.remaining_amount && <T variant="caption">Available to pay {settlementMoney(row.actionable_amount, currency)}.</T>}
  </View>;
}

export function CoverageDetails({ rows, currency, personName, walletName }: {
  rows: CoveragePerson[]; currency: string; personName: (id?: string | null) => string; walletName: (id: string) => string;
}) {
  return <View style={{ gap: SPACING.md }} testID="settlement-coverage-details">
    {rows.map(row => <View key={row.id} style={{ gap: SPACING.xs }}>
      <T variant="h4">{row.person_name ?? 'Historical participant'}</T>
      {Object.entries(row.coverage ?? {}).filter(([, amount]) => units(amount) !== null && units(amount)! > 0n).map(([kind, amount]) =>
        <T key={kind}>{sourceLabel(kind)}: {settlementMoney(amount, currency)}</T>)}
      {row.coverage_explanations.map((line, index) => <View key={index} style={{ gap: SPACING.xs }}>
        <T variant="caption">{sourceLabel(line.kind)}: {settlementMoney(line.amount, currency)}{line.reversed ? ' · Reversed evidence' : ''}</T>
        {line.kind === 'historical_inferred' && <T variant="caption">Linked from historical evidence. This is not receiver confirmation or bank verification.</T>}
        {line.cash_legs?.map((leg, i) => <T variant="caption" key={i}>
          {personName(leg.actual_payer_person_id)} ({walletName(leg.from_member_id)}) paid {personName(leg.actual_receiver_person_id)} ({walletName(leg.to_member_id)}) {settlementMoney(leg.amount, currency)}. This source covers {row.person_name ?? 'the historical participant'} through the reviewed allocation.
        </T>)}
        {!line.cash_legs?.length && !['approved_offset', 'wallet_funding'].includes(line.kind) && <T variant="caption">Actual paying and receiving people were not recorded in this coverage explanation.</T>}
      </View>)}
      {row.funding_person_id == null && row.coverage?.wallet_funding !== '0' && units(row.coverage?.wallet_funding) !== null
        && <T variant="caption">Funding person not recorded; the paying wallet is known.</T>}
      {row.funding_person_id && units(row.coverage?.wallet_funding) !== null && units(row.coverage?.wallet_funding)! > 0n
        && <T variant="caption">Funded by {personName(row.funding_person_id)} in {walletName(row.funding_wallet_id ?? row.wallet_id)}.</T>}
    </View>)}
  </View>;
}

export default function ExpenseSettlementSheet({ expense, trip, accountId, sessionMode, isAdmin, progress, expenseNames, onClose, onChanged }: {
  expense: Expense; trip: SettlementTrip; accountId: string; sessionMode: string; isAdmin: boolean; progress: Progress;
  expenseNames: Record<string, string>; onClose: () => void; onChanged: () => void;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const { width, fontScale } = useWindowDimensions();
  const [intents, setIntents] = useState<ReviewedIntent[]>([]);
  const [workLoaded, setWorkLoaded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [transfers, setTransfers] = useState<SettlementTransfer[]>([]);
  const [selection, setSelection] = useState<SettlementSelection | null>(null);
  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  const visit = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  const scope = JSON.stringify([accountId, trip.id]);
  const recovery = useReviewedRecovery(scope);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const data = progress.data;
  const detail = data?.details?.[expense.id];
  const rows = detail?.participants.filter(row => row.participating !== false) ?? [];
  const live = progress.source === 'live' && sessionMode === 'online' && !progress.loading && !!data?.complete;
  const liveRef = useRef(live); liveRef.current = live;
  const canStart = live && workLoaded && recovery.ready && !recovery.pending && data?.availability.new_starts_available === true;
  const people = trip.members.flatMap(walletPeople);
  const mine = people.filter(person => person.userId === accountId);
  const myWallets = new Set(mine.map(person => person.walletId));
  const payer = mine[0];
  const walletName = (id: string) => trip.members.find(wallet => wallet.id === id)?.name ?? 'Historical wallet';
  const personName = (id?: string | null) => id ? people.find(person => person.id === id)?.name
    ?? 'Historical person (name unavailable)' : 'Person not recorded';
  const uncertainShares = uncertainSendingShares(intents);
  const eligible = canStart ? eligibleFamilyShares(rows, trip.members, accountId).filter(row => !uncertainShares.has(row.id)) : [];
  const related = relevantIntents(intents, rows.map(row => row.id));
  const activeIntent = intents.find(row => row.id === activeIntentId);
  if (activeIntent && !related.some(row => row.id === activeIntent.id)) related.unshift(activeIntent);
  const onAdminReview = () => { onClose(); router.push(`/trip/${trip.id}/financial-review` as Href); };
  const load = async () => {
    const pass = ++visit.current;
    readAbort.current?.abort(); const controller = new AbortController(); readAbort.current = controller;
    setWorkLoaded(false);
    const result = await progress.refresh(expense.id);
    if (pass !== visit.current || scopeRef.current !== scope) return;
    if (sessionMode !== 'online' || !result?.complete || !result.snapshot_id) return;
    try {
      await requireFinancialConnection(sessionMode);
      const token = await getToken();
      if (!token || pass !== visit.current) return;
      const work = await api<ReviewedIntent[]>(`/trips/${trip.id}/settlement-intents`, { authToken: token, signal: controller.signal });
      await coverage(trip.id, [], { authToken: token, signal: controller.signal, snapshot: result.snapshot_id });
      if (pass === visit.current && scopeRef.current === scope) { setIntents(work); setWorkLoaded(true); }
    } catch (failure) { if (pass === visit.current) setError(settlementError(failure)); }
  };
  useEffect(() => {
    void load();
    return () => { visit.current += 1; readAbort.current?.abort(); };
    // A sheet visit owns its requests; refresh is explicit after actions, never per participant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, expense.id, sessionMode]);
  useFinancialRefresh(accountId, trip.id, load);
  useEffect(() => { setActiveIntentId(null); }, [scope, expense.id]);
  useEffect(() => {
    const initial = data?.availability.new_starts_available ? eligibleFamilyShares(detail?.participants ?? [], trip.members, accountId) : [];
    setSelected(initial.map(row => row.id));
    setAmounts(Object.fromEntries(initial.map(row => [row.id, row.actionable_amount!])));
    setSelection(null); setEditing(false); setTransfers([]); setGroupOpen(false);
    // Selection is renewed only for a different ledger snapshot, not a duplicate detail read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.snapshot_id, detail?.revision_id, accountId]);
  const afterAction = async () => { onChanged(); await load(); };
  const submitRead = async (work: (token: string, valid: () => boolean) => Promise<void>) => {
    if (gate.current || !live) return;
    gate.current = true; setBusy(true); setError('');
    const pass = visit.current;
    const valid = () => pass === visit.current && scopeRef.current === scope && liveRef.current;
    try { await requireFinancialConnection(sessionMode); const token = await getToken(); if (token && valid()) await work(token, valid); }
    catch (failure) { if (valid()) setError(settlementError(failure)); }
    finally { gate.current = false; if (valid()) setBusy(false); }
  };
  const paying = eligible.filter(row => selected.includes(row.id));
  const pairs = new Map<string, CoveragePerson[]>();
  for (const row of paying) {
    const key = `${row.debtor_wallet_id}:${row.creditor_wallet_id}`;
    pairs.set(key, [...(pairs.get(key) ?? []), row]);
  }
  const invalidAmount = paying.some(row => !units(amounts[row.id]) || units(amounts[row.id])! <= 0n
    || units(amounts[row.id])! > (units(row.actionable_amount) ?? 0n));
  const unresolved = hasUnresolvedSubmission(scope) || recovery.pending;
  const outgoing = rows.filter(row => row.participating && myWallets.has(row.debtor_wallet_id) && row.debtor_wallet_id !== row.creditor_wallet_id);
  const incoming = rows.filter(row => row.participating && myWallets.has(row.creditor_wallet_id) && row.debtor_wallet_id !== row.creditor_wallet_id);
  const title = expense.description || expense.category;
  return <Sheet visible title={title} onClose={onClose} closeLabel="Close expense settlement" touchSize={COMPONENT_SIZE.minTouchTarget}
    trapFocus restrainedMotion testID="expense-settlement-sheet" closeTestID="expense-settlement-close">
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: SPACING.md, paddingBottom: SPACING.sm }} testID="expense-settlement-scroll">
      <T variant="money">{formatMoney(expense.amount, { currency: trip.currency })}</T>
      <T muted>{expense.amount < 0 ? 'Refund received by' : 'Paid by'} {walletName(expense.paid_by_member_id)}</T>
      {progress.source === 'cache' && <T testID="settlement-saved-status">Saved progress — last confirmed {data?.generated_at ? new Date(data.generated_at).toLocaleString() : 'time unavailable'}. Connect and refresh before acting.</T>}
      {!!progress.message && <T accessibilityRole="alert">{progress.message}</T>}
      {progress.loading && <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}><ActivityIndicator color={colors.primary} /><T>Checking settlement…</T></View>}
      {!detail && !progress.loading && <>
        <T>{['disabled', 'not_activated'].includes(data?.availability.status ?? '') ? 'Expense settlement is not enabled for this group.' : 'Settlement progress unavailable. No settled count or payable amount can be confirmed.'}</T>
        <Button label="Retry settlement details" variant="secondary" onPress={() => void load()} testID="settlement-details-retry" />
      </>}
      {data?.availability.status === 'new_starts_disabled' && <T>New payments are paused. Existing coverage, reports and authorized reviews remain available.</T>}
      {selection && data?.snapshot_id ? <ReviewedSettlementFlow key={JSON.stringify(selection)} trip={trip} accountId={accountId}
        sessionMode={sessionMode} scope={scope} selection={selection} snapshotId={data.snapshot_id} live={live} isAdmin={isAdmin}
        expenseNames={expenseNames} shareDescriptions={Object.fromEntries(rows.map(row => [row.id, `${title} · ${row.person_name ?? 'Historical participant'}`]))}
        onComplete={afterAction} onCommitted={row => setActiveIntentId(row.id)} onBack={() => setSelection(null)} onAdminReview={onAdminReview} /> : <>
        {detail && <>
          {outgoing.length > 0 && <T variant="h3">{expense.amount < 0 ? 'Refunds you owe' : 'You owe'} {settlementMoney(sumAmounts(outgoing.map(row => row.remaining_amount)), trip.currency)}</T>}
          {incoming.length > 0 && <T variant="h3">{expense.amount < 0 ? 'Refund due to your wallet' : 'You receive'} {settlementMoney(sumAmounts(incoming.map(row => row.remaining_amount)), trip.currency)}</T>}
          {rows.filter(row => units(row.remaining_amount) !== 0n).map(row => myWallets.has(row.debtor_wallet_id)
            ? <T key={row.id}>For {row.person_name ?? 'the historical participant'}, your wallet owes {walletName(row.creditor_wallet_id)} {settlementMoney(row.remaining_amount, trip.currency)}{expense.amount < 0 ? ' as a refund' : ''}.</T>
            : myWallets.has(row.creditor_wallet_id) ? <T key={row.id}>{walletName(row.debtor_wallet_id)} owes your wallet {settlementMoney(row.remaining_amount, trip.currency)}{expense.amount < 0 ? ' as a refund' : ''} for {row.person_name ?? 'the historical participant'}.</T> : null)}
          {payer && paying.length > 0 && <T testID="settlement-paying-for">Paying as {payer.name}, for {paying.map(row => row.person_name ?? 'historical participant').join(', ')}.</T>}
          {data.expenses?.find(row => row.expense_id === expense.id)?.viewer_status === 'covered' && <T testID="settlement-your-share-settled">Your share settled</T>}
          {rows.map(row => <ParticipantShareRow key={row.id} row={row} state={participantState(row, intents)} selected={selected.includes(row.id)}
            selectable={eligible.some(item => item.id === row.id)} payerName={payer?.name} currency={trip.currency} narrow={width <= 360 || fontScale >= 1.3}
            onToggle={() => setSelected(previous => previous.includes(row.id) ? previous.filter(id => id !== row.id) : [...previous, row.id])} />)}
          {paying.length > 0 && <>
            <Button label={editing ? 'Done editing amounts' : 'Edit payment amounts'} variant="ghost" onPress={() => setEditing(value => !value)} testID="settlement-edit-amounts" />
            {editing && paying.map(row => <Input key={row.id} label={`Amount for ${row.person_name ?? 'participant'}`} value={amounts[row.id] ?? ''}
              onChangeText={value => setAmounts(previous => ({ ...previous, [row.id]: value }))} keyboardType="numeric"
              helper={`Maximum ${settlementMoney(row.actionable_amount, trip.currency)}; positive whole amount.`} testID={`settlement-amount-${row.id}`} />)}
            {Array.from(pairs.entries()).map(([key, pair]) => {
              const recipient = walletPeople(trip.members.find(wallet => wallet.id === pair[0].creditor_wallet_id));
              const funding = pair[0].funding_person_id;
              const recipientPerson = recipient.some(person => person.id === funding) ? funding : recipient.length === 1 ? recipient[0].id : null;
              const label = recipientPerson ? personName(recipientPerson) : walletName(pair[0].creditor_wallet_id);
              return <Button key={key} label={`Pay ${label} · ${settlementMoney(sumAmounts(pair.map(row => amounts[row.id])), trip.currency)}`}
                disabled={invalidAmount || unresolved || !workLoaded} onPress={() => setSelection({ mode: 'direct',
                  shares: pair.map(row => ({ share_id: row.id, amount: amounts[row.id] })), fromWallet: pair[0].debtor_wallet_id,
                  toWallet: pair[0].creditor_wallet_id, recipientPerson })} testID={`settlement-pay-${pair[0].creditor_wallet_id}`} />;
            })}
            <T>Already paid? Choose cash or bank transfer in the payment review. Reports await receiver/admin confirmation.</T>
          </>}
          {unresolved && <Button label="Check or retry previous submission" disabled={!live} loading={busy} onPress={() => void submitRead(async (token, valid) => {
            await retryReviewedMutation(scope, token, valid); if (valid()) await afterAction();
          })} testID="settlement-recover-submission" />}
          {rows.some(row => uncertainShares.has(row.id)) && <T>Check the expired or canceled UPI payment below before paying these shares again. Report Payment sent, or explicitly confirm I did not pay.</T>}
          <Button label="Use group settlement" variant="secondary" disabled={!canStart || busy || unresolved || !workLoaded || uncertainShares.size > 0}
            onPress={() => void submitRead(async (token, valid) => {
              const result = await api<{ transfers: SettlementTransfer[] }>(`/trips/${trip.id}/balances`, { authToken: token, signal: readAbort.current?.signal });
              if (valid()) { setTransfers(result.transfers.filter(row => myWallets.has(row.from_member_id))); setGroupOpen(true); }
            })} testID="settlement-group-option" />
          <T variant="caption">Combines amounts across expenses and may propose offsets. Review people, expenses and required approvals. Direct expense payment remains your choice.</T>
          {groupOpen && <View style={{ gap: SPACING.sm }}>
            {transfers.map(transfer => <Button key={`${transfer.from_member_id}:${transfer.to_member_id}`}
              label={`Review group payment to ${walletName(transfer.to_member_id)} · ${settlementMoney(String(transfer.amount), trip.currency)}`}
              variant="secondary" onPress={() => setSelection({ mode: 'group', transfer })} testID={`settlement-group-pay-${transfer.to_member_id}`} />)}
            {paying.length > 0 && <Button label="Review a zero-money offset proposal" variant="secondary" disabled={invalidAmount}
              onPress={() => setSelection({ mode: 'offset', shares: paying.map(row => ({ share_id: row.id, amount: amounts[row.id] })),
                fromWallet: paying[0].debtor_wallet_id, toWallet: paying[0].creditor_wallet_id })} testID="settlement-offset-option" />}
            {!transfers.length && <T>There is no outgoing group payment recommendation. Open expense shares can still require direct payment or an approved offset.</T>}
          </View>}
          {related.map(row => <View key={row.id} style={[styles.participant, { borderColor: colors.border }]}>
            <ReviewedIntentPanel trip={trip} row={row} accountId={accountId} sessionMode={sessionMode} isAdmin={isAdmin}
              scope={scope} live={live && workLoaded} expenseNames={expenseNames} onComplete={afterAction} onAdminReview={onAdminReview} />
          </View>)}
          {!workLoaded && live && <T>Payment reports are unavailable. Refresh before starting payment; existing coverage is shown separately.</T>}
          <Button label={detailsOpen ? 'Hide coverage and activity' : 'Coverage and activity'} variant="ghost" onPress={() => setDetailsOpen(value => !value)} testID="settlement-coverage-toggle" />
          {detailsOpen && <CoverageDetails rows={rows} currency={trip.currency} personName={personName} walletName={walletName} />}
          {(detail.review_required || rows.some(row => row.review_required)) && <>
            <T>Some history or financial evidence needs review. Unknown coverage and remaining amounts are not treated as zero.</T>
            {isAdmin && <Button label="Open financial review" variant="secondary" onPress={onAdminReview} testID="settlement-admin-review" />}
          </>}
          <Button label="Refresh shares" variant="ghost" disabled={progress.loading} onPress={() => void load()} testID="settlement-refresh" />
        </>}
      </>}
      {!!error && <T accessibilityRole="alert">{error}</T>}
      {!!recovery.error && <T accessibilityRole="alert">{recovery.error}</T>}
    </ScrollView>
  </Sheet>;
}
const styles = StyleSheet.create({ participant: { borderTopWidth: 1, paddingTop: SPACING.md, gap: SPACING.sm },
  check: { minWidth: COMPONENT_SIZE.minTouchTarget, minHeight: COMPONENT_SIZE.minTouchTarget,
    alignItems: 'center', justifyContent: 'center' } });
