import React, { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { api, getToken } from './api';
import { completeCoverage, requireFinancialConnection, type ReviewedIntent } from './financialReview';
import { walletPeople, settlementMoney, settlementError, validCoverage, type SettlementTrip } from './expenseSettlement';
import { hasUnresolvedSubmission, reviewedMutation, retryReviewedMutation } from './reviewedSettlement';
import { canRecordPayment } from './permissions';
import { copyUpiId, copyAndLaunchUpiApp, discoverUpiApps, type UpiApp } from './upiLauncher';
import T from './T';
import Button from './ui/Button';
import Input from './ui/Input';
import { SPACING } from './theme';
import { validateTransactionReference } from './payments';
import useReviewedRecovery from './useReviewedRecovery';
import { publishFinancialChange } from './financialRefresh';

export default function ReviewedIntentPanel({ trip, row, accountId, sessionMode, isAdmin, scope, live, expenseNames, onComplete, onAdminReview }: {
  trip: SettlementTrip; row: ReviewedIntent; accountId: string; sessionMode: string; isAdmin: boolean;
  scope: string; live: boolean; expenseNames: Record<string, string>; onComplete: () => void | Promise<void>; onAdminReview: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [notice, setNotice] = useState('');
  const recovery = useReviewedRecovery(scope);
  const [review, setReview] = useState<{ action: string; legId?: string; personId?: string; label: string; app?: UpiApp } | null>(null);
  const [shareLabels, setShareLabels] = useState<Record<string, string> | null>(null);
  const [apps, setApps] = useState<UpiApp[]>([]);
  const [appStatus, setAppStatus] = useState('checking');
  const [history, setHistory] = useState<ReviewedIntent | null>(null);
  const [retry, setRetry] = useState(hasUnresolvedSubmission(scope));
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const liveRef = useRef(live); liveRef.current = live;
  const epoch = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  const waitingForReturn = useRef(false);
  const sawBackground = useRef(false);
  useEffect(() => {
    let active = true;
    void discoverUpiApps().then(value => { if (active) { setApps(value.apps); setAppStatus(value.status ?? 'none'); } })
      .catch(() => { if (active) setAppStatus('discovery_failed'); });
    return () => { active = false; epoch.current += 1; readAbort.current?.abort(); };
  }, []);
  useEffect(() => { epoch.current += 1; setReview(null); setShareLabels(null); setHistory(null); setBusy(false);
    readAbort.current?.abort(); setRetry(hasUnresolvedSubmission(scope)); }, [scope, sessionMode, row.id, row.version]);
  useEffect(() => { setReason(''); setReference(''); setNotice(''); setError('');
    waitingForReturn.current = false; sawBackground.current = false; }, [scope, row.id]);
  useEffect(() => {
    if (!live) return;
    let active = true;
    const controller = new AbortController();
    void getToken().then(token => token ? api<ReviewedIntent>(`/trips/${trip.id}/settlement-intents/${row.id}`,
      { authToken: token, signal: controller.signal }) : null).then(detail => { if (active && detail) setHistory(detail); }).catch(() => {});
    return () => { active = false; controller.abort(); };
  }, [scope, trip.id, row.id, row.version, live]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (!waitingForReturn.current) return;
      if (state !== 'active') { sawBackground.current = true; return; }
      if (sawBackground.current) {
        waitingForReturn.current = false;
        setNotice('You are back. Check the payment app, then choose Payment sent, I did not pay, or Not sure.');
        publishFinancialChange({ accountId, tripId: trip.id, reason: 'upi_return' });
      }
    });
    return () => subscription.remove();
  }, [accountId, trip.id]);
  const people = trip.members.flatMap(walletPeople);
  const mine = people.filter(person => person.userId === accountId).map(person => person.id);
  const personName = (id?: string) => history?.reports?.find(report => report.actual_payer_person_id === id)?.payer_snapshot?.name
    ?? history?.reports?.find(report => report.actual_receiver_person_id === id)?.recipient_snapshot?.name
    ?? people.find(person => person.id === id)?.name ?? 'Historical person (name unavailable)';
  const mayReport = (walletId: string) => isAdmin || canRecordPayment(trip, walletId, accountId,
    trip.members.map(wallet => ({ ...wallet, family_member_user_ids: wallet.family_member_user_ids ?? undefined })));
  const terminal = ['applied', 'reversed'].includes(row.allocation_status) || ['canceled', 'expired', 'rejected'].includes(row.status);
  const blocked = busy || retry || recovery.pending || !recovery.ready;
  const run = async (work: (token: string, valid: () => boolean, signal: AbortSignal) => Promise<void>) => {
    if (busyRef.current || !live) return;
    busyRef.current = true; setBusy(true); setError('');
    const pass = epoch.current;
    const controller = new AbortController(); readAbort.current = controller;
    const valid = () => epoch.current === pass && scopeRef.current === scope && liveRef.current && !controller.signal.aborted;
    try {
      await requireFinancialConnection(sessionMode);
      const token = await getToken();
      if (!token || !valid()) return;
      await work(token, valid, controller.signal);
    } catch (failure) { if (valid()) { setError(settlementError(failure)); setRetry(hasUnresolvedSubmission(scope)); } }
    finally { busyRef.current = false; if (valid()) setBusy(false); }
  };
  const openReview = (next: NonNullable<typeof review>) => void run(async (token, valid, signal) => {
    setReview(null); setShareLabels(null);
    const fresh = await api<ReviewedIntent>(`/trips/${trip.id}/settlement-intents/${row.id}`, { authToken: token, signal });
    if (!valid()) return;
    if (fresh.version !== row.version || fresh.plan.plan_hash !== row.plan.plan_hash) {
      await onComplete(); throw new Error('This report changed. Review the latest details before acting.');
    }
    setHistory(fresh);
    const labels: Record<string, string> = {};
    fresh.review_context?.forEach(line => {
      if (line.person_name && (line.expense_description || line.category)) labels[line.share_id] =
        `${line.expense_description || line.category} · ${line.person_name}${line.date ? ` · ${line.date}` : ''}`;
    });
    if (!fresh.review_context) {
      const effects = await completeCoverage(trip.id, { authToken: token, signal });
      if (!valid()) return;
      if (!validCoverage(effects)) throw new Error('The affected shares are unavailable. Refresh or open financial review.');
      Object.entries(effects.details ?? {}).forEach(([id, detail]) => detail.participants.forEach(person => {
        labels[person.id] = `${expenseNames[id] ?? 'Historical expense (name unavailable)'} · ${person.person_name ?? 'Historical participant (name unavailable)'}`;
      }));
    }
    setShareLabels(labels); setReview(next); setReason(''); setReference('');
  });
  const act = (action: string, legId?: string, personId?: string, app?: UpiApp) => void run(async (token, valid, signal) => {
    const fresh = await api<ReviewedIntent>(`/trips/${trip.id}/settlement-intents/${row.id}`, { authToken: token, signal });
    if (!valid()) return;
    if (fresh.version !== row.version || fresh.plan.plan_hash !== row.plan.plan_hash) {
      setReview(null); await onComplete(); throw new Error('This report changed. Review the latest details before acting.');
    }
    const isLeg = ['start', 'report_paid', 'cancel'].includes(action);
    const referenceCheck = validateTransactionReference(reference);
    if (!referenceCheck.ok) throw new Error(referenceCheck.error);
    const result = await reviewedMutation(scope, isLeg
      ? `/trips/${trip.id}/settlement-intents/${row.id}/legs/${legId}/actions`
      : `/trips/${trip.id}/settlement-intents/${row.id}/approvals`, {
      expected_intent_version: row.version, plan_hash: row.plan.plan_hash, action: action === 'withdraw' ? 'cancel' : action,
      ...(isLeg ? { handoff_method: app?.id ?? 'copy', transaction_reference: action === 'report_paid' ? referenceCheck.value : null, note: reason.trim() || null }
        : { ...(legId ? { leg_id: legId } : {}), ...(personId ? { person_id: personId } : {}), reason: reason.trim() || null }),
    }, token, valid, undefined, { deferRefresh: action === 'start' });
    try {
      if (!valid()) return;
      if (action === 'start') {
        const handoff = (result as ReviewedIntent & { handoff?: { upi_id: string; inr_amount: string; recipient_name: string } }).handoff;
        if (!handoff) throw new Error('Sending details are unavailable. Refresh this report.');
        if (!valid()) return;
        waitingForReturn.current = !!app; sawBackground.current = false;
        const launched = app ? await copyAndLaunchUpiApp(handoff.upi_id, app, { isCurrent: valid }) : await copyUpiId(handoff.upi_id);
        if (!valid()) return;
        setNotice(launched.ok ? `UPI address copied for ${handoff.recipient_name}. Send exactly ${settlementMoney(handoff.inr_amount, 'INR')}. Check what happened before reporting or trying again.` : launched.message);
        if (!launched.ok) waitingForReturn.current = false;
      }
      setReview(null); await onComplete();
    } finally {
      // Refresh other surfaces after the native handoff has finished, so our own start does
      // not invalidate its launch guard while app discovery/clipboard operations are pending.
      if (action === 'start') publishFinancialChange({ accountId, tripId: trip.id, reason: 'mutation' });
    }
  });
  const reviewRequired = !!review && ['report_not_received', 'admin_override', 'resolve_not_sent', 'decline_allocation'].includes(review.action);
  const handoffReport = history?.reports?.find(report => report.settlement_leg_id === review?.legId);
  return <View style={{ gap: SPACING.sm }} testID={`settlement-intent-${row.id}`}>
    <T variant="h4">{row.mode === 'offset' ? 'Offset proposed' : `${row.method.toUpperCase()} payment`}</T>
    <T>{row.allocation_status === 'applied' ? 'Coverage applied' : row.status === 'needs_review' ? 'Needs review'
      : row.mode === 'offset' ? 'A proposal until approved' : 'Receipt and share approvals are separate'}</T>
    {row.mode === 'offset' && <T>No money transferred. This proposal does not reserve shares. Direct payment remains available until an offset is approved.</T>}
    {!!notice && <T accessibilityLiveRegion="polite">{notice}</T>}
    {row.review_reasons?.length ? <T>Review needed: {row.review_reasons.join(', ')}. Check this existing work before any further payment.</T> : null}
    {row.cash_legs.map(leg => <View key={leg.id} style={{ gap: SPACING.sm }}>
      <T>{personName(leg.actual_payer_person_id)} pays {personName(leg.actual_receiver_person_id)} {settlementMoney(leg.amount, trip.currency)}{leg.dependency ? ' · Dependent payment' : ''}</T>
      <T>{leg.receipt_status === 'approved' ? row.allocation_status === 'applied'
        ? row.approvals.some(action => action.leg_id === leg.id && action.action === 'confirmed' && ['owner', 'admin', 'super_admin'].includes(action.actor_role ?? '')) ? 'Admin approved' : 'Receiver confirmed'
        : 'Money received; expense coverage is waiting for the remaining approvals.'
        : leg.receipt_status === 'initiated' ? 'Payment started; receipt not confirmed.'
        : leg.receipt_status === 'awaiting_review' ? 'Awaiting approval; the receiver must confirm receipt.'
        : 'Needs review; no new payment is authorized by this report.'}</T>
      {live && !retry && !recovery.pending && (mine.includes(leg.actual_payer_person_id) || mayReport(leg.to_member_id))
        && ['initiated', 'expired', 'canceled'].includes(leg.receipt_status) && !['applied', 'reversed'].includes(row.allocation_status) && <>
        {mine.includes(leg.actual_payer_person_id) && row.method === 'upi' && !terminal && row.status !== 'needs_review' && <>
          <Button label="Review and copy UPI address" variant="secondary" disabled={blocked} onPress={() => openReview({ action: 'start', legId: leg.id, label: 'Copy reviewed UPI address' })} testID={`settlement-upi-copy-${leg.id}`} />
          {apps.map(app => <Button key={app.id} label={`Review and open ${app.label}`} variant="secondary" disabled={blocked}
            onPress={() => openReview({ action: 'start', legId: leg.id, label: `Copy and open ${app.label}`, app })} testID={`settlement-upi-open-${leg.id}-${app.id}`} />)}
          {!apps.length && <T>{appStatus === 'discovery_failed' ? 'Payment apps could not be checked.'
            : appStatus === 'checking' ? 'Checking available payment apps.' : appStatus === 'unsupported' ? 'Opening payment apps is unavailable on this platform.'
            : 'No supported app is available here.'} Review and copy the address, then complete payment manually.</T>}
        </>}
        <T>Check the payment app or bank before sending again. An expired or interrupted handoff does not prove that money was not sent.</T>
        <Button label="Payment sent" disabled={blocked} onPress={() => openReview({ action: 'report_paid', legId: leg.id, label: 'Submit Payment sent for review' })} testID={`settlement-report-${leg.id}`} />
        {!mine.includes(leg.actual_payer_person_id) && <T>You are reporting on behalf of the paying person. A separate receiver or admin approval is still required.</T>}
        {mine.includes(leg.actual_payer_person_id) && <Button label="I did not pay" variant="ghost" disabled={blocked || (row.status === 'canceled' && !!row.unsent_resolved)} onPress={() => openReview({ action: 'cancel', legId: leg.id, label: 'Confirm I did not pay and cancel this start' })} testID={`settlement-cancel-${leg.id}`} />}
        <Button label="Not sure / check payment app" variant="secondary" disabled={blocked} onPress={() => setNotice('Check your payment app or bank history and ask the receiver. Keep this payment open while uncertain; do not pay again.')} testID={`settlement-unsure-${leg.id}`} />
        <Button label="App did not open / continue manually" variant="ghost" disabled={blocked} onPress={() => setNotice('You can continue manually with the reviewed details. Check for an existing transfer first, then report the outcome here.')} />
      </>}
      {live && !terminal && !retry && ['awaiting_review', 'disputed', 'rejected'].includes(leg.receipt_status)
        && (isAdmin || (!mine.includes(leg.actual_payer_person_id) && canRecordPayment(trip, leg.to_member_id, accountId,
          trip.members.map(wallet => ({ ...wallet, family_member_user_ids: wallet.family_member_user_ids ?? undefined }))))) && <>
        <Button label="Confirm received" disabled={blocked} onPress={() => openReview({ action: 'confirm_received', legId: leg.id, label: 'Confirm this exact receipt' })} testID={`settlement-confirm-${leg.id}`} />
        <Button label="Not received" variant="secondary" disabled={blocked} onPress={() => openReview({ action: 'report_not_received', legId: leg.id, label: 'Report non-receipt' })} testID={`settlement-not-received-${leg.id}`} />
        <Button label="Resolve claim as not sent" variant="ghost" disabled={blocked} onPress={() => openReview({ action: 'resolve_not_sent', legId: leg.id, label: 'Resolve this claim as not sent' })} testID={`settlement-resolve-${leg.id}`} />
      </>}
    </View>)}
    {!terminal && <T>{row.approvals.filter(action => action.scope === 'consent' && action.action === 'approved').length} person approvals recorded; {row.plan.required_person_ids.length} required.</T>}
    {isAdmin && !terminal && row.plan.required_person_ids.some(id => !people.find(person => person.id === id)?.userId)
      && <T>Some required approvers have no current linked account. Obtain their agreement and record a reason if using authorized admin approval.</T>}
    {live && !terminal && !retry && row.plan.required_person_ids.filter(id => mine.includes(id)
      && !row.approvals.some(action => action.person_id === id && action.action === 'approved')).map(id =>
      <View key={id} style={{ gap: SPACING.sm }}><Button label="Review your share approval" variant="secondary" disabled={blocked || row.status === 'needs_review'}
        onPress={() => openReview({ action: 'consent', personId: id, label: 'Approve these exact share allocations' })} testID={`settlement-consent-${id}`} />
        {row.mode === 'offset' && <Button label="Decline this offset" variant="ghost" disabled={blocked || row.status === 'needs_review'}
          onPress={() => openReview({ action: 'decline_allocation', personId: id, label: 'Decline these offset allocations' })} testID={`settlement-decline-${id}`} />}</View>)}
    {live && isAdmin && !terminal && !retry && row.mode !== 'direct' && <Button label="Review admin allocation approval" variant="secondary" disabled={blocked || row.status === 'needs_review'}
      onPress={() => openReview({ action: 'admin_override', label: 'Approve these allocations as admin' })} testID={`settlement-admin-${row.id}`} />}
    {live && row.mode === 'offset' && history?.can_withdraw && <Button label="Withdraw offset proposal" variant="ghost" disabled={blocked}
      onPress={() => openReview({ action: 'withdraw', label: 'Withdraw this unapplied offset proposal' })} testID={`settlement-withdraw-${row.id}`} />}
    {review && <View style={{ gap: SPACING.sm }}>
      <T variant="h4">{review.label}</T>
      {row.cash_legs.filter(leg => !review.legId || leg.id === review.legId).map(leg => <T key={leg.id}>{personName(leg.actual_payer_person_id)} → {personName(leg.actual_receiver_person_id)}: {settlementMoney(leg.amount, trip.currency)} · {row.method.toUpperCase()}{leg.dependency ? ' · Dependent payment' : ''}</T>)}
      {review.action === 'start' && <>
        <T>Recipient UPI: {handoffReport?.upi_id_snapshot ?? 'Unavailable — refresh the receiving details'}</T>
        <T>Send exactly {handoffReport?.amount_paise != null ? settlementMoney(String(handoffReport.amount_paise / 100), 'INR') : 'the reviewed INR amount (unavailable)'}.</T>
        {trip.currency !== 'INR' && <T>Locked conversion rate: {handoffReport?.conversion_snapshot?.rate ?? 'Unavailable'} · effective date: {handoffReport?.conversion_snapshot?.effective_date ?? 'Unavailable'}</T>}
        <T>Paste the copied ID, verify the recipient, enter the displayed INR amount, and authorize inside your payment app. Copying, launching, or returning never confirms receipt.</T>
      </>}
      {review.action !== 'start' && handoffReport && <>
        <T>Reported at: {handoffReport.awaiting_confirmation_at ?? 'Not yet reported'} · Reporting actor: {handoffReport.reporting_actor_snapshot?.name ?? history?.action_history?.find(action => action.actor_user_id === handoffReport.reported_by)?.actor_name_snapshot ?? (handoffReport.reported_by === accountId ? 'You' : 'Name unavailable')}</T>
        <T>Transaction reference: {handoffReport.transaction_reference || 'Not provided'} · Payment note: {handoffReport.note || 'Not provided'}. This is user-entered evidence; check actual receipt before approval.</T>
      </>}
      {row.plan.allocation_lines?.map((line, i) => <T key={i}>{shareLabels?.[line.share_id ?? ''] ?? 'Historical share (details unavailable)'}: {settlementMoney(line.amount, trip.currency)} · {line.kind === 'approved_offset' ? 'Proposed offset' : 'Reviewed allocation'}</T>)}
      {history?.review_context?.map((line, i) => <T variant="caption" key={`context-${i}`}>Frozen share: {line.person_name ?? 'Participant unavailable'} · {settlementMoney(line.original_share, trip.currency)}</T>)}
      {row.plan.allocation_lines?.some(line => !shareLabels?.[line.share_id ?? '']) && <T>Some affected historical shares cannot be identified. Receipt may still be recorded as credit; use financial review to resolve allocations.</T>}
      <T>{row.mode === 'offset' ? 'No money transferred. Approval applies only these exact offsets.' : review.action === 'report_paid'
        ? 'This reports money you already sent. It does not confirm receipt.' : 'Only this reviewed plan applies. Confirming receipt records money received; dependent shares may still await approval.'}</T>
      {review.action !== 'start' && <Input label={reviewRequired ? 'Reason (required)' : 'Payment note (optional)'} value={reason} onChangeText={setReason} editable={!busy} multiline testID={`settlement-reason-${row.id}`} />}
      {review.action === 'report_paid' && <Input label="Transaction reference (optional)" value={reference} onChangeText={setReference} editable={!busy} testID={`settlement-reference-${row.id}`} />}
      <Button label={review.label} disabled={!live || blocked || (reviewRequired && !reason.trim())
        || (review.action === 'start' && (!handoffReport?.upi_id_snapshot || !handoffReport.amount_paise))
        || (['consent', 'admin_override'].includes(review.action) && !!row.plan.allocation_lines?.some(line => !shareLabels?.[line.share_id ?? '']))} loading={busy}
        onPress={() => act(review.action, review.legId, review.personId, review.app)} testID={`settlement-action-submit-${row.id}`} />
      <Button label="Back to report" variant="ghost" disabled={busy} onPress={() => setReview(null)} testID={`settlement-action-back-${row.id}`} />
    </View>}
    {(retry || recovery.pending) && <Button label="Check or retry previous submission" loading={busy} disabled={!live} onPress={() => void run(async (token, valid) => {
      await retryReviewedMutation(scope, token, valid); if (valid()) { setRetry(false); setReview(null); await onComplete(); }
    })} testID={`settlement-retry-${row.id}`} />}
    {live && <Button label="View authorized report history" variant="ghost" disabled={busy} onPress={() => void run(async (token, valid, signal) => {
      const detail = await api<ReviewedIntent>(`/trips/${trip.id}/settlement-intents/${row.id}`, { authToken: token, signal });
      if (valid()) setHistory(detail);
    })} testID={`settlement-history-${row.id}`} />}
    {history?.action_history?.map((action, i) => <T variant="caption" key={i}>{action.actor_name_snapshot ?? 'Recorded actor'} · {action.actor_role ?? 'Authority unavailable'} · {action.operation ?? 'Recorded action'} · {action.created_at ?? ''}{action.request?.reason ? ` · ${action.request.reason}` : ''}</T>)}
    {history?.reports?.map((report, i) => <View key={report.id ?? i} style={{ gap: SPACING.xs }}>
      <T variant="caption">Reported payment: {report.payer_snapshot?.name ?? 'Payer unavailable'} → {report.recipient_snapshot?.name ?? 'Recipient unavailable'} · {report.awaiting_confirmation_at ?? 'Not yet reported'}</T>
      <T variant="caption">Reporting actor: {report.reporting_actor_snapshot?.name ?? history.action_history?.find(action => action.actor_user_id === report.reported_by)?.actor_name_snapshot ?? (report.reported_by === accountId ? 'You' : 'Name unavailable')}. Covered people are listed in the reviewed allocation.</T>
      <T variant="caption">Transaction reference: {report.transaction_reference || 'Not provided'} · Note: {report.note || 'Not provided'}. User-entered evidence is not bank verification.</T>
    </View>)}
    {isAdmin && <Button label="Open financial review" variant="ghost" onPress={onAdminReview} testID={`settlement-review-${row.id}`} />}
    {!!error && <T accessibilityRole="alert">{error}</T>}
    {!!recovery.error && <T accessibilityRole="alert">{recovery.error}</T>}
  </View>;
}
