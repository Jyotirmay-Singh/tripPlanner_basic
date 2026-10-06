import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { api, ApiError, getToken } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import T from '../../../src/T';
import { Screen, Card, Button, Input, Sheet, SegmentedControl } from '../../../src/ui';
import { SPACING } from '../../../src/theme';
import FinancialReviewSheet, { ReviewEffectsView } from '../../../src/FinancialReviewSheet';
import { coverage, completeCoverage, requireFinancialConnection, type Coverage, type CoveragePerson, type Correction,
  type ReviewedIntent, type ReviewRequest, type ReviewPreview } from '../../../src/financialReview';
import { copyUpiId, copyAndLaunchUpiApp, discoverUpiApps, type UpiApp } from '../../../src/upiLauncher';

type Wallet = { id: string; name: string; kind: string; user_id?: string; family_members?: string[];
  family_member_ids?: string[]; family_member_user_ids?: (string | null)[] };
type Group = { currency: string; owner_id: string; admin_ids: string[]; members: Wallet[]; archived_at?: string };
type Transfer = { from_member_id: string; to_member_id: string; amount: number | string };
type ReviewLeg = Transfer & { id: string; dependency: boolean };
type HistoryReport = { plan_hash: string; activation_blocked: boolean; counts: Record<string, number>;
  baseline_wallet_vector: Record<string, string>; reconciliation_difference: Record<string, string>;
  review_cases: { code: string }[]; index_prerequisites: string[]; source_link_duplicates: string[][] };
type Quote = { id: string; quote_hash: string; expires_at: string; plan: { allocation_lines: { amount: string; kind: string; share_id: string }[] };
  cash_legs: { amount: string; actual_payer_person_id: string; actual_receiver_person_id: string }[] };

function people(wallet: Wallet | undefined): { id: string; name: string; user?: string | null }[] {
  if (!wallet) return [];
  return wallet.kind === 'family' ? (wallet.family_member_ids ?? []).map((id, index) => ({ id,
    name: wallet.family_members?.[index] ?? 'Family member', user: wallet.family_member_user_ids?.[index] }))
    : [{ id: wallet.id, name: wallet.name, user: wallet.user_id }];
}

