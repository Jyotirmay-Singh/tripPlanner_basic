import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { api, getToken } from './api';
import { useAuth } from './AuthContext';
import T from './T';
import { Button, Input, Sheet } from './ui';
import { SPACING } from './theme';
import { coverage, previewCorrection, requireFinancialConnection, type ReviewRequest,
  type ReviewPreview, type Correction, type ReviewEffects } from './financialReview';

export function ReviewEffectsView({ effects, currency, names = {} }: {
  effects: ReviewEffects; currency: string; names?: Record<string, string>;
}) {
  return <View style={{ gap: SPACING.sm }}>
    {Object.entries(effects.after_balances ?? {}).map(([wallet, amount]) => <T key={wallet}>
      {names[wallet] ?? 'Historical wallet'}: {effects.before_balances?.[wallet] ?? '0'} → {amount} {currency}
    </T>)}
    {!!effects.reversed_event_ids?.length && <T>{effects.reversed_event_ids.length} complete coverage bundle(s) will reverse.</T>}
    {effects.shares?.map((row, index) => {
      const previous = effects.before_shares?.find(old => old.expense_id === row.expense_id && old.person_id === row.person_id);
      return <View key={row.share_id ?? index}>
        <T>{effects.expense_names?.[row.expense_id ?? ''] ?? 'Expense'} · {row.person_name ?? names[row.wallet_id ?? ''] ?? 'Historical participant'}</T>
        <T>Share: {previous?.original_share ?? '0'} → {row.original_share ?? row.amount ?? '0'} {currency}. Outstanding: {previous?.remaining_amount ?? '0'} → {row.remaining_amount ?? row.amount} {currency}.</T>
        {previous && Number(previous.reserved_amount) > 0 && <T>Prior reservation: {previous.reserved_amount} {currency}. Reported money remains subject to review.</T>}
      </View>;
    })}
    {effects.before_shares?.filter(old => !effects.shares?.some(row => row.expense_id === old.expense_id && row.person_id === old.person_id)).map(row => <T key={row.share_id}>
      {effects.expense_names?.[row.expense_id] ?? 'Historical expense'} · {row.person_name ?? 'Historical participant'}: prior share {row.original_share} {currency} retired; preserved in history.
    </T>)}
    {effects.affected_bundles?.map((bundle, index) => <View key={bundle.event_id}>
      <T>Settlement {index + 1}: {bundle.approval_count} prior approval(s) retained.</T>
      {bundle.allocation_lines.map((line, lineIndex) => {
        const share = effects.before_shares?.find(row => row.share_id === line.share_id);
        return <T key={`${line.share_id}:${lineIndex}`}>
          {effects.expense_names?.[share?.expense_id ?? ''] ?? 'Historical expense'} · {share?.person_name ?? 'Historical participant'}: reverse {line.amount} {currency} of {line.kind.replaceAll('_', ' ')} coverage.
        </T>;
      })}
      {bundle.cash_uses.map((use, sourceIndex) => {
        const source = effects.cash_sources?.find(row => row.source_id === use.source_id);
        return <T key={`${use.source_id}:${sourceIndex}`}>
          {names[source?.payer_wallet_id ?? ''] ?? 'Historical payer'} → {names[source?.receiver_wallet_id ?? ''] ?? 'Historical receiver'}: release {use.amount} {currency} from this settlement. The received money stays recorded.
        </T>;
      })}
    </View>)}
    {!!effects.affected_reports?.length && <T>{effects.affected_reports.length} pending payment report(s) remain visible for review.</T>}
    {effects.recorded_cash_changes?.map((row, index) => <T key={index}>
      {names[row.payer_wallet_id] ?? 'Historical payer'} → {names[row.receiver_wallet_id] ?? 'Historical receiver'}: recorded money {row.before_amount} → {row.after_amount} {currency}. The original receipt stays in history; this does not record a physical refund.
    </T>)}
    {effects.unapplied_credit?.map(row => <T key={row.source_id}>Retained credit: {row.amount} {currency}. Reapplication needs a separate review.</T>)}
    {effects.allocated && <T>Allocate {effects.allocated} {currency}; retain {effects.residual_credit} {currency} as credit.</T>}
    {!!effects.review_cases?.length && <T>{effects.review_cases.length} payment or history review case(s) remain.</T>}
  </View>;
}

