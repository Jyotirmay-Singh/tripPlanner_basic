import React, { useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { ScrollView, useWindowDimensions } from 'react-native';
import { api } from './api';
import type { ReportTarget } from './communitySafety';
import T from './T';
import { Button, Input, Sheet } from './ui';

const REASONS = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'inappropriate', label: 'Inappropriate or unlawful content' },
  { value: 'spam', label: 'Spam or scam' },
  { value: 'privacy', label: 'Private information' },
  { value: 'other', label: 'Other' },
];

export default function ReportContentSheet({ tripId, target, onClose }: {
  tripId: string; target: ReportTarget; onClose: () => void;
}) {
  const [reportId] = useState(() => Crypto.randomUUID());
  const { height } = useWindowDimensions();
  const [reason, setReason] = useState('harassment');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const attempted = useRef(false);

  async function submit() {
    if (busy || submitted) return;
    attempted.current = true;
    setBusy(true); setError(null);
    try {
      await api(`/trips/${tripId}/safety/reports`, { method: 'POST', body: {
        client_report_id: reportId, ...target, reason, details,
      } });
      setSubmitted(true);
    } catch (failure: any) { setError(failure?.message || 'Report could not be submitted. Try again.'); }
    finally { setBusy(false); }
  }

  return <Sheet visible onClose={onClose} title="Report to Splitora" closeLabel="Close report" testID="report-content-sheet">
    <ScrollView style={{ maxHeight: height * 0.72 }} contentContainerStyle={{ gap: 8, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
    {submitted ? <>
      <T accessibilityLiveRegion="polite">Your report was submitted to the application moderator. You can also contact teamsplitora@gmail.com.</T>
      <Button label="Done" onPress={onClose} />
    </> : <>
      <T>Choose a reason. The reported content and your explanation are shared with the application moderator.</T>
      {REASONS.map((choice) => <Button key={choice.value} label={choice.label}
        variant={reason === choice.value ? 'primary' : 'secondary'} disabled={busy || attempted.current}
        onPress={() => setReason(choice.value)} />)}
      <Input label="Additional details" value={details} onChangeText={setDetails} multiline maxLength={2000} editable={!busy && !attempted.current} />
      {attempted.current && error ? <T muted>Retry sends the same report. Close this form to start a different report.</T> : null}
      {error ? <T accessibilityLiveRegion="polite">{error}</T> : null}
      <Button label="Submit report" testID="submit-content-report" loading={busy} onPress={() => { void submit(); }} />
    </>}
    </ScrollView>
  </Sheet>;
}
