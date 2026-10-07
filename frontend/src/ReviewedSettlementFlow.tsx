import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api, getToken } from './api';
import { completeCoverage, coverage, requireFinancialConnection, type Coverage, type ReviewedIntent } from './financialReview';
import { settlementError, settlementMoney, sumAmounts, units, validCoverage, walletPeople, type SettlementTrip, type SettlementTransfer } from './expenseSettlement';
import { createReviewedQuote, hasUnresolvedSubmission, reviewedMutation, retryReviewedMutation,
  type QuoteLeg, type SettlementMethod, type SettlementQuote } from './reviewedSettlement';
import ReviewedIntentPanel from './ReviewedIntentPanel';
import useReviewedRecovery from './useReviewedRecovery';
import T from './T';
import Button from './ui/Button';
import Input from './ui/Input';
import { SPACING } from './theme';
import { validateTransactionReference } from './payments';
import { canRecordPayment } from './permissions';

export type SettlementSelection = { mode: 'direct' | 'offset'; shares: { share_id: string; amount: string }[];
  fromWallet: string; toWallet: string; recipientPerson?: string | null }
  | { mode: 'group'; transfer: SettlementTransfer };

export default function ReviewedSettlementFlow({ trip, accountId, sessionMode, scope, selection, snapshotId,
  live, isAdmin, expenseNames, shareDescriptions, onComplete, onBack, onAdminReview, onCommitted }: {
  trip: SettlementTrip; accountId: string; sessionMode: string; scope: string; selection: SettlementSelection;
  snapshotId: string; live: boolean; isAdmin: boolean; expenseNames: Record<string, string>;
  shareDescriptions: Record<string, string>;
  onComplete: () => void | Promise<void>; onBack: () => void; onAdminReview: () => void;
  onCommitted?: (intent: ReviewedIntent) => void;
}) {
  const [method, setMethod] = useState<SettlementMethod>(selection.mode === 'offset' ? 'offset' : 'upi');
  const [quote, setQuote] = useState<SettlementQuote | null>(null);
  const [explanationData, setExplanationData] = useState<Coverage | null>(null);
  const [committed, setCommitted] = useState<ReviewedIntent | null>(null);
  const [amount, setAmount] = useState(selection.mode === 'group' ? String(selection.transfer.amount) : '');
  const initialFrom = selection.mode === 'group' ? selection.transfer.from_member_id : selection.fromWallet;
  const initialTo = selection.mode === 'group' ? selection.transfer.to_member_id : selection.toWallet;
  const [legs, setLegs] = useState<QuoteLeg[]>(selection.mode === 'offset' ? [] : [{ id: 'selected', from_member_id: initialFrom,
    to_member_id: initialTo, amount: selection.mode === 'group' ? String(selection.transfer.amount) : sumAmounts(selection.shares.map(row => row.amount))! }]);
  const defaultParty = (from: string, to: string, recipient?: string | null) => {
    const payers = walletPeople(trip.members.find(wallet => wallet.id === from));
    const recipients = walletPeople(trip.members.find(wallet => wallet.id === to));
    return { payer: payers.find(person => person.userId === accountId)?.id ?? (payers.length === 1 ? payers[0].id : ''),
      recipient: recipients.some(person => person.id === recipient) ? recipient! : recipients.length === 1 ? recipients[0].id : '' };
  };
  const pairKey = (leg: QuoteLeg) => `${leg.from_member_id}:${leg.to_member_id}`;
  const [bindings, setBindings] = useState<Record<string, { payer: string; recipient: string }>>({
    [`${initialFrom}:${initialTo}`]: defaultParty(initialFrom, initialTo, selection.mode === 'group' ? null : selection.recipientPerson),
  });
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const recovery = useReviewedRecovery(scope);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(hasUnresolvedSubmission(scope));
  const [clock, setClock] = useState(Date.now());
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const liveRef = useRef(live); liveRef.current = live;
  const snapshotRef = useRef(snapshotId); snapshotRef.current = snapshotId;
  const epoch = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { epoch.current += 1; readAbort.current?.abort(); }, []);
  useEffect(() => { epoch.current += 1; readAbort.current?.abort(); setQuote(null); setBusy(false); }, [scope, sessionMode, snapshotId]);
  useEffect(() => { setNote(''); setReference(''); setCommitted(null); setError(''); }, [scope]);
  useEffect(() => {
    if (!quote) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote]);
  const people = trip.members.flatMap(walletPeople);
  const personName = (id?: string) => people.find(person => person.id === id)?.name ?? 'Historical person (name unavailable)';
  const walletName = (id: string) => trip.members.find(wallet => wallet.id === id)?.name ?? 'Historical wallet';
  const disabled = busy || !live || retry || !recovery.ready || recovery.pending;
  const expired = quote ? Date.parse(quote.expires_at) <= clock : false;
  const change = (work: () => void) => { if (!disabled) { work(); setQuote(null); setError(''); } };
  const run = async (work: (token: string, valid: () => boolean, signal: AbortSignal) => Promise<void>) => {
    if (busyRef.current || !live) return;
    busyRef.current = true; setBusy(true); setError('');
    const pass = epoch.current;
    const controller = new AbortController(); readAbort.current = controller;
    const valid = () => epoch.current === pass && scopeRef.current === scope && liveRef.current && snapshotRef.current === snapshotId && !controller.signal.aborted;
    try {
      await requireFinancialConnection(sessionMode);
      const token = await getToken();
      if (!token || !valid()) return;
      await work(token, valid, controller.signal);
    } catch (failure) { if (valid()) { setError(settlementError(failure)); setRetry(hasUnresolvedSubmission(scope)); } }
    finally { busyRef.current = false; if (valid()) setBusy(false); }
  };
  const preview = () => void run(async (token, valid, signal) => {
    if (selection.mode === 'group' && (!(units(amount) && units(amount)! > 0n)
      || units(amount)! > (units(String(selection.transfer.amount)) ?? 0n))) throw new Error('Enter a positive whole amount within the suggested group payment.');
    const fresh = selection.mode === 'direct' ? await coverage(trip.id, [], { authToken: token, signal })
      : await completeCoverage(trip.id, { authToken: token, signal });
    if (!valid()) return;
    if (!validCoverage(fresh) || fresh.snapshot_id !== snapshotId || !fresh.availability.new_starts_available) {
      setQuote(null); await onComplete(); throw new Error('Settlement changed. Return to the shares and review the current amounts.');
    }
    setExplanationData(fresh);
    try {
      const result = await createReviewedQuote(trip.id, {
        mode: selection.mode, method, expected_snapshot_id: snapshotId,
        ...(selection.mode === 'group' ? { cash_legs: [{ ...selection.transfer, amount }] } : { shares: selection.shares }),
        parties: selection.mode === 'offset' ? [] : legs.map(leg => ({ from_member_id: leg.from_member_id, to_member_id: leg.to_member_id,
          payer_person_id: bindings[pairKey(leg)]?.payer ?? '', recipient_person_id: bindings[pairKey(leg)]?.recipient ?? '' })),
      }, token, signal);
      if (valid()) { setQuote(result); setClock(Date.now()); }
    } catch (failure) {
      if ((failure as { detailCode?: string }).detailCode !== 'cash_party_binding_required') throw failure;
      const required = (failure as { data?: { detail?: { cash_legs?: QuoteLeg[] } } }).data?.detail?.cash_legs;
      if (!required || !valid()) throw failure;
      setLegs(required);
      setBindings(previous => Object.fromEntries(required.map(leg => [pairKey(leg), previous[pairKey(leg)] ?? defaultParty(leg.from_member_id, leg.to_member_id)])));
      setError('This group payment depends on other payments. Choose and review every actual payer and recipient, then preview again.');
    }
  });
  if (committed) return <View style={{ gap: SPACING.md }}>
    <ReviewedIntentPanel trip={trip} row={committed} accountId={accountId} sessionMode={sessionMode} isAdmin={isAdmin} scope={scope} live={live}
      expenseNames={expenseNames}
      onComplete={async () => { const pass = epoch.current; await onComplete(); const token = await getToken();
        if (token && pass === epoch.current && liveRef.current && scopeRef.current === scope) {
          const latest = await api<ReviewedIntent>(`/trips/${trip.id}/settlement-intents/${committed.id}`, { authToken: token, signal: readAbort.current?.signal });
          if (pass === epoch.current && scopeRef.current === scope) setCommitted(latest);
        }
      }} onAdminReview={onAdminReview} />
    <Button label="Back to shares" variant="ghost" onPress={onBack} testID="settlement-flow-back" />
  </View>;
  const labels = new Map<string, string>(Object.entries(shareDescriptions));
  Object.entries(explanationData?.details ?? {}).forEach(([id, detail]) => detail.participants.forEach(row =>
    labels.set(row.id, `${expenseNames[id] ?? 'Historical expense'} · ${row.person_name ?? 'Historical participant'}`)));
  quote?.review_context?.forEach(line => labels.set(line.share_id,
    `${line.expense_description || line.category || 'Expense description unavailable'} · ${line.person_name ?? 'Historical participant'}${line.date ? ` · ${line.date}` : ''}`));
  return <View style={{ gap: SPACING.md }} testID="reviewed-settlement-flow">
    <T variant="h3">{selection.mode === 'direct' ? 'Pay this expense' : selection.mode === 'offset' ? 'Propose an offset' : 'Use group settlement'}</T>
    {selection.mode !== 'direct' && <T>Group settlement combines amounts across expenses and may propose offsets. Every affected receipt and share approval must complete before coverage changes. You can return and pay this expense directly.</T>}
    {selection.mode === 'group' && <Input label="Group payment amount" value={amount} onChangeText={value => change(() => setAmount(value))}
      editable={!disabled} keyboardType="numeric" testID="settlement-group-amount" />}
    {selection.mode !== 'offset' && <>
      <T>Payment method</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm }}>
        {(['upi', 'cash', 'bank'] as const).map(value => <Button key={value} label={value === 'upi' ? 'Pay with UPI' : value === 'cash' ? 'Already paid cash' : 'Already paid by bank'}
          variant={method === value ? 'primary' : 'secondary'} disabled={disabled} onPress={() => change(() => setMethod(value))} testID={`settlement-method-${value}`} />)}
      </View>
      {legs.map(leg => <View key={pairKey(leg)} style={{ gap: SPACING.sm }}>
        <T variant="h4">{leg.dependency ? 'Dependent payment' : 'Selected payment'}: {walletName(leg.from_member_id)} pays {walletName(leg.to_member_id)} {settlementMoney(selection.mode === 'group' && !leg.dependency ? amount : leg.amount, trip.currency)}</T>
        <T>Actual paying person</T>
        {walletPeople(trip.members.find(wallet => wallet.id === leg.from_member_id)).map(person => <Button key={person.id}
          label={`${bindings[pairKey(leg)]?.payer === person.id ? 'Selected: ' : ''}${person.name}`} variant="secondary"
          disabled={disabled || (!leg.dependency && person.userId !== accountId && (method === 'upi'
            || (!isAdmin && !canRecordPayment(trip, leg.to_member_id, accountId,
              trip.members.map(wallet => ({ ...wallet, family_member_user_ids: wallet.family_member_user_ids ?? undefined }))))))}
          onPress={() => change(() => setBindings(previous => ({ ...previous, [pairKey(leg)]: { ...previous[pairKey(leg)], payer: person.id } })))}
          testID={`settlement-payer-${leg.id}-${person.id}`} />)}
        <T>Actual receiving person</T>
        {walletPeople(trip.members.find(wallet => wallet.id === leg.to_member_id)).map(person => <Button key={person.id}
          label={`${bindings[pairKey(leg)]?.recipient === person.id ? 'Selected: ' : ''}${person.name}`} variant="secondary" disabled={disabled}
          onPress={() => change(() => setBindings(previous => ({ ...previous, [pairKey(leg)]: { ...previous[pairKey(leg)], recipient: person.id } })))}
          testID={`settlement-recipient-${leg.id}-${person.id}`} />)}
        {!bindings[pairKey(leg)]?.recipient && <T>Choose who receives this payment within the receiving wallet.</T>}
      </View>)}
    </>}
    <Input label="Payment note (optional)" value={note} onChangeText={value => change(() => setNote(value))} editable={!disabled} multiline testID="settlement-note" />
    {(method === 'cash' || method === 'bank') && <Input label="Transaction reference (optional)" value={reference}
      onChangeText={value => change(() => setReference(value))} editable={!disabled} testID="settlement-reference" />}
    <Button label="Review exact payment and coverage" loading={busy} disabled={disabled || legs.some(leg => !bindings[pairKey(leg)]?.payer || !bindings[pairKey(leg)]?.recipient)}
      onPress={preview} testID="settlement-preview" />
    {quote && <View style={{ gap: SPACING.sm }} testID="settlement-quote">
      {quote.cash_legs.map(leg => <View key={leg.id} style={{ gap: SPACING.xs }}>
        <T>{leg.payer?.name ?? personName(leg.actual_payer_person_id)} pays {leg.recipient?.name ?? personName(leg.actual_receiver_person_id)} {settlementMoney(leg.amount, trip.currency)}{leg.dependency ? ' · Dependent payment' : ''}</T>
        {method === 'upi' && <>
          <T>UPI amount: {settlementMoney(leg.inr_amount, 'INR')}</T>
          {leg.upi_id_snapshot ? <T>Recipient UPI: {leg.upi_id_snapshot}</T> : <T>UPI details are restricted to the actual payer or an authorized reviewer.</T>}
          {trip.currency !== 'INR' && <T>Locked conversion rate: {leg.conversion_snapshot?.rate ?? 'See reviewed conversion'}; effective date: {leg.conversion_snapshot?.effective_date ?? 'Shown by the server'}</T>}
        </>}
      </View>)}
      <T variant="h4">Proposed expense coverage</T>
      {quote.plan.allocation_lines.map((line, index) => <T key={index}>{labels.get(line.share_id ?? '') ?? 'Expense share (details unavailable)'}: {settlementMoney(line.amount, trip.currency)} · {line.kind === 'approved_offset' ? 'Proposed offset (not approved)' : line.kind === 'direct' ? 'Direct payment' : 'Group payment'}</T>)}
      {quote.plan.allocation_lines.some(line => !labels.has(line.share_id ?? '')) && <T>Some affected shares could not be identified. Refresh their details before submitting.</T>}
      {quote.plan.required_person_ids.length > 0 && <T>Share approvals required from: {quote.plan.required_person_ids.map(id => personName(id)).join(', ')}. Receiving-family authority cannot approve for other people.</T>}
      <T>{method === 'offset' ? 'Submitting creates a proposal. It does not settle or reserve shares.' : method === 'upi'
        ? 'Create sending instructions, then send and report payment. Only receiver/admin confirmation can establish receipt.'
        : 'Submit only money already paid. This report awaits explicit receiver/admin confirmation.'}</T>
      <T>{expired ? 'Quote expired. Review again.' : `Review expires ${new Date(quote.expires_at).toLocaleTimeString()}`}</T>
      <Button label={method === 'offset' ? 'Submit offset proposal' : method === 'upi' ? 'Create sending instructions' : 'Report payment'}
        loading={busy} disabled={disabled || expired || quote.plan.allocation_lines.some(line => !labels.has(line.share_id ?? ''))} testID="settlement-submit" onPress={() => void run(async (token, valid) => {
          if (Date.parse(quote.expires_at) <= Date.now()) throw new Error('Quote expired. Review again.');
          const referenceCheck = validateTransactionReference(reference);
          if (!referenceCheck.ok) throw new Error(referenceCheck.error);
          const result = await reviewedMutation(scope, `/trips/${trip.id}/settlement-intents`, {
            quote_id: quote.id, quote_hash: quote.quote_hash, submission_action: method === 'upi' || method === 'offset' ? 'propose' : 'report_paid',
            transaction_reference: referenceCheck.value, note: note.trim() || null,
          }, token, valid, quote.intent_id);
          if (valid()) { setCommitted(result); onCommitted?.(result); setQuote(null); await onComplete(); }
        })} />
    </View>}
    {(retry || recovery.pending) && <Button label="Check or retry previous submission" loading={busy} disabled={!live} onPress={() => void run(async (token, valid) => {
      const result = await retryReviewedMutation(scope, token, valid);
      if (valid()) { setCommitted(result); onCommitted?.(result); setRetry(false); setQuote(null); await onComplete(); }
    })} testID="settlement-submit-retry" />}
    {!!error && <T accessibilityRole="alert">{error}</T>}
    {!!recovery.error && <T accessibilityRole="alert">{recovery.error}</T>}
    {!live && <T>Connect and refresh to review or submit this action.</T>}
    <Button label="Back to shares" variant="ghost" disabled={busy} onPress={onBack} testID="settlement-flow-back" />
  </View>;
}
