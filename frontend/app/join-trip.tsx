import React, { useState } from 'react';
import {
  View, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../src/api';
import { useTheme } from '../src/ThemeContext';
import { SPACING, RADIUS } from '../src/theme';
import T from '../src/T';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
type Mode = 'individual' | 'family' | 'new_family';

type PreviewFamily = { id: string; name: string; size: number; linked: boolean };
type Preview = {
  trip: {
    id: string; name: string; code: string;
    travel_date?: string | null; currency?: string | null; member_count: number;
  };
  already_member: boolean;
  matched_family: { id: string; name: string } | null;
  families: PreviewFamily[];
};

const MODE_OPTIONS: { m: Mode; icon: IconName; title: string; desc: string }[] = [
  { m: 'individual', icon: 'person', title: 'Join as Individual', desc: 'You pay your own share as a single person.' },
  { m: 'family', icon: 'people', title: 'Join existing Family', desc: 'Link yourself into a family already on this trip.' },
  { m: 'new_family', icon: 'add-circle', title: 'Create New Family', desc: 'Start a new family group and list its members.' },
];

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <T variant="caption" color={color} style={styles.badgeText}>{label}</T>
    </View>
  );
}

export default function JoinTrip() {
  const { colors } = useTheme();
  const router = useRouter();

  const [stage, setStage] = useState<'code' | 'choose'>('code');
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState<Mode>('individual');
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [familyName, setFamilyName] = useState('');
  const [familyText, setFamilyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goToTrip = (tripId: string) => router.replace(`/trip/${tripId}`);
  const parsedMembers = () => familyText.split(',').map((s) => s.trim()).filter(Boolean);

  const loadPreview = async () => {
    if (code.length !== 6) { setError('Trip code is 6 characters'); return; }
    setBusy(true); setError(null);
    try {
      const p = await api<Preview>('/trips/join/preview', {
        method: 'POST', body: { code: code.toUpperCase().trim() },
      });
      if (p.already_member) { goToTrip(p.trip.id); return; }
      setPreview(p);
      if (p.matched_family) { setMode('family'); setFamilyId(p.matched_family.id); }
      else { setMode('individual'); setFamilyId(null); }
      setStage('choose');
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

  const submitJoin = async () => {
    const c = code.toUpperCase().trim();
    let body: Record<string, any>;
    if (mode === 'individual') {
      body = { code: c, mode: 'individual' };
    } else if (mode === 'family') {
      if (!familyId) { setError('Select a family to join'); return; }
      body = { code: c, mode: 'family', family_id: familyId };
    } else {
      const name = familyName.trim();
      const members = parsedMembers();
      if (!name) { setError('Family name is required'); return; }
      if (members.length === 0) { setError('Add at least one family member name'); return; }
      body = { code: c, mode: 'new_family', family_name: name, family_members: members };
    }
    setBusy(true); setError(null);
    try {
      const trip = await api<{ id: string }>('/trips/join', { method: 'POST', body });
      goToTrip(trip.id);
    } catch (e: any) {
      setError(e.message);
      // A family may have been claimed (or removed) between preview and submit —
      // refresh the picker so the stale row is reflected and can't be re-tried.
      if (mode === 'family' && (e.status === 400 || e.status === 404)) {
        try {
          const p = await api<Preview>('/trips/join/preview', { method: 'POST', body: { code: c } });
          setPreview(p);
          if (familyId && !p.families.some((f) => f.id === familyId && !f.linked)) setFamilyId(null);
        } catch { /* keep the original error message */ }
      }
    } finally { setBusy(false); }
  };

  // ---------- Stage 1: code entry ----------
  if (stage === 'code') {
    const continueDisabled = busy || code.length !== 6;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: SPACING.lg }} edges={['bottom']}>
        <T variant="h1">Join a trip</T>
        <T muted style={{ marginTop: 4 }}>Enter the 6-character trip code your friend shared.</T>

        <View style={{ marginTop: SPACING.xl, gap: SPACING.md }}>
          <TextInput testID="jt-code" value={code}
            onChangeText={(v) => { setCode(v.toUpperCase().replace(/\s/g, '').slice(0, 6)); if (error) setError(null); }}
            placeholder="ABCD12" placeholderTextColor={colors.textMuted}
            autoCapitalize="characters" editable={!busy}
            style={[styles.codeInput, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />

          {error ? <T testID="jt-error" variant="caption" color={colors.owing}>{error}</T> : null}

          <TouchableOpacity testID="jt-submit" onPress={loadPreview} disabled={continueDisabled}
            style={[styles.btn, { backgroundColor: colors.primary, opacity: continueDisabled ? 0.5 : 1 }]}>
            {busy ? <ActivityIndicator color={colors.primaryText} /> : <T color={colors.primaryText} variant="h3">Continue</T>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ---------- Stage 2: choose how to join ----------
  const families = preview?.families ?? [];
  const hasFamilies = families.length > 0;
  const allLinked = hasFamilies && families.every((f) => f.linked);
  const matchedId = preview?.matched_family?.id ?? null;
  const sortedFamilies = [...families].sort((a, b) =>
    (a.id === matchedId ? -1 : 0) - (b.id === matchedId ? -1 : 0));

  const confirmDisabled = busy
    || (mode === 'family' && !familyId)
    || (mode === 'new_family' && (!familyName.trim() || parsedMembers().length === 0));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }} keyboardShouldPersistTaps="handled">
          <TouchableOpacity testID="jt-back" onPress={backToCode} disabled={busy}
            style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' }}>
            <Ionicons name="chevron-back" size={18} color={colors.textMuted} />
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
                  style={[styles.modeCard, {
                    backgroundColor: active ? colors.primary : colors.surface,
                    borderColor: active ? colors.primary : colors.border,
                    opacity: optDisabled && !active ? 0.5 : 1,
                  }]}>
                  <Ionicons name={opt.icon} size={22} color={active ? colors.primaryText : colors.textMain} />
                  <View style={{ flex: 1, marginLeft: SPACING.md }}>
                    <T variant="h3" color={active ? colors.primaryText : colors.textMain}>{opt.title}</T>
                    <T variant="caption" color={active ? colors.primaryText : colors.textMuted} style={{ marginTop: 2 }}>{desc}</T>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {mode === 'family' && hasFamilies && (
            <View style={{ gap: SPACING.sm }}>
              {allLinked ? (
                <T testID="jt-family-all-linked" muted variant="caption">
                  All families are already claimed. Pick another option above.
                </T>
              ) : null}
              {sortedFamilies.map((f) => {
                const selected = familyId === f.id;
                const isMatched = f.id === matchedId;
                const rowDisabled = f.linked || busy;
                return (
                  <TouchableOpacity key={f.id} testID={`jt-family-${f.id}`} disabled={rowDisabled}
                    onPress={() => { setFamilyId(f.id); setError(null); }}
                    style={[styles.familyRow, {
                      backgroundColor: selected ? colors.surfaceMuted : colors.surface,
                      borderColor: selected ? colors.primary : colors.border,
                      opacity: f.linked ? 0.5 : 1,
                    }]}>
                    <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={20}
                      color={selected ? colors.primary : colors.textMuted} />
                    <View style={{ flex: 1, marginLeft: SPACING.sm, gap: 2 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
                        <T style={{ fontWeight: '600' }}>{f.name}</T>
                        {isMatched ? <Badge label="Recommended" color={colors.owed} /> : null}
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
              <View>
                <T variant="label" muted>Family name *</T>
                <TextInput testID="jt-family-name" value={familyName}
                  onChangeText={(v) => { setFamilyName(v); if (error) setError(null); }}
                  placeholder="e.g. Sharma Family" placeholderTextColor={colors.textMuted} editable={!busy}
                  style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
              </View>
              <View>
                <T variant="label" muted>Family member names (comma separated) *</T>
                <TextInput testID="jt-family-members" value={familyText}
                  onChangeText={(v) => { setFamilyText(v); if (error) setError(null); }}
                  placeholder="e.g. Arjun, Priya, Rohan" placeholderTextColor={colors.textMuted} editable={!busy}
                  style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
                <T muted variant="caption" style={{ marginTop: 4 }}>
                  List everyone in your family, including yourself. Expenses on this family split per member.
                </T>
              </View>
            </View>
          )}

          {error ? <T testID="jt-error" variant="caption" color={colors.owing}>{error}</T> : null}

          <TouchableOpacity testID="jt-join-confirm" onPress={submitJoin} disabled={confirmDisabled}
            style={[styles.btn, { backgroundColor: colors.primary, opacity: confirmDisabled ? 0.5 : 1 }]}>
            {busy ? <ActivityIndicator color={colors.primaryText} /> : <T color={colors.primaryText} variant="h3">Join trip</T>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  codeInput: { paddingHorizontal: SPACING.md, paddingVertical: 16, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 24, letterSpacing: 6, textAlign: 'center', fontWeight: '700' },
  input: { marginTop: 4, paddingHorizontal: SPACING.md, paddingVertical: 14, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 16 },
  btn: { paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
  modeCard: { flexDirection: 'row', alignItems: 'center', padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1 },
  familyRow: { flexDirection: 'row', alignItems: 'center', padding: SPACING.md, borderRadius: RADIUS.md, borderWidth: 1 },
  badge: { borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { fontWeight: '700', fontSize: 10 },
});
