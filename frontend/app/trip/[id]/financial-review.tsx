import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, getToken } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import T from '../../../src/T';
import { Screen, Card, Button, Input, Sheet, SegmentedControl } from '../../../src/ui';
import { SPACING } from '../../../src/theme';
import FinancialReviewSheet, { ReviewEffectsView } from '../../../src/FinancialReviewSheet';
import { coverage, completeCoverage, requireFinancialConnection, type Coverage, type CoveragePerson, type Correction,
  type ReviewedIntent, type ReviewRequest, type ReviewPreview } from '../../../src/financialReview';
import { hasUnresolvedSubmission, reviewedMutation, retryReviewedMutation } from '../../../src/reviewedSettlement';
import ReviewedIntentPanel from '../../../src/ReviewedIntentPanel';
import ReviewedSettlementFlow, { type SettlementSelection } from '../../../src/ReviewedSettlementFlow';
import useFinancialRefresh from '../../../src/useFinancialRefresh';
import useReviewedRecovery from '../../../src/useReviewedRecovery';
import { uncertainSendingShares } from '../../../src/expenseSettlement';

type Wallet = { id: string; name: string; kind: string; user_id?: string; family_members?: string[];
  family_member_ids?: string[]; family_member_user_ids?: (string | null)[] };
type Group = { currency: string; owner_id: string; admin_ids: string[]; members: Wallet[]; archived_at?: string };
type Transfer = { from_member_id: string; to_member_id: string; amount: number | string };
type HistoryReport = { plan_hash: string; activation_blocked: boolean; counts: Record<string, number>;
  baseline_wallet_vector: Record<string, string>; reconciliation_difference: Record<string, string>;
  review_cases: { code: string }[]; index_prerequisites: string[]; source_link_duplicates: string[][] };

function people(wallet: Wallet | undefined): { id: string; name: string; user?: string | null }[] {
  if (!wallet) return [];
  return wallet.kind === 'family' ? (wallet.family_member_ids ?? []).map((id, index) => ({ id,
    name: wallet.family_members?.[index] ?? 'Family member', user: wallet.family_member_user_ids?.[index] }))
    : [{ id: wallet.id, name: wallet.name, user: wallet.user_id }];
}

