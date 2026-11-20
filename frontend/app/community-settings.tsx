import React, { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { api as apiRequest } from '../src/api';
import { useAuth } from '../src/AuthContext';
import { useCommunity } from '../src/CommunityProvider';
import { COMMUNITY_TERMS_VERSION, SUPPORT_EMAIL, type CommunityAgeBand, type GuardianControls } from '../src/communitySafety';
import { postAuthHref } from '../src/inviteNavigation';
import { useLogout } from '../src/useLogout';
import LegalLinks from '../src/LegalLinks';
import T from '../src/T';
import { Button, Card, Input, Screen } from '../src/ui';

function Check({ label, checked, onChange, testID }: {
  label: string; checked: boolean; onChange: () => void; testID?: string;
}) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label}
    accessibilityState={{ checked }} testID={testID} onPress={onChange}
    style={{ minHeight: 48, justifyContent: 'center', paddingVertical: 8 }}>
    <T>{checked ? '☑' : '☐'} {label}</T>
  </Pressable>;
}

const AGE_OPTIONS: { value: CommunityAgeBand; label: string }[] = [
  { value: 'under_13', label: 'Under 13' },
  { value: '13_17', label: '13–17' },
  { value: '18_plus', label: '18 or over' },
];
const CONTROL_LABELS: Record<keyof GuardianControls, string> = {
  chat_enabled: 'Group chat', receipts_enabled: 'Receipt photos', contacts_enabled: 'Mobile and UPI sharing',
};

export default function CommunitySettings() {
  const { user } = useAuth();
  return <CommunitySettingsForm key={user?.id || 'signed-out'} />;
}

