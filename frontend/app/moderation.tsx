import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { api, getToken, reportedReceiptUrl } from '../src/api';
import { useAuth } from '../src/AuthContext';
import type { CommunityReportCase } from '../src/communitySafety';
import T from '../src/T';
import { Button, Card, Input, Screen } from '../src/ui';

type GuardianReview = { id: string; name: string; guardian_consent: { guardian_email: string } };

function ReportCard({ item, refresh, request }: {
  item: CommunityReportCase; refresh: () => Promise<void>; request: typeof api;
}) {
  const [note, setNote] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function resolve(action: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await request(`/admin/safety/reports/${item.id}/resolve`, { method: 'POST', body: { action, note } });
      await refresh();
    } catch (failure: any) { setError(failure?.message || 'Moderation action failed. Retry the same action.'); }
    finally { setBusy(false); }
  }
  return <Card testID={`moderation-case-${item.id}`}>
    <T variant="h3">{item.target_type} · {item.reason}</T>
    <T selectable>{item.id}</T>
    {item.target_user_id ? <T selectable>Reported account {item.target_user_id}</T> : null}
    {item.snapshot ? <T selectable>{item.snapshot}</T> : null}
    {item.details ? <T>{item.details}</T> : null}
    {item.status === 'action_pending' ? <T>Pending action · {item.action}</T> : null}
    {item.target_type === 'receipt' ? <Button label="Inspect reported receipt" variant="secondary"
      onPress={() => { void getToken().then((token) => {
        if (token && mounted.current) { setError(null); setImage(reportedReceiptUrl(item.id, token)); }
      }); }} /> : null}
    {image ? <Image accessibilityLabel="Reported receipt revision" source={{ uri: image }}
      onError={() => { setImage(null); setError('The reported receipt revision could not be loaded. It may have been replaced or deleted. Retry or review the case through support.'); }}
      style={{ height: 260, width: '100%' }} resizeMode="contain" /> : null}
    <Input label="Moderation explanation" value={note} onChangeText={setNote} multiline maxLength={1000} />
    {error ? <T accessibilityLiveRegion="polite">{error}</T> : null}
    <Button label="Dismiss report" variant="secondary" disabled={busy || note.trim().length < 8}
      onPress={() => { void resolve('dismiss'); }} />
    {item.target_type !== 'user' ? <Button label="Remove reported content" variant="secondary"
      disabled={busy || note.trim().length < 8} onPress={() => { void resolve('remove_content'); }} /> : null}
    {item.target_user_id ? <Button label="Suspend community posting" variant="destructive"
      disabled={busy || note.trim().length < 8} onPress={() => { void resolve('suspend_user'); }} /> : null}
  </Card>;
}

function GuardianCard({ item, refresh, request }: {
  item: GuardianReview; refresh: () => Promise<void>; request: typeof api;
}) {
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function verify() {
    setBusy(true); setError(null);
    try {
      await request(`/admin/safety/guardians/${item.id}/verify`, { method: 'POST', body: { verification_reference: reference } });
      await refresh();
    } catch (failure: any) { setError(failure?.message || 'Verification could not be saved.'); }
    finally { setBusy(false); }
  }
  return <Card>
    <T variant="h3">Guardian review for {item.name}</T><T>{item.guardian_consent.guardian_email}</T>
    <T>Complete adult identity and guardian review through the approved verification process. Record its case reference here.</T>
    <Input label="Completed adult-verification case reference" value={reference} onChangeText={setReference} maxLength={300} />
    {error ? <T>{error}</T> : null}
    <Button label="Confirm verified guardian" disabled={busy || reference.trim().length < 8} onPress={() => { void verify(); }} />
  </Card>;
}

export default function Moderation() {
  const { user } = useAuth();
  if (!user?.is_super_admin) return <Screen><T>Application administrator access is required.</T></Screen>;
  return <ModerationQueue key={user.id} />;
}

function ModerationQueue() {
  const { user } = useAuth();
  const [reports, setReports] = useState<CommunityReportCase[]>([]);
  const [guardians, setGuardians] = useState<GuardianReview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoreId, setRestoreId] = useState('');
  const generation = useRef(0);
  const account = useRef(user?.id);
  account.current = user?.id;
  const mounted = useRef(true);
  const cancellation = useRef(new AbortController());
  useEffect(() => {
    mounted.current = true;
    cancellation.current = new AbortController();
    return () => { mounted.current = false; cancellation.current.abort(); };
  }, []);
  const request: typeof api = useCallback(async (path, options = {}) => {
    if (!mounted.current) throw new Error('The active account changed');
    return api(path, { ...options, signal: cancellation.current.signal });
  }, []);
  const refresh = useCallback(async () => {
    if (!user?.is_super_admin) return;
    const requestGeneration = ++generation.current;
    setLoading(true);
    try {
      const [cases, reviews] = await Promise.all([
        request<{ items: CommunityReportCase[] }>('/admin/safety/reports'),
        request<{ items: GuardianReview[] }>('/admin/safety/guardians'),
      ]);
      if (requestGeneration !== generation.current || account.current !== user.id) return;
      setReports(cases.items); setGuardians(reviews.items); setError(null);
    } catch (failure: any) {
      if (requestGeneration === generation.current) setError(failure?.message || 'The moderation queue could not be loaded.');
    } finally { if (requestGeneration === generation.current) setLoading(false); }
  }, [request, user?.id, user?.is_super_admin]);
  useFocusEffect(useCallback(() => { void refresh(); return () => { generation.current += 1; }; }, [refresh]));
  if (!user?.is_super_admin) return <Screen><T>Application administrator access is required.</T></Screen>;
  return <Screen edges={['left', 'right', 'bottom']} testID="moderation-screen">
    <T variant="h1">Moderation</T>
    <Button label="Refresh queue" onPress={() => { void refresh(); }} loading={loading} />
    {error ? <T accessibilityLiveRegion="polite">{error}</T> : null}
    {reports.map((item) => <ReportCard key={item.id} item={item} refresh={refresh} request={request} />)}
    {guardians.map((item) => <GuardianCard key={item.id} item={item} refresh={refresh} request={request} />)}
    {!loading && !error && !reports.length && !guardians.length ? <T>The review queue is clear.</T> : null}
    <Card><T variant="h3">Restore community posting after appeal</T>
      <Input label="Account identifier from the reviewed case" value={restoreId} onChangeText={setRestoreId} />
      <Button label="Restore community posting" variant="secondary" disabled={!restoreId.trim() || loading}
        onPress={() => { void request(`/admin/safety/suspensions/${encodeURIComponent(restoreId.trim())}`, { method: 'DELETE' })
          .then(() => { setRestoreId(''); return refresh(); }).catch((failure: any) => setError(failure.message)); }} />
    </Card>
  </Screen>;
}