export default function FinancialReviewSheet({ tripId, request, currency, names, onClose, onComplete }: {
  tripId: string; request: ReviewRequest | null; currency: string; names?: Record<string, string>;
  onClose: () => void; onComplete: (result: Correction) => void;
}) {
  const { user, sessionMode } = useAuth();
  const account = useRef(user?.id); account.current = user?.id;
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<ReviewPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mutation = useRef<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1; pending.current?.abort();
    setBusy(false); setReview(null); setReason(request?.reason ?? ''); setError(''); mutation.current = null;
    return () => { generation.current += 1; pending.current?.abort(); };
  }, [request, user?.id, tripId]);
  const run = async (apply: boolean) => {
    const actor = user?.id;
    const pass = generation.current;
    const controller = new AbortController(); pending.current = controller;
    const valid = () => account.current === actor && generation.current === pass;
    setBusy(true); setError('');
    try {
      await requireFinancialConnection(sessionMode);
      const token = await getToken();
      if (!request || !actor || !token || !valid()) return;
      const options = { authToken: token, signal: controller.signal };
      if (!apply) {
        const current = await coverage(tripId, [], options);
        if (!current.complete || !current.snapshot_id) throw new Error('Current financial review is unavailable. Refresh while connected.');
        if (!valid()) return;
        const result = await previewCorrection(tripId, current.snapshot_id, request, reason.trim(), options);
        if (valid()) { setReview(result); mutation.current = Crypto.randomUUID(); }
      } else if (review) {
        if (Date.parse(review.expires_at) <= Date.now()) throw new Error('This review expired. Preview the current effects again.');
        const renewal = request.renewal;
        const result = await api<Correction>(`/trips/${tripId}/corrections${renewal ? `/${renewal.id}/actions` : ''}`, { method: 'POST', timeoutMs: 15000, ...options,
          body: { ...(renewal ? { action: 'renew', expected_version: renewal.version, plan_hash: renewal.plan_hash } : { protocol_version: 2 }),
            preview_id: review.id, preview_hash: review.preview_hash, client_mutation_id: mutation.current } });
        if (valid()) onComplete(result);
      }
    } catch (failure: unknown) {
      if (valid()) setError(failure instanceof Error ? failure.message : 'Review changed. Refresh and preview again.');
    } finally { if (valid()) setBusy(false); }
  };
  if (!request) return null;
  return <Sheet visible={!!request} onClose={busy ? () => {} : onClose} title="Review financial change"
    closeLabel="Close financial review" trapFocus testID="financial-review-sheet">
    <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 500 }}>
      <View style={{ gap: SPACING.md }}>
        <T>Prior shares, receipts and approvals remain in history. Reversed coverage reopens obligations. Correcting a payment record does not record a refund.</T>
        <Input label="Reason for this correction" value={reason} onChangeText={value => { setReason(value); setReview(null); mutation.current = null; }} multiline editable={!busy} />
        {error ? <T accessibilityRole="alert">{error}</T> : null}
        {review ? <>
          <ReviewEffectsView effects={review.effects} currency={currency} names={names} />
          <T>{review.requires_admin ? 'A current group admin must approve this correction.' : review.required_person_ids?.length
            ? 'Every affected person must approve, or a group admin must approve with a reason.' : 'The expense creator or a group admin may apply this uncovered change.'}</T>
          <Button label="Submit reviewed correction" loading={busy} onPress={() => void run(true)} testID="financial-review-submit" />
        </> : null}
        <Button label={review ? 'Refresh preview' : 'Preview effects'} disabled={!reason.trim()} loading={busy}
          variant="secondary" onPress={() => void run(false)} testID="financial-review-preview" />
      </View>
    </ScrollView>
  </Sheet>;
}