function CommunitySettingsForm() {
  const { user, refreshUserProfile, pendingInvitePath, sessionMode } = useAuth();
  const { state, loading, error, refresh } = useCommunity();
  const { confirmAndSignOut } = useLogout();
  const router = useRouter();
  const [age, setAge] = useState<CommunityAgeBand | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [guardianEmail, setGuardianEmail] = useState('');
  const [issuedCode, setIssuedCode] = useState('');
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [parentConfirmed, setParentConfirmed] = useState(false);
  const [controls, setControls] = useState<GuardianControls>({
    chat_enabled: false, receipts_enabled: false, contacts_enabled: false,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const online = sessionMode === 'online';
  const mounted = useRef(true);
  const cancellation = useRef(new AbortController());
  useEffect(() => {
    mounted.current = true;
    cancellation.current = new AbortController();
    return () => { mounted.current = false; cancellation.current.abort(); };
  }, []);

  async function api<T = any>(path: string, options: Parameters<typeof apiRequest>[1]) {
    if (!mounted.current) throw new Error('The active account changed');
    return apiRequest<T>(path, { ...options, signal: cancellation.current.signal });
  }

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (!mounted.current) return;
      await refresh();
      if (mounted.current) await refreshUserProfile();
    }
    catch (failure: any) { if (mounted.current) setMessage(failure?.message || 'Settings could not be saved. Try again.'); }
    finally { if (mounted.current) setBusy(false); }
  }

  if (!user) return <Screen><T>Sign in to review your community settings.</T>
    <Button label="Sign in" onPress={() => router.replace('/(auth)/login')} /><LegalLinks /></Screen>;

  return <Screen edges={['left', 'right', 'bottom']} testID="community-settings">
    <T variant="h1">Community safety</T>
    <T muted>Review how shared content is handled and manage your safety settings.</T>
    {loading ? <T accessibilityRole="progressbar">Loading settings…</T> : null}
    {error ? <Card><T color="#B42318">{error}</T><Button label="Retry" onPress={() => { void refresh(); }} /></Card> : null}
    {message ? <T accessibilityLiveRegion="polite" testID="community-result">{message}</T> : null}
    {state && !state.accepted ? <Card>
      <T variant="h3">Age group and terms</T>
      <T>Choose your age group. The same review applies to new and existing accounts.</T>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {AGE_OPTIONS.map((option) => <Button key={option.value} label={option.label}
          testID={`community-age-${option.value}`} disabled={busy || !!state.age_band}
          variant={(state.age_band || age) === option.value ? 'primary' : 'secondary'}
          onPress={() => setAge(option.value)} />)}
      </View>
      <LegalLinks />
      <Check label="I have read the Privacy policy and agree to the Terms and community rules."
        checked={agreed} onChange={() => setAgreed(!agreed)} testID="community-terms-check" />
      <Button label="Save age group and accept terms" testID="community-accept"
        disabled={busy || !online || !agreed || !(state.age_band || age)}
        onPress={() => { void perform(async () => {
          await api('/auth/me/safety/terms', { method: 'POST', body: {
            version: COMMUNITY_TERMS_VERSION, age_band: state.age_band || age,
          } });
        }); }} />
    </Card> : null}
    {state?.age_band === 'under_13' ? <Card><T>Splitora is available from age 13. You can request account deletion or contact support below.</T></Card> : null}
    {state?.suspended ? <Card><T>Community posting is suspended. Contact {SUPPORT_EMAIL} to appeal.</T></Card> : null}
    {state?.accepted && state.age_band === '13_17' ? <Card>
      <T variant="h3">Parent or guardian approval</T>
      <T>Your parent or guardian uses their own verified adult account to review the request. Group access starts after adult-verification review. Your guardian chooses chat, receipt and contact-sharing permissions.</T>
      {state.guardian_status ? <T testID="guardian-status">Status · {state.guardian_status.replaceAll('_', ' ')}</T> : null}
      {state.guardian_email ? <T>{state.guardian_email}</T> : null}
      {state.guardian_status !== 'approved' && state.guardian_status !== 'pending_verification' ? <>
        <Input label="Parent or guardian’s Gmail" value={guardianEmail} onChangeText={setGuardianEmail}
          autoCapitalize="none" keyboardType="email-address" testID="guardian-email" />
        <Button label="Create guardian code" disabled={busy || !online || !guardianEmail.trim()}
          onPress={() => { void perform(async () => {
            const result = await api<{ code: string }>('/auth/me/safety/guardian-request', {
              method: 'POST', body: { email: guardianEmail.trim() },
            });
            setIssuedCode(result.code);
          }); }} />
      </> : null}
      {issuedCode ? <>
        <T selectable testID="guardian-issued-code">{issuedCode}</T>
        <T muted>Share this seven-day code privately with your guardian. They enter it in Community safety.</T>
        <Button label="Copy guardian code" variant="secondary" onPress={() => { void Clipboard.setStringAsync(issuedCode); }} />
      </> : null}
    </Card> : null}
    {state?.accepted && state.age_band === '18_plus' ? <Card>
      <T variant="h3">Review a teen’s guardian request</T>
      <T>Use the code shared privately by your child. Your Gmail must be verified. Adult identity and relationship are reviewed before access is enabled.</T>
      <Input label="Guardian code" value={code} autoCapitalize="none" testID="guardian-review-code"
        onChangeText={(value) => { setCode(value); setPreview(null); setParentConfirmed(false); }} />
      <Button label="Review request" disabled={busy || !online || code.trim().length !== 32}
        onPress={() => { void perform(async () => {
          const result = await api<{ name: string }>('/safety/guardian/preview', { method: 'POST', body: { code: code.trim() } });
          setPreview(result.name);
        }); }} />
      {preview ? <>
        <T variant="h3">Permission for {preview}</T>
        <Check label="I am this person’s parent or legal guardian and consent to their Splitora account."
          checked={parentConfirmed} onChange={() => setParentConfirmed(!parentConfirmed)} />
        {(Object.keys(CONTROL_LABELS) as (keyof GuardianControls)[]).map((field) => <Check key={field}
          label={CONTROL_LABELS[field]} checked={controls[field]}
          onChange={() => setControls({ ...controls, [field]: !controls[field] })} />)}
        <Button label="Give consent and request verification" disabled={busy || !parentConfirmed || !online}
          onPress={() => { void perform(async () => {
            await api('/safety/guardian/consent', { method: 'POST', body: {
              code: code.trim(), is_parent_or_guardian: true, ...controls,
            } });
            setCode(''); setPreview(null); setMessage('Consent recorded. Contact support to complete adult-verification review.');
          }); }} />
      </> : null}
    </Card> : null}
    {state?.children.map((child) => <Card key={child.id}>
      <T variant="h3">Guardian controls for {child.name}</T><T muted>{child.status.replaceAll('_', ' ')}</T>
      {(Object.keys(CONTROL_LABELS) as (keyof GuardianControls)[]).map((field) => <Button key={field}
        label={`${child[field] ? 'Disable' : 'Enable'} ${CONTROL_LABELS[field].toLowerCase()}`} variant="secondary"
        disabled={busy || !online || child.status === 'revoked'} onPress={() => { void perform(async () => {
          await api(`/safety/children/${child.id}`, { method: 'PATCH', body: {
            chat_enabled: child.chat_enabled, receipts_enabled: child.receipts_enabled,
            contacts_enabled: child.contacts_enabled, [field]: !child[field],
          } });
        }); }} />)}
      {child.status !== 'revoked' ? <Button label="Withdraw account consent" variant="secondary"
        disabled={busy || !online} onPress={() => { void perform(async () => {
          await api(`/safety/children/${child.id}/consent`, { method: 'DELETE' });
        }); }} /> : null}
    </Card>)}
    {state?.blocks.length ? <Card><T variant="h3">Blocked people</T>
      {state.blocks.map((block) => <Button key={block.blocked_user_id} label={`Unblock ${block.name}`}
        variant="secondary" disabled={busy || !online} onPress={() => { void perform(async () => {
          await api(`/auth/me/safety/blocks/${block.blocked_user_id}`, { method: 'DELETE' });
        }); }} />)}
    </Card> : null}
    {state?.permissions.account ? <Button label="Continue to groups" testID="community-continue"
      onPress={() => router.replace(postAuthHref(pendingInvitePath))} /> : null}
    {user.is_super_admin ? <Button label="Moderation queue" icon="shield" variant="secondary"
      onPress={() => router.push('/moderation')} /> : null}
    <Button label="Delete account" variant="ghost" onPress={() => router.push('/delete-account')} />
    <Button label="Contact support" variant="ghost" onPress={() => { void Linking.openURL(`mailto:${SUPPORT_EMAIL}`); }} />
    <Button label="Sign out" variant="ghost" onPress={confirmAndSignOut} />
    <LegalLinks />
  </Screen>;
}
