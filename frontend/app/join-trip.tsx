import React, { useState } from 'react';
import {
  View, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { previewJoin, joinTrip } from '../src/api';
import { useTheme } from '../src/ThemeContext';
import { SPACING, RADIUS, FONTS, CONTENT_MAX_WIDTH } from '../src/theme';
import T from '../src/T';
import Badge from '../src/Badge';
import ConfirmModal from '../src/ConfirmModal';
import { Input, Button, Icon } from '../src/ui';
import { IconName } from '../src/ui/Icon';
import {
  JoinMatch, mustClaim, replacementNeeded, replacementNote,
  buildClaimBody, buildJoinNewBody,
} from '../src/joinIdentity';

type Mode = 'individual' | 'family' | 'new_family';

type PreviewFamily = { id: string; name: string; size: number; linked: boolean };
type Preview = {
  trip: {
    id: string; name: string; code: string;
    start_date?: string | null; end_date?: string | null; currency?: string | null; member_count: number;
  };
  already_member: boolean;
  matched_family: { id: string; name: string } | null;
  families: PreviewFamily[];
  // Phase 11: the caller's own unclaimed stub (individual OR family) on this trip, if any.
  match?: JoinMatch | null;
};

const MODE_OPTIONS: { m: Mode; icon: IconName; title: string; desc: string }[] = [
  { m: 'individual', icon: 'user', title: 'Join as Individual', desc: 'You pay your own share as a single person.' },
  { m: 'family', icon: 'users', title: 'Join existing Family', desc: 'Link yourself into a family already on this trip.' },
  { m: 'new_family', icon: 'plus-circle', title: 'Create New Family', desc: 'Start a new family group and list its members.' },
];

export default function JoinTrip() {
  const { colors } = useTheme();
  const router = useRouter();

  const [stage, setStage] = useState<'code' | 'identity' | 'choose'>('code');
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState<Mode>('individual');
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [familyName, setFamilyName] = useState('');
  const [familyText, setFamilyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 11: destructive confirm before a join-as-new removes the caller's own clean stub.
  const [pendingBody, setPendingBody] = useState<Record<string, unknown> | null>(null);

  const match = preview?.match ?? null;
  const goToTrip = (tripId: string) => router.replace(`/trip/${tripId}`);
  const parsedMembers = () => familyText.split(',').map((s) => s.trim()).filter(Boolean);
  const cleanCode = () => code.toUpperCase().trim();

  const loadPreview = async () => {
    if (code.length !== 6) { setError('Trip code is 6 characters'); return; }
    setBusy(true); setError(null);
    try {
      const p = await previewJoin<Preview>(cleanCode());
      if (p.already_member) { goToTrip(p.trip.id); return; }
      setPreview(p);
      setMode('individual'); setFamilyId(null);
      // A match (the caller's own stub) routes through the identity step first; otherwise the
      // normal join wizard.
      setStage(p.match ? 'identity' : 'choose');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const backToCode = () => {
    setStage('code');
    setPreview(null);
    setFamilyId(null);
    setFamilyName('');
    setFamilyText('');
    setError(null);
  };

  // Claim the caller's own existing profile (keeps the member id; no recalculation server-side).
  const doClaim = async () => {
    if (!match) return;
    setBusy(true); setError(null);
    try {
      const trip = await joinTrip<{ id: string }>(buildClaimBody(cleanCode(), match));
      goToTrip(trip.id);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const doJoinNew = async (body: Record<string, unknown>) => {
    setPendingBody(null);
    setBusy(true); setError(null);
    try {
      const trip = await joinTrip<{ id: string }>(body);
      goToTrip(trip.id);
    } catch (e: any) {
      setError(e.message);
      // A family slot can be taken between preview and submit — refresh the picker on 400/404.
      if (body.mode === 'family' && (e.status === 400 || e.status === 404)) {
        try {
          const p = await previewJoin<Preview>(cleanCode());
          setPreview(p);
          if (familyId && !p.families.some((f) => f.id === familyId && !f.linked)) setFamilyId(null);
        } catch { /* keep the original error message */ }
      }
    } finally { setBusy(false); }
  };

  const submitJoin = () => {
    const c = cleanCode();
    let body: Record<string, unknown>;
    if (mode === 'individual') {
      body = buildJoinNewBody(c, 'individual', {}, match);
    } else if (mode === 'family') {
      if (!familyId) { setError('Select a family to join'); return; }
      body = buildJoinNewBody(c, 'family', { family_id: familyId }, match);
    } else {
      const name = familyName.trim();
      const members = parsedMembers();
      if (!name) { setError('Family name is required'); return; }
      if (members.length === 0) { setError('Add at least one family member name'); return; }
      body = buildJoinNewBody(c, 'new_family', { family_name: name, family_members: members }, match);
    }
    // Replacing the caller's own clean stub is destructive — confirm first.
    if (replacementNeeded(match, 'join_new')) { setPendingBody(body); }
    else { doJoinNew(body); }
  };

  // ---------- Stage 1: code entry ----------
  if (stage === 'code') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={{ padding: SPACING.lg, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
            <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
              <View style={[styles.brand, { backgroundColor: colors.primary }]}>
                <Icon name="key" size={26} color={colors.primaryText} strokeWidth={2} />
              </View>
              <T variant="h1" style={{ marginTop: SPACING.sm }}>Join a trip</T>
              <T muted>Enter the 6-character trip code your friend shared.</T>

              <TextInput
                testID="jt-code"
                value={code}
                onChangeText={(v) => { setCode(v.toUpperCase().replace(/\s/g, '').slice(0, 6)); if (error) setError(null); }}
                placeholder="ABCD12"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="characters"
                editable={!busy}
                style={[styles.codeInput, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: error ? colors.danger : colors.border }]}
              />
              {error ? <T testID="jt-error" variant="caption" color={colors.danger}>{error}</T> : null}

              <Button label="Continue" iconRight="chevron-right" onPress={loadPreview} loading={busy} disabled={code.length !== 6} fullWidth size="lg" testID="jt-submit" />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ---------- Stage 2 (Phase 11): we recognized the caller's email on this trip ----------
  if (stage === 'identity' && match) {
    const claimOnly = mustClaim(match);
    const where = match.member_type === 'family'
      ? `the family ${match.member_name}`
      : match.member_type === 'family_member'
        ? `${match.member_name} in the ${match.family_name} family`
        : match.member_name;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <TouchableOpacity testID="jt-back" onPress={backToCode} disabled={busy}
              style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' }} accessibilityLabel="Back">
              <Icon name="chevron-left" size={18} color={colors.textMuted} />
              <T muted style={{ marginLeft: 2 }}>Back</T>
            </TouchableOpacity>

            <View>
              <T variant="h1">We found you on this trip</T>
              <T muted style={{ marginTop: 4 }} testID="jt-identity-summary">
                Your email is already here as {where}.
              </T>
            </View>

            {claimOnly ? (
              <View style={{ gap: SPACING.md }}>
                <View style={[styles.noteCard, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
                  <Icon name="info" size={18} color={colors.textMuted} />
                  <T variant="caption" muted style={{ flex: 1, marginLeft: SPACING.sm, lineHeight: 18 }}>
                    {match.member_type === 'family_member'
                      ? `You're listed in the ${match.family_name} family as ${match.member_name}. Continue to link your account to that member.`
                      : "This profile already has expenses, so it can't be duplicated. Continue as this profile to keep its history."}
                  </T>
                </View>
                {error ? <T testID="jt-error" variant="caption" color={colors.danger}>{error}</T> : null}
                <Button label={`Continue as ${match.member_name}`} icon="check" onPress={doClaim}
                  loading={busy} fullWidth size="lg" testID="jt-identity-claim" />
              </View>
            ) : (
              <View style={{ gap: SPACING.sm }}>
                <TouchableOpacity testID="jt-identity-claim" disabled={busy} onPress={doClaim}
                  accessibilityRole="button"
                  style={[styles.modeCard, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
                  <Icon name="user" size={22} color={colors.textMain} />
                  <View style={{ flex: 1, marginLeft: SPACING.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
                      <T variant="h4">This is me — take over this profile</T>
                      <Badge label="Recommended" color={colors.success} />
                    </View>
                    <T variant="caption" muted style={{ marginTop: 2 }}>
                      Keep {match.member_name} and its place in the trip.
                    </T>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity testID="jt-identity-new" disabled={busy}
                  onPress={() => { setError(null); setStage('choose'); }}
                  accessibilityRole="button"
                  style={[styles.modeCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <Icon name="plus-circle" size={22} color={colors.textMain} />
                  <View style={{ flex: 1, marginLeft: SPACING.md }}>
                    <T variant="h4">Join as someone new</T>
                    <T variant="caption" muted style={{ marginTop: 2 }}>
                      Start a fresh profile. The existing {match.member_name} profile is removed.
                    </T>
                  </View>
                </TouchableOpacity>

                {error ? <T testID="jt-error" variant="caption" color={colors.danger}>{error}</T> : null}
              </View>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---------- Stage 3: choose how to join (join as someone new) ----------
  // Exclude the caller's own stub from the family picker — joining it would be a claim, offered
  // separately on the identity step.
  const families = (preview?.families ?? []).filter((f) => f.id !== match?.member_id);
  const hasFamilies = families.length > 0;
  const allLinked = hasFamilies && families.every((f) => f.linked);
  const sortedFamilies = families;

  const confirmDisabled = busy
    || (mode === 'family' && !familyId)
    || (mode === 'new_family' && (!familyName.trim() || parsedMembers().length === 0));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <TouchableOpacity testID="jt-back" onPress={match ? () => { setError(null); setStage('identity'); } : backToCode} disabled={busy}
              style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' }} accessibilityLabel="Back">
              <Icon name="chevron-left" size={18} color={colors.textMuted} />
              <T muted style={{ marginLeft: 2 }}>Back</T>
            </TouchableOpacity>

            <View>
              <T variant="h1">How are you joining?</T>
              <T muted style={{ marginTop: 4 }}>
                {preview?.trip.name} · {preview?.trip.member_count} {preview?.trip.member_count === 1 ? 'member' : 'members'}
              </T>
            </View>

            <View style={{ gap: SPACING.sm }}>
              {MODE_OPTIONS.map((opt) => {
                const active = mode === opt.m;
                const optDisabled = busy || (opt.m === 'family' && !hasFamilies);
                const desc = opt.m === 'family' && !hasFamilies ? 'No families in this trip yet.' : opt.desc;
                return (
                  <TouchableOpacity key={opt.m} testID={`jt-mode-${opt.m}`} disabled={optDisabled}
                    onPress={() => { setMode(opt.m); setError(null); }}
                    accessibilityRole="radio" accessibilityState={{ selected: active, disabled: optDisabled }}
                    style={[styles.modeCard, {
                      backgroundColor: active ? colors.primary : colors.surface,
                      borderColor: active ? colors.primary : colors.border,
                      opacity: optDisabled && !active ? 0.5 : 1,
                    }]}>
                    <Icon name={opt.icon} size={22} color={active ? colors.primaryText : colors.textMain} />
                    <View style={{ flex: 1, marginLeft: SPACING.md }}>
                      <T variant="h4" color={active ? colors.primaryText : colors.textMain}>{opt.title}</T>
                      <T variant="caption" color={active ? colors.primaryText : colors.textMuted} style={{ marginTop: 2 }}>{desc}</T>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            {mode === 'family' && hasFamilies && (
              <View style={{ gap: SPACING.sm }}>
                {allLinked ? (
                  <T testID="jt-family-all-linked" muted variant="caption">All families are already claimed. Pick another option above.</T>
                ) : null}
                {sortedFamilies.map((f) => {
                  const selected = familyId === f.id;
                  const rowDisabled = f.linked || busy;
                  return (
                    <TouchableOpacity key={f.id} testID={`jt-family-${f.id}`} disabled={rowDisabled}
                      onPress={() => { setFamilyId(f.id); setError(null); }}
                      accessibilityRole="radio" accessibilityState={{ selected, disabled: rowDisabled }}
                      style={[styles.familyRow, {
                        backgroundColor: selected ? colors.surfaceMuted : colors.surface,
                        borderColor: selected ? colors.primary : colors.border,
                        opacity: f.linked ? 0.5 : 1,
                      }]}>
                      <Icon name={selected ? 'radio-on' : 'radio-off'} size={20} color={selected ? colors.primary : colors.textMuted} />
                      <View style={{ flex: 1, marginLeft: SPACING.sm, gap: 2 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
                          <T style={{ fontFamily: FONTS.bodySemibold }}>{f.name}</T>
                          {f.linked ? <Badge label="Linked" color={colors.textMuted} /> : null}
                        </View>
                        <T muted variant="caption">{f.size} {f.size === 1 ? 'member' : 'members'}</T>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {mode === 'new_family' && (
              <View style={{ gap: SPACING.md }}>
                <Input testID="jt-family-name" label="Family name *" value={familyName}
                  onChangeText={(v) => { setFamilyName(v); if (error) setError(null); }}
                  placeholder="e.g. Sharma Family" editable={!busy} />
                <Input testID="jt-family-members" label="Family member names (comma separated) *" value={familyText}
                  onChangeText={(v) => { setFamilyText(v); if (error) setError(null); }}
                  placeholder="e.g. Arjun, Priya, Rohan" editable={!busy}
                  helper="List everyone in your family, including yourself. Expenses on this family split per member." />
              </View>
            )}

            {error ? <T testID="jt-error" variant="caption" color={colors.danger}>{error}</T> : null}

            <Button label="Join trip" icon="check" onPress={submitJoin} loading={busy} disabled={confirmDisabled} fullWidth size="lg" testID="jt-join-confirm" />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmModal
        visible={pendingBody !== null}
        testID="jt-replace-modal"
        title="Remove existing profile?"
        message={match ? replacementNote(match) : undefined}
        onRequestClose={() => setPendingBody(null)}
        actions={[
          { label: 'Remove & continue', variant: 'destructive', testID: 'jt-replace-confirm',
            onPress: () => { if (pendingBody) doJoinNew(pendingBody); } },
          { label: 'Cancel', variant: 'cancel', testID: 'jt-replace-cancel',
            onPress: () => setPendingBody(null) },
        ]}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  brand: { width: 52, height: 52, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center' },
  codeInput: { paddingHorizontal: SPACING.md, paddingVertical: 16, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 26, letterSpacing: 8, textAlign: 'center', fontFamily: FONTS.numberBold },
  modeCard: { flexDirection: 'row', alignItems: 'center', padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1 },
  familyRow: { flexDirection: 'row', alignItems: 'center', padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1 },
  noteCard: { flexDirection: 'row', alignItems: 'flex-start', padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1 },
});