export default function FinancialReview() {
  const { id, intentId: focusIntentId, correctionId: focusCorrectionId } = useLocalSearchParams<{ id: string; intentId?: string; correctionId?: string }>();
  const { user, sessionMode } = useAuth();
  const { colors } = useTheme();
  const account = useRef(user?.id); account.current = user?.id;
  const scope = useRef(id); scope.current = id;
  const loadingRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [group, setGroup] = useState<Group | null>(null);
  const [current, setCurrent] = useState<Coverage | null>(null);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [intents, setIntents] = useState<ReviewedIntent[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(true);
  const [journey, setJourney] = useState<SettlementSelection | null>(null);
  const [reason, setReason] = useState('');
  const [request, setRequest] = useState<ReviewRequest | null>(null);
  const [cashTarget, setCashTarget] = useState('');
  const [cashAmount, setCashAmount] = useState('');
  const [selected, setSelected] = useState<CoveragePerson | null>(null);
  const [amount, setAmount] = useState('');
  const [credit, setCredit] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<ReviewPreview | null>(null);
  const [mapping, setMapping] = useState(false);
  const [mappingMode, setMappingMode] = useState('group');
  const [mappingSources, setMappingSources] = useState<string[]>([]);
  const [mappingShares, setMappingShares] = useState<string[]>([]);
  const [mappingAmounts, setMappingAmounts] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Correction | null>(null);
  const [movePerson, setMovePerson] = useState('');
  const [moveWallet, setMoveWallet] = useState('');
  const [linkEmail, setLinkEmail] = useState('');
  const [historical, setHistorical] = useState<HistoryReport | null>(null);
  const [pastExpenses, setPastExpenses] = useState<string[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [accountingWallets, setAccountingWallets] = useState<Wallet[]>([]);
  const mutationScope = JSON.stringify([user?.id, id]);
  const recovery = useReviewedRecovery(mutationScope);
  const [retry, setRetry] = useState(hasUnresolvedSubmission(mutationScope));
  const submitting = useRef(false);
  const wallets = [...(group?.members ?? []), ...accountingWallets.filter(wallet => !group?.members.some(row => row.id === wallet.id))];
  const names = Object.fromEntries(wallets.map(row => [row.id, row.name]));
  const admin = !!(user && (user.is_super_admin || group?.owner_id === user.id || group?.admin_ids.includes(user.id)));
  const myPeople = (group?.members ?? []).flatMap(people).filter(row => row.user === user?.id).map(row => row.id);
  const uncertainShares = uncertainSendingShares(intents);
  const load = useCallback(async () => {
    const actor = user?.id, pass = ++generation.current;
    loadingRequest.current?.abort();
    const controller = new AbortController(); loadingRequest.current = controller;
    setError('');
    setLoadFailed(true);
    try {
      await requireFinancialConnection(sessionMode);
      const token = await getToken();
      if (!token || account.current !== actor) return;
      const options = { authToken: token, signal: controller.signal, timeoutMs: 15000 };
      const complete = await completeCoverage(id, options);
      const [trip, rows, work, balances] = await Promise.all([
        api<Group>(`/trips/${id}`, options),
        api<Correction[]>(`/trips/${id}/corrections`, options),
        api<ReviewedIntent[]>(`/trips/${id}/settlement-intents`, options),
        api<{ transfers: Transfer[]; members: Wallet[] }>(`/trips/${id}/balances`, options),
      ]);
      const focused = focusCorrectionId ? await api<Correction>(`/trips/${id}/corrections/${focusCorrectionId}`, options) : null;
      if (complete.complete && complete.snapshot_id) await coverage(id, [], { ...options, snapshot: complete.snapshot_id });
      if (account.current !== actor || generation.current !== pass) return;
      setGroup(trip); setCurrent(complete); setCorrections([...rows].sort((a, b) => Number(b.id === focusCorrectionId) - Number(a.id === focusCorrectionId)));
      setIntents([...work].sort((a, b) => Number(b.id === focusIntentId) - Number(a.id === focusIntentId))); setTransfers(balances.transfers); setAccountingWallets(balances.members);
      if (focused) setHistory(focused);
      setLoadFailed(false);
      if (!complete.complete) setError('Financial review is unavailable until the group migration is approved and completed.');
    } catch (failure: unknown) {
      if (account.current === actor && generation.current === pass) setError(failure instanceof Error ? failure.message : 'Connect and refresh financial review.');
    }
  }, [id, sessionMode, user?.id, focusCorrectionId, focusIntentId]);
  useFinancialRefresh(user?.id, id, load);
  useEffect(() => {
    setGroup(null); setCurrent(null); setCorrections([]); setIntents([]); setRequest(null); setSelected(null);
    setHistory(null); setReconciliation(null); setRetry(hasUnresolvedSubmission(mutationScope));
    setHistorical(null); setPastExpenses([]); setBusy(false);
    setJourney(null);
    setMapping(false); setMappingSources([]); setMappingShares([]); setMappingAmounts({}); setCredit(null); setCashTarget(''); setReason('');
    void load(); return () => { generation.current += 1; loadingRequest.current?.abort(); };
  }, [load, mutationScope]);
  const run = async (work: (token: string, valid: () => boolean) => Promise<void>) => {
    if (submitting.current) return;
    submitting.current = true;
    const actor = user?.id, pass = generation.current;
    const valid = () => account.current === actor && scope.current === id && generation.current === pass;
    setBusy(true); setError('');
    try {
      await requireFinancialConnection(sessionMode);
      if (!valid()) return;
      const token = await getToken();
      if (!token || !valid()) return;
      await work(token, valid);
      if (valid()) { setBusy(false); await load(); }
    } catch (failure: unknown) {
      if (valid()) { setError(failure instanceof Error ? failure.message : 'The review changed. Refresh and review again.');
        setRetry(hasUnresolvedSubmission(mutationScope)); }
    } finally { submitting.current = false; if (valid()) setBusy(false); }
  };
  const mutate = (path: string, body: Record<string, unknown>, token: string) => {
    const actor = user?.id, pass = generation.current;
    return reviewedMutation(mutationScope, path, body, token,
      () => account.current === actor && scope.current === id && generation.current === pass);
  };
  const correctionAction = (row: Correction, action: string, personId?: string) => void run(async token => {
    await mutate(`/trips/${id}/corrections/${row.id}/actions`, { expected_version: row.version,
      plan_hash: row.plan_hash, action, reason, ...(personId ? { person_id: personId } : {}) }, token);
  });
  const select = (row: CoveragePerson, source?: string) => {
    if (!source) {
      setJourney({ mode: 'direct', shares: [{ share_id: row.id, amount: row.actionable_amount ?? row.known_uncovered_amount }],
        fromWallet: row.debtor_wallet_id, toWallet: row.creditor_wallet_id });
      return;
    }
    setSelected(row); setCredit(source); setReconciliation(null);
    setAmount(row.actionable_amount ?? row.known_uncovered_amount);
  };
  const allShares = Object.values(current?.details ?? {}).flatMap(row => row.participants);
  const openGroup = (transfer: Transfer) => {
    setJourney({ mode: 'group', transfer });
  };
  return <Screen edges={['left', 'right', 'bottom']} onRefresh={() => void load()} refreshing={busy} testID="financial-review-screen">
    <T variant="h2">Financial review</T>
    {(retry || recovery.pending) && <Button label="Check or retry previous submission" disabled={busy || sessionMode !== 'online'}
      onPress={() => void run(async (token, valid) => {
        await retryReviewedMutation(mutationScope, token, valid); if (valid()) setRetry(false);
      })} testID="financial-review-retry-submission" />}
    <T muted>Review shares and received money separately. Viewing this screen never settles an expense.</T>
    {group?.archived_at ? <T>Group archived. History remains available. The owner must review a compensating reversal before new financial actions.</T> : null}
    {error ? <T accessibilityRole="alert" color={colors.danger}>{error}</T> : null}
    {recovery.error ? <T accessibilityRole="alert">{recovery.error}</T> : null}
    <Input label="Review or admin override reason" value={reason} onChangeText={setReason} multiline />
    {group?.owner_id !== user?.id && myPeople.map(person => <Button key={person} label="Review leaving this group"
      variant="secondary" onPress={() => {
        const wallet = group?.members.find(row => people(row).some(value => value.id === person));
        setRequest({ operation: 'leave_group', target_id: person, changes: { dissolve_family: wallet?.kind === 'family' && people(wallet).length === 1 } });
      }} />)}
    <T variant="h3">Group payment recommendations</T>
    {transfers.map(row => <Card key={`${row.from_member_id}:${row.to_member_id}`}>
      <T>{names[row.from_member_id] ?? 'Historical wallet'} → {names[row.to_member_id] ?? 'Historical wallet'}: {row.amount} {current?.currency}</T>
      <Button label="Review group cash and dependent expenses" disabled={busy || loadFailed || uncertainShares.size > 0 || !recovery.ready || recovery.pending || !current?.availability.new_starts_available}
        variant="secondary" onPress={() => openGroup(row)} />
    </Card>)}
    {allShares.filter(row => row.participating && Number(row.known_uncovered_amount) > 0).map(row => <Card key={row.id}>
      <T variant="h4">{row.person_name ?? 'Historical participant'}</T>
      <T>{row.known_uncovered_amount} {current?.currency} outstanding · {row.reserved_amount} reserved</T>
      {uncertainShares.has(row.id) && <T>Check the expired or canceled UPI work before paying this share again.</T>}
      <Button label="Review payment" disabled={busy || loadFailed || uncertainShares.has(row.id) || !recovery.ready || recovery.pending || !current?.availability.new_starts_available || !row.actionable_amount || row.actionable_amount === '0'}
        onPress={() => select(row)} variant="secondary" />
      <Button label="Preview zero-money offset" disabled={busy || loadFailed || !recovery.ready || recovery.pending || !current?.availability.new_starts_available}
        variant="ghost" onPress={() => setJourney({ mode: 'offset', shares: [{ share_id: row.id, amount: row.known_uncovered_amount }],
          fromWallet: row.debtor_wallet_id, toWallet: row.creditor_wallet_id })} />
    </Card>)}
    <T variant="h3">Retained received money</T>
    {admin && <Button label="Review group credit or historical offset mappings" variant="secondary" onPress={() => {
      setMapping(true); setMappingSources([]); setMappingShares([]); setMappingAmounts({}); setReconciliation(null);
    }} />}
    {(current?.unapplied_credit ?? []).map(row => <Card key={row.source_id}>
      <T>{names[row.payer_wallet_id] ?? 'Historical payer'} → {names[row.receiver_wallet_id] ?? 'Historical receiver'}: {row.amount} {current?.currency} credit</T>
      {admin ? <>
        <Button label="Correct payment record" variant="secondary" onPress={() => { setCashTarget(row.source_id); setCashAmount(row.amount); }} />
        <Button label="Void recorded money" variant="destructive" onPress={() => setRequest({ operation: 'void_cash', target_id: row.source_id, changes: {} })} />
        {allShares.filter(share => share.debtor_wallet_id === row.payer_wallet_id && share.creditor_wallet_id === row.receiver_wallet_id
          && Number(share.known_uncovered_amount) > 0).map(share => <Button key={share.id} label={`Review allocation to ${share.person_name ?? 'historical share'}`}
            variant="ghost" onPress={() => select(share, row.source_id)} />)}
      </> : null}
    </Card>)}
    <T variant="h3">Reports and offset approvals</T>
    {group && user && intents.map(row => <Card key={row.id} testID={row.id === focusIntentId ? 'focused-review-intent' : undefined}>
      <ReviewedIntentPanel trip={{ ...group, id }} row={row} accountId={user.id} sessionMode={sessionMode}
        isAdmin={admin} scope={mutationScope} live={sessionMode === 'online' && !!current?.complete && !loadFailed}
        expenseNames={{}} onComplete={load} onAdminReview={() => setError('Review retained credit and correction options on this page.')} />
      {admin && row.cash_legs.filter(leg => leg.source_id).map(leg => <Button key={leg.id} label="Correct confirmed payment record"
        variant="ghost" onPress={() => { setCashTarget(leg.source_id!); setCashAmount(leg.amount); }} />)}
      {row.coverage_event_id && row.allocation_status === 'applied' && <Button label="Review coverage reversal" variant="secondary" onPress={() => setRequest({
        operation: 'reverse_allocation', target_id: row.coverage_event_id!, changes: {} })} />}
    </Card>)}
    <T variant="h3">Correction history</T>
    {corrections.map(row => <Card key={row.id} testID={row.id === focusCorrectionId ? 'focused-correction' : undefined}>
      <T variant="h4">{row.operation.replaceAll('_', ' ')} · {row.status.replaceAll('_', ' ')}</T><T>{row.reason}</T>
      <Button label="View effects and attributed history" variant="ghost" onPress={() => void run(async (token, valid) => {
        const result = await api<Correction>(`/trips/${id}/corrections/${row.id}`, { authToken: token });
        if (valid()) setHistory(result);
      })} />
      {row.status === 'awaiting_approval' ? <>
        {admin && <><Button label="Approve correction" disabled={!reason.trim()} onPress={() => correctionAction(row, 'approve')} />
          <Button label="Reject correction" variant="destructive" disabled={!reason.trim()} onPress={() => correctionAction(row, 'reject')} /></>}
        {row.required_person_ids.filter(person => myPeople.includes(person)).map(person => <Button key={person} label="Approve my reversal" onPress={() => correctionAction(row, 'consent', person)} />)}
        {(admin || row.created_by === user?.id) && <Button label="Withdraw proposal" variant="ghost" onPress={() => correctionAction(row, 'withdraw')} />}
        {(admin || row.created_by === user?.id) && <Button label="Renew review after expiry or changes" variant="secondary" onPress={() => void run(async (token, valid) => {
          const detail = await api<Correction>(`/trips/${id}/corrections/${row.id}`, { authToken: token });
          if (!detail.renewal_request) throw new Error('The original review is unavailable. Start a new correction.');
          if (valid()) setRequest({ ...detail.renewal_request,
            renewal: { id: detail.id, version: detail.version, plan_hash: detail.plan_hash } });
        })} />}
      </> : null}
      {admin && row.status === 'applied' && ['replace_expense', 'void_expense', 'replace_cash', 'void_cash', 'update_member', 'reassign_family', 'archive_trip'].includes(row.operation)
        && <Button label="Review compensating reversal" variant="secondary" onPress={() => setRequest({ operation: 'reverse_correction', target_id: row.id, changes: {} })} />}
    </Card>)}
    {admin && group ? <Card>
      <Button label="Review historical reconciliation report" variant="secondary" onPress={() => void run(async (token, valid) => {
        const result = await api<HistoryReport>(`/trips/${id}/historical-reconciliation`, { authToken: token });
        if (valid()) setHistorical(result);
      })} />
      <T variant="h3">Move a person to a family</T><T>Earlier expenses keep their original wallet and people. Reallocate past expenses through a separate correction.</T>
      {(group.members.flatMap(people)).map(person => <Button key={person.id} label={`${person.id === movePerson ? 'Selected: ' : ''}${person.name}`}
        variant="ghost" onPress={() => setMovePerson(person.id)} />)}
      {group.members.filter(wallet => wallet.kind === 'family').map(wallet => <Button key={wallet.id} label={`${wallet.id === moveWallet ? 'Selected: ' : ''}Move into ${wallet.name}`}
        variant="ghost" onPress={() => setMoveWallet(wallet.id)} />)}
      <Button label="Review family reassignment" disabled={!movePerson || !moveWallet} onPress={() => {
        const origin = group.members.find(wallet => people(wallet).some(person => person.id === movePerson));
        if (origin) setRequest({ operation: 'reassign_family', target_id: origin.id, changes: { person_id: movePerson, destination_wallet_id: moveWallet } });
      }} />
      <Input label="Link selected person to their app Gmail" value={linkEmail} onChangeText={setLinkEmail} autoCapitalize="none" keyboardType="email-address" />
      <Button label="Review account link" disabled={!movePerson || !linkEmail.trim()} onPress={() => {
        const origin = group.members.find(wallet => people(wallet).some(person => person.id === movePerson));
        if (origin) setRequest({ operation: 'link_person', target_id: origin.id, changes: { person_id: movePerson, email: linkEmail.trim() } });
      }} />
      <T variant="h4">Explicitly reallocate past expenses</T>
      {(current?.expenses ?? []).map(row => <Button key={row.expense_id} variant="ghost"
        label={`${pastExpenses.includes(row.expense_id) ? 'Selected: ' : ''}Expense ${row.expense_id.slice(0, 8)}`}
        onPress={() => setPastExpenses(previous => previous.includes(row.expense_id) ? previous.filter(value => value !== row.expense_id) : [...previous, row.expense_id])} />)}
      <Button label="Preview past-allocation correction" disabled={!pastExpenses.length} onPress={() => setRequest({
        operation: 'reallocate_history', target_id: id, changes: { expense_ids: pastExpenses } })} />
    </Card> : null}
    <Sheet visible={!!journey} onClose={() => setJourney(null)} title="Review payment and coverage" closeLabel="Close settlement journey" trapFocus>
      {journey && group && user && current?.snapshot_id && <ReviewedSettlementFlow key={JSON.stringify(journey)} trip={{ ...group, id }} accountId={user.id}
        sessionMode={sessionMode} scope={mutationScope} selection={journey} snapshotId={current.snapshot_id}
        live={sessionMode === 'online' && !loadFailed} isAdmin={admin} expenseNames={{}}
        shareDescriptions={Object.fromEntries(allShares.map(share => [share.id, `${share.expense_id ?? 'Expense'} · ${share.person_name ?? 'Historical participant'}`]))}
        onComplete={load} onBack={() => setJourney(null)} onCommitted={() => setJourney(null)}
        onAdminReview={() => setJourney(null)} />}
    </Sheet>
    <Sheet visible={!!cashTarget} onClose={() => setCashTarget('')} title="Correct payment record" closeLabel="Close payment correction" trapFocus>
      <Input label="Correct recorded whole amount" value={cashAmount} onChangeText={setCashAmount} keyboardType="numeric" />
      <T>The original receipt stays in history. An actual returned payment must be reported and confirmed separately.</T>
      <Button label="Preview correction" onPress={() => { setRequest({ operation: 'replace_cash', target_id: cashTarget, changes: { amount: cashAmount } }); setCashTarget(''); }} />
    </Sheet>
    <Sheet visible={!!selected} onClose={() => { setSelected(null); setReconciliation(null); }} title="Review retained credit allocation" closeLabel="Close credit allocation review" trapFocus>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 500 }}>
      <View style={{ gap: SPACING.md }}>
        <Input label="Whole amount" value={amount} onChangeText={value => { setAmount(value); setReconciliation(null); }} keyboardType="numeric" />
        <Button label="Preview exact plan" disabled={busy || loadFailed || !amount || !reason.trim()} onPress={() => void run(async (token, valid) => {
          if (!credit || !selected) return;
          const fresh = await coverage(id, [], { authToken: token });
          if (!valid()) return;
          if (!fresh.complete || !fresh.snapshot_id) throw new Error("Refresh current financial review before continuing.");
          const result = await api<ReviewPreview>(`/trips/${id}/reconciliation-previews`, { method: "POST", authToken: token, body: {
            expected_snapshot_id: fresh.snapshot_id, source_ids: [credit], shares: [{ share_id: selected.id, amount }], reason } });
          if (valid()) setReconciliation(result);
        })} />
        {reconciliation ? <><ReviewEffectsView effects={reconciliation.effects} currency={current?.currency ?? ''} />
          <Button label="Apply reviewed credit allocation" disabled={busy} onPress={() => void run(async (token, valid) => {
            await mutate(`/trips/${id}/reconciliations`, { preview_id: reconciliation.id, preview_hash: reconciliation.preview_hash }, token);
            if (valid()) { setSelected(null); setReconciliation(null); }
          })} /></> : null}
      </View>
      </ScrollView>
    </Sheet>
    <Sheet visible={mapping} onClose={() => { setMapping(false); setReconciliation(null); }} title="Review historical allocations" closeLabel="Close historical allocation review" trapFocus>
      <ScrollView style={{ maxHeight: 500 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: SPACING.md }}>
          <T>Choose retained money for a conserving group allocation, or choose shares for a zero-money offset. An admin approval with the stated reason applies only the exact preview.</T>
          <SegmentedControl segments={[{ value: 'group', label: 'Retained group cash' }, { value: 'offset', label: 'Zero-money offset' }]}
            value={mappingMode} onChange={value => { setMappingMode(value); setReconciliation(null); }} />
          {mappingMode === 'group' ? (current?.unapplied_credit ?? []).map(row => <View key={row.source_id}>
            <Button variant="ghost" label={`${mappingSources.includes(row.source_id) ? 'Selected: ' : ''}${names[row.payer_wallet_id] ?? 'Historical payer'} → ${names[row.receiver_wallet_id] ?? 'Historical receiver'}: ${row.amount}`}
              onPress={() => { setMappingSources(previous => previous.includes(row.source_id) ? previous.filter(value => value !== row.source_id) : [...previous, row.source_id]); setReconciliation(null); }} />
            {mappingSources.includes(row.source_id) && <Input label="Amount of retained money to allocate" keyboardType="numeric"
              value={mappingAmounts[row.source_id] ?? row.amount} onChangeText={value => { setMappingAmounts(previous => ({ ...previous, [row.source_id]: value })); setReconciliation(null); }} />}
          </View>) : allShares.filter(row => row.participating && Number(row.known_uncovered_amount) > 0).map(row => <Button key={row.id} variant="ghost"
            label={`${mappingShares.includes(row.id) ? 'Selected: ' : ''}${row.person_name ?? 'Historical share'}: ${row.known_uncovered_amount}`}
            onPress={() => { setMappingShares(previous => previous.includes(row.id) ? previous.filter(value => value !== row.id) : [...previous, row.id]); setReconciliation(null); }} />)}
          <Button label="Preview historical mapping" disabled={busy || !reason.trim() || !(mappingMode === 'group' ? mappingSources.length : mappingShares.length)}
            onPress={() => void run(async (token, valid) => {
              const fresh = await coverage(id, [], { authToken: token });
              if (!valid()) return;
              if (!fresh.complete || !fresh.snapshot_id) throw new Error('Refresh financial review first.');
              const legs = new Map<string, Transfer>();
              for (const source of current?.unapplied_credit ?? []) {
                if (!mappingSources.includes(source.source_id)) continue;
                const value = mappingAmounts[source.source_id] ?? source.amount;
                if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0 || Number(value) > Number(source.amount))
                  throw new Error('Choose a positive whole amount within each retained source.');
                const key = `${source.payer_wallet_id}:${source.receiver_wallet_id}`;
                const existing = legs.get(key);
                legs.set(key, { from_member_id: source.payer_wallet_id, to_member_id: source.receiver_wallet_id, amount: String(Number(existing?.amount ?? 0) + Number(value)) });
              }
              const result = await api<ReviewPreview>(`/trips/${id}/reconciliation-previews`, { method: 'POST', authToken: token, body: {
                mode: mappingMode, expected_snapshot_id: fresh.snapshot_id, reason,
                source_ids: mappingMode === 'group' ? mappingSources : [], cash_legs: mappingMode === 'group' ? [...legs.values()] : [],
                shares: mappingMode === 'offset' ? allShares.filter(row => mappingShares.includes(row.id)).map(row => ({ share_id: row.id, amount: row.known_uncovered_amount })) : [],
              } });
              if (valid()) setReconciliation(result);
            })} />
          {reconciliation && <><ReviewEffectsView effects={reconciliation.effects} currency={current?.currency ?? ''} names={names} />
            <Button label="Approve exact historical mapping as admin" disabled={busy} onPress={() => void run(async (token, valid) => {
              await mutate(`/trips/${id}/reconciliations`, { preview_id: reconciliation.id, preview_hash: reconciliation.preview_hash }, token);
              if (valid()) { setMapping(false); setReconciliation(null); }
            })} /></>}
        </View>
      </ScrollView>
    </Sheet>
    <Sheet visible={!!history} onClose={() => setHistory(null)} title="Correction effects and history" closeLabel="Close correction history" trapFocus>
      <ScrollView style={{ maxHeight: 500 }}>
      {history && <><ReviewEffectsView effects={history.effects} currency={current?.currency ?? ''} names={names} />
        {history.action_history?.map((action, index) => <T key={index}>{action.actor_name_snapshot ?? 'Group reviewer'}: {action.operation} · {action.reason} · {action.created_at}</T>)}</>}
      </ScrollView>
    </Sheet>
    <Sheet visible={!!historical} onClose={() => setHistorical(null)} title="Historical reconciliation report" closeLabel="Close historical report" trapFocus>
      <ScrollView style={{ maxHeight: 500 }}>
        {historical && <>
          <T>{historical.activation_blocked ? 'Review required before activation' : 'No accounting blockers found; activation still requires separate authorization.'}</T>
          {Object.entries(historical.counts).map(([key, value]) => <T key={key}>{key}: {value}</T>)}
          {Object.entries(historical.baseline_wallet_vector).map(([wallet, value]) => <T key={wallet}>{names[wallet] ?? 'Historical wallet'}: {value}; proposed difference {historical.reconciliation_difference[wallet] ?? '0'}</T>)}
          {historical.review_cases.map((item, index) => <T key={index}>Review: {item.code.replaceAll('_', ' ')}</T>)}
          <T>{historical.index_prerequisites.length} index prerequisites; {historical.source_link_duplicates.length} duplicate source links.</T>
          <T>This report changes no accounting records. Migration and activation are separate operator actions.</T>
        </>}
      </ScrollView>
    </Sheet>
    <FinancialReviewSheet tripId={id} request={request} currency={current?.currency ?? group?.currency ?? ''} names={names}
      onClose={() => setRequest(null)} onComplete={() => { setRequest(null); void load(); }} />
  </Screen>;
}