export default function FinancialReview() {
  const { id } = useLocalSearchParams<{ id: string }>();
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
  const [reason, setReason] = useState('');
  const [request, setRequest] = useState<ReviewRequest | null>(null);
  const [cashTarget, setCashTarget] = useState('');
  const [cashAmount, setCashAmount] = useState('');
  const [selected, setSelected] = useState<CoveragePerson | null>(null);
  const [amount, setAmount] = useState('');
  const [payer, setPayer] = useState('');
  const [recipient, setRecipient] = useState('');
  const [method, setMethod] = useState('cash');
  const [quote, setQuote] = useState<Quote | null>(null);
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
  const [groupPayment, setGroupPayment] = useState<Transfer | null>(null);
  const [groupLegs, setGroupLegs] = useState<ReviewLeg[]>([]);
  const [bindings, setBindings] = useState<Record<string, { payer: string; recipient: string }>>({});
  const [upiApps, setUpiApps] = useState<UpiApp[]>([]);
  const mutations = useRef(new Map<string, string>());
  const wallets = [...(group?.members ?? []), ...accountingWallets.filter(wallet => !group?.members.some(row => row.id === wallet.id))];
  const names = Object.fromEntries(wallets.map(row => [row.id, row.name]));
  const admin = !!user && (user.is_super_admin || group?.owner_id === user.id || group?.admin_ids.includes(user.id));
  const myPeople = (group?.members ?? []).flatMap(people).filter(row => row.user === user?.id).map(row => row.id);
  const load = useCallback(async () => {
    const actor = user?.id, pass = ++generation.current;
    loadingRequest.current?.abort();
    const controller = new AbortController(); loadingRequest.current = controller;
    setError('');
    try {
      await requireFinancialConnection(sessionMode);
      const token = await getToken();
      if (!token || account.current !== actor) return;
      const options = { authToken: token, signal: controller.signal, timeoutMs: 15000 };
      const [trip, detailed, rows, work, balances] = await Promise.all([
        api<Group>(`/trips/${id}`, options), coverage(id, [], options),
        api<Correction[]>(`/trips/${id}/corrections`, options),
        api<ReviewedIntent[]>(`/trips/${id}/settlement-intents`, options),
        api<{ transfers: Transfer[]; members: Wallet[] }>(`/trips/${id}/balances`, options),
      ]);
      const complete = detailed.complete ? await completeCoverage(id, options) : detailed;
      if (account.current !== actor || generation.current !== pass) return;
      setGroup(trip); setCurrent(complete); setCorrections(rows); setIntents(work); setTransfers(balances.transfers); setAccountingWallets(balances.members);
      if (!detailed.complete) setError('Financial review is unavailable until the group migration is approved and completed.');
    } catch (failure: unknown) {
      if (account.current === actor && generation.current === pass) setError(failure instanceof Error ? failure.message : 'Connect and refresh financial review.');
    }
  }, [id, sessionMode, user?.id]);
  useEffect(() => { void discoverUpiApps().then(result => setUpiApps(result.apps)); }, []);
  useEffect(() => {
    setGroup(null); setCurrent(null); setCorrections([]); setIntents([]); setRequest(null); setSelected(null);
    setHistory(null); setQuote(null); setReconciliation(null); mutations.current.clear();
    setHistorical(null); setGroupPayment(null); setGroupLegs([]); setBindings({}); setPastExpenses([]); setBusy(false);
    setMapping(false); setMappingSources([]); setMappingShares([]); setMappingAmounts({}); setCredit(null); setCashTarget(''); setReason('');
    void load(); return () => { generation.current += 1; loadingRequest.current?.abort(); };
  }, [load]);
  const run = async (work: (token: string, valid: () => boolean) => Promise<void>) => {
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
      if (valid()) setError(failure instanceof Error ? failure.message : 'The review changed. Refresh and review again.');
    } finally { if (valid()) setBusy(false); }
  };
  const mutate = (path: string, body: Record<string, unknown>, token: string) => {
    const key = JSON.stringify([path, body]);
    if (!mutations.current.has(key)) mutations.current.set(key, Crypto.randomUUID());
    return api<ReviewedIntent>(path, { method: 'POST', authToken: token, timeoutMs: 15000,
      body: { ...body, client_mutation_id: mutations.current.get(key) } });
  };
  const correctionAction = (row: Correction, action: string, personId?: string) => void run(async token => {
    await mutate(`/trips/${id}/corrections/${row.id}/actions`, { expected_version: row.version,
      plan_hash: row.plan_hash, action, reason, ...(personId ? { person_id: personId } : {}) }, token);
  });
  const intentAction = (row: ReviewedIntent, action: string, legId?: string, personId?: string) => void run(async token => {
    await mutate(`/trips/${id}/settlement-intents/${row.id}/approvals`, {
      expected_intent_version: row.version, plan_hash: row.plan.plan_hash, action, reason,
      ...(legId ? { leg_id: legId } : {}), ...(personId ? { person_id: personId } : {}),
    }, token);
  });
  const select = (row: CoveragePerson, source?: string) => {
    setGroupPayment(null); setGroupLegs([]);
    setSelected(row); setCredit(source ?? null); setReconciliation(null); setQuote(null);
    setMethod('cash');
    setAmount(row.actionable_amount ?? row.known_uncovered_amount);
    const wallet = wallets.find(member => member.id === row.debtor_wallet_id);
    setPayer(people(wallet).find(person => person.user === user?.id)?.id ?? people(wallet)[0]?.id ?? '');
    setRecipient(people(wallets.find(member => member.id === row.creditor_wallet_id))[0]?.id ?? '');
  };
  const allShares = Object.values(current?.details ?? {}).flatMap(row => row.participants);
  const openGroup = (transfer: Transfer) => {
    setSelected(null); setCredit(null); setGroupPayment(transfer); setGroupLegs([]); setBindings({}); setQuote(null); setMethod('cash');
    setAmount(String(transfer.amount));
  };
  return <Screen edges={['left', 'right', 'bottom']} onRefresh={() => void load()} refreshing={busy} testID="financial-review-screen">
    <T variant="h2">Financial review</T>
    <T muted>Review shares and received money separately. Viewing this screen never settles an expense.</T>
    {group?.archived_at ? <T>Group archived. History remains available. The owner must review a compensating reversal before new financial actions.</T> : null}
    {error ? <T accessibilityRole="alert" color={colors.danger}>{error}</T> : null}
    <Input label="Review or admin override reason" value={reason} onChangeText={setReason} multiline />
    {group?.owner_id !== user?.id && myPeople.map(person => <Button key={person} label="Review leaving this group"
      variant="secondary" onPress={() => {
        const wallet = group?.members.find(row => people(row).some(value => value.id === person));
        setRequest({ operation: 'leave_group', target_id: person, changes: { dissolve_family: wallet?.kind === 'family' && people(wallet).length === 1 } });
      }} />)}
    <T variant="h3">Group payment recommendations</T>
    {transfers.map(row => <Card key={`${row.from_member_id}:${row.to_member_id}`}>
      <T>{names[row.from_member_id] ?? 'Historical wallet'} → {names[row.to_member_id] ?? 'Historical wallet'}: {row.amount} {current?.currency}</T>
      <Button label="Review group cash and dependent expenses" disabled={busy || !current?.availability.new_starts_available}
        variant="secondary" onPress={() => openGroup(row)} />
    </Card>)}
    {allShares.filter(row => row.participating && Number(row.known_uncovered_amount) > 0).map(row => <Card key={row.id}>
      <T variant="h4">{row.person_name ?? 'Historical participant'}</T>
      <T>{row.known_uncovered_amount} {current?.currency} outstanding · {row.reserved_amount} reserved</T>
      <Button label="Review payment" disabled={busy || !current?.availability.new_starts_available || !row.actionable_amount}
        onPress={() => select(row)} variant="secondary" />
      <Button label="Preview zero-money offset" disabled={busy || !current?.availability.new_starts_available}
        variant="ghost" onPress={() => void run(async (token, valid) => {
          const result = await api<Quote>(`/trips/${id}/settlement-quotes`, { method: 'POST', authToken: token,
            body: { mode: 'offset', method: 'offset', expected_snapshot_id: current?.snapshot_id,
              shares: [{ share_id: row.id, amount: row.known_uncovered_amount }] } });
          if (valid()) { setSelected(row); setCredit(null); setMethod('offset'); setQuote(result); }
        })} />
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
    {intents.map(row => <Card key={row.id}>
      <T variant="h4">{row.mode === 'offset' ? 'Zero-money offset' : `${row.method} payment`} · {row.allocation_status.replaceAll('_', ' ')}</T>
      {row.cash_legs.map(leg => <View key={leg.id} style={{ gap: SPACING.sm }}>
        <T>{leg.amount} {current?.currency}: {leg.receipt_status.replaceAll('_', ' ')}</T>
        {leg.receipt_status === 'initiated' && myPeople.includes(leg.actual_payer_person_id) ? <>
          {row.method === 'upi' && <Button label="Review UPI address before sending" onPress={() => void run(async (token, valid) => {
            const result = await mutate(`/trips/${id}/settlement-intents/${row.id}/legs/${leg.id}/actions`, {
              expected_intent_version: row.version, plan_hash: row.plan.plan_hash, action: 'start', handoff_method: 'copy' }, token);
            const handoff = (result as ReviewedIntent & { handoff?: { upi_id: string; inr_amount: string } }).handoff;
            if (handoff && valid()) {
              const copied = await copyUpiId(handoff.upi_id);
              if (!valid()) return;
              if (!copied.ok) throw new Error(copied.message);
              setError(`UPI address copied. Send exactly ₹${handoff.inr_amount}, then report the payment. Copying does not confirm receipt.`);
            }
          })} />}
          {row.method === 'upi' && upiApps.map(app => <Button key={app.id} label={`Review and open ${app.label}`} variant="secondary"
            onPress={() => void run(async (token, valid) => {
              const result = await mutate(`/trips/${id}/settlement-intents/${row.id}/legs/${leg.id}/actions`, {
                expected_intent_version: row.version, plan_hash: row.plan.plan_hash, action: 'start', handoff_method: app.id }, token);
              const handoff = (result as ReviewedIntent & { handoff?: { upi_id: string } }).handoff;
              if (handoff && valid()) {
                const launched = await copyAndLaunchUpiApp(handoff.upi_id, app);
                if (!launched.ok) throw new Error(launched.message);
              }
            })} />)}
          <Button label="Report payment sent" onPress={() => void run(async token => { await mutate(
            `/trips/${id}/settlement-intents/${row.id}/legs/${leg.id}/actions`, {
              expected_intent_version: row.version, plan_hash: row.plan.plan_hash, action: 'report_paid', note: reason }, token); })} />
        </> : null}
        {(admin || people(group?.members.find(member => member.id === leg.to_member_id)).some(person => person.user === user?.id))
          && ['awaiting_review', 'disputed'].includes(leg.receipt_status) ? <>
            <Button label="Confirm exact money received" onPress={() => intentAction(row, 'confirm_received', leg.id)} />
            <Button label="Report not received" disabled={!reason.trim()} variant="secondary" onPress={() => intentAction(row, 'report_not_received', leg.id)} />
          </> : null}
        {admin && leg.source_id && <Button label="Correct confirmed payment record" variant="ghost" onPress={() => {
          setCashTarget(leg.source_id!); setCashAmount(leg.amount); }} />}
        {leg.receipt_status !== 'approved' && (admin || myPeople.includes(leg.actual_payer_person_id)) &&
          ['needs_review', 'expired', 'canceled'].includes(row.status) && <Button label="Record late payment evidence for review"
            variant="secondary" onPress={() => void run(async token => { await mutate(
              `/trips/${id}/settlement-intents/${row.id}/legs/${leg.id}/actions`, {
                expected_intent_version: row.version, plan_hash: row.plan.plan_hash, action: 'report_paid', note: reason }, token); })} />}
        {admin && leg.receipt_status !== 'approved' && <Button label="Resolve as money not sent" variant="secondary"
          disabled={busy || !reason.trim()} onPress={() => intentAction(row, 'resolve_not_sent', leg.id)} />}
        {leg.source_id?.startsWith('payments:') && (admin || people(group?.members.find(member => member.id === leg.to_member_id)).some(person => person.user === user?.id)) &&
          <Button label="Update payment note" variant="ghost" disabled={busy || !reason.trim()} onPress={() => void run(async token => {
            await api(`/trips/${id}/payments/${leg.source_id!.slice(9)}`, { method: 'PATCH', authToken: token, body: { note: reason } });
          })} />}
      </View>)}
      <T>{row.approvals.filter(a => a.action === 'approved').length} person approval(s) recorded; {row.plan.required_person_ids.length} required.</T>
      {row.plan.required_person_ids.filter(person => myPeople.includes(person)).map(person => <Button key={person} label="Approve my affected shares"
        disabled={busy || row.allocation_status === 'applied'} onPress={() => intentAction(row, 'consent', undefined, person)} />)}
      {admin && row.allocation_status !== 'applied' && <Button label="Approve with admin override" disabled={!reason.trim()} onPress={() => intentAction(row, 'admin_override')} />}
      {row.coverage_event_id && row.allocation_status === 'applied' && <Button label="Reverse coverage" variant="secondary" onPress={() => setRequest({
        operation: 'reverse_allocation', target_id: row.coverage_event_id!, changes: {} })} />}
    </Card>)}
    <T variant="h3">Correction history</T>
    {corrections.map(row => <Card key={row.id}>
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
    <Sheet visible={!!cashTarget} onClose={() => setCashTarget('')} title="Correct payment record" closeLabel="Close payment correction" trapFocus>
      <Input label="Correct recorded whole amount" value={cashAmount} onChangeText={setCashAmount} keyboardType="numeric" />
      <T>The original receipt stays in history. An actual returned payment must be reported and confirmed separately.</T>
      <Button label="Preview correction" onPress={() => { setRequest({ operation: 'replace_cash', target_id: cashTarget, changes: { amount: cashAmount } }); setCashTarget(''); }} />
    </Sheet>
    <Sheet visible={!!selected || !!groupPayment} onClose={() => { setSelected(null); setGroupPayment(null); setQuote(null); }} title={credit ? 'Review retained credit allocation' : 'Review payment or offset'} closeLabel="Close payment review" trapFocus>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 500 }}>
      <View style={{ gap: SPACING.md }}>
        <Input label="Whole amount" value={amount} onChangeText={value => { setAmount(value); setQuote(null); setReconciliation(null); }} keyboardType="numeric" />
        {!credit && method !== 'offset' ? <>
          <SegmentedControl segments={[{ value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank' }, { value: 'upi', label: 'UPI' }]} value={method} onChange={value => { setMethod(value); setQuote(null); }} />
          {!groupPayment && <><T>Actual paying person</T>{people(wallets.find(wallet => wallet.id === selected?.debtor_wallet_id)).map(person => <Button key={person.id} label={`${payer === person.id ? 'Selected: ' : ''}${person.name}`}
            variant="ghost" onPress={() => { setPayer(person.id); setQuote(null); }} />)}
          <T>Actual receiving person</T>{people(wallets.find(wallet => wallet.id === selected?.creditor_wallet_id)).map(person => <Button key={person.id} label={`${recipient === person.id ? 'Selected: ' : ''}${person.name}`}
            variant="ghost" onPress={() => { setRecipient(person.id); setQuote(null); }} />)}</>}
          {groupLegs.map(leg => <View key={leg.id}>
            <T>{leg.dependency ? 'Dependent payment' : 'Selected payment'}: {leg.amount} {current?.currency}</T>
            <T>Actual paying person</T>{people(wallets.find(wallet => wallet.id === leg.from_member_id)).map(person => <Button key={person.id}
              label={`${bindings[leg.id]?.payer === person.id ? 'Selected: ' : ''}${person.name}`} variant="ghost" onPress={() => {
                setBindings(previous => ({ ...previous, [leg.id]: { ...previous[leg.id], payer: person.id } })); setQuote(null);
              }} />)}
            <T>Actual receiving person</T>{people(wallets.find(wallet => wallet.id === leg.to_member_id)).map(person => <Button key={person.id}
              label={`${bindings[leg.id]?.recipient === person.id ? 'Selected: ' : ''}${person.name}`} variant="ghost" onPress={() => {
                setBindings(previous => ({ ...previous, [leg.id]: { ...previous[leg.id], recipient: person.id } })); setQuote(null);
              }} />)}
          </View>)}
        </> : null}
        <Button label="Preview exact plan" disabled={busy || !amount || (credit !== null && !reason.trim())} onPress={() => void run(async (token, valid) => {
          if (!selected && !groupPayment) return;
          const fresh = await coverage(id, [], { authToken: token });
          if (!valid()) return;
          if (!fresh.complete || !fresh.snapshot_id) throw new Error('Refresh current financial review before continuing.');
          if (groupPayment) {
            const body = { expected_snapshot_id: fresh.snapshot_id, mode: 'group', method,
              cash_legs: [{ ...groupPayment, amount }], parties: groupLegs.map(leg => ({ from_member_id: leg.from_member_id,
                to_member_id: leg.to_member_id, payer_person_id: bindings[leg.id]?.payer, recipient_person_id: bindings[leg.id]?.recipient })) };
            try {
              const result = await api<Quote>(`/trips/${id}/settlement-quotes`, { method: 'POST', authToken: token, body });
              if (valid()) setQuote(result);
            } catch (failure) {
              if (!(failure instanceof ApiError) || failure.detailCode !== 'cash_party_binding_required') throw failure;
              const detail = failure.data as { detail: { cash_legs: ReviewLeg[] } };
              if (valid()) { setGroupLegs(detail.detail.cash_legs); setBindings({}); }
            }
          } else if (credit && selected) {
            const result = await api<ReviewPreview>(`/trips/${id}/reconciliation-previews`, { method: 'POST', authToken: token, body: {
              expected_snapshot_id: fresh.snapshot_id, source_ids: [credit], shares: [{ share_id: selected.id, amount }], reason } });
            if (valid()) setReconciliation(result);
          } else if (selected) {
            const result = await api<Quote>(`/trips/${id}/settlement-quotes`, { method: 'POST', authToken: token, body: {
              expected_snapshot_id: fresh.snapshot_id, mode: method === 'offset' ? 'offset' : 'direct', method,
              shares: [{ share_id: selected.id, amount }], parties: method === 'offset' ? [] : [{
                from_member_id: selected.debtor_wallet_id, to_member_id: selected.creditor_wallet_id, payer_person_id: payer, recipient_person_id: recipient }] } });
            if (valid()) setQuote(result);
          }
        })} />
        {quote ? <><T>{quote.plan.allocation_lines.map(line => `${line.amount} ${current?.currency} ${line.kind.replaceAll('_', ' ')}`).join('\n')}</T>
          <T>{method === 'offset' ? 'This offset needs all affected people or a reasoned admin override.' : 'Submitting reports money or starts sending instructions. Receipt and allocation approvals are separate.'}</T>
          <Button label={method === 'offset' ? 'Submit offset for approval' : method === 'upi' ? 'Create reviewed sending instructions' : 'Report this exact payment'} disabled={busy}
            onPress={() => void run(async (token, valid) => {
              if (Date.parse(quote.expires_at) <= Date.now()) throw new Error('Quote expired. Preview again.');
              await mutate(`/trips/${id}/payments`, { protocol_version: 2, quote_id: quote.id, quote_hash: quote.quote_hash,
                submission_action: method === 'offset' || method === 'upi' ? 'propose' : 'report_paid', note: reason }, token);
              if (valid()) { setSelected(null); setGroupPayment(null); setQuote(null); }
            })} /></> : null}
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
