import React, { useEffect, useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS } from '../../../src/theme';
import T from '../../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../../src/validation';
import ConfirmModal from '../../../src/ConfirmModal';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; email?: string | null; user_id?: string | null };

// Effective per-capita weight of a member: a family counts as its roster size, anything else as 1.
const effWeight = (kind: 'individual' | 'family', fm: string[]) => (kind === 'family' ? fm.length : 1);

export default function EditMember() {
  const { id, mid } = useLocalSearchParams<{ id: string; mid: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const [member, setMember] = useState<Member | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<'individual' | 'family'>('individual');
  const [familyText, setFamilyText] = useState('');
  const [originalFM, setOriginalFM] = useState<string[]>([]);
  const [originalKind, setOriginalKind] = useState<'individual' | 'family'>('individual');
  const [qualifiesForRecalc, setQualifiesForRecalc] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [delta, setDelta] = useState<{ from: number; to: number }>({ from: 0, to: 0 });

  useEffect(() => {
    (async () => {
      const trip: any = await api(`/trips/${id}`);
      const m = (trip.members as Member[]).find((x) => x.id === mid);
      if (!m) return;
      setMember(m); setName(m.name); setKind(m.kind); setEmail(m.email || '');
      setFamilyText(m.family_members.join(', '));
      setOriginalFM(m.family_members);
      setOriginalKind(m.kind);
      // Does this member participate in any past expense the backend would re-split? Mirror the
      // backend recalc query (reallocation._load_candidate_expenses): split_mode != PER_FAMILY
      // (missing/legacy counts as PER_CAPITA) AND the member is in the split (or split is empty =
      // everyone) OR paid for it.
      const exps: any[] = await api(`/trips/${id}/expenses`);
      const used = exps.some((e) => {
        if ((e.split_mode || 'PER_CAPITA') === 'PER_FAMILY') return false;
        const splitIds: string[] = e.split_member_ids || [];
        return splitIds.length === 0 || splitIds.includes(mid) || e.paid_by_member_id === mid;
      });
      setQualifiesForRecalc(used);
    })();
  }, [id, mid]);

  const save = async (reweightPast: boolean) => {
    if (!name.trim()) return Alert.alert('Missing', 'Name is required');
    const family_members = kind === 'family'
      ? familyText.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (kind === 'family' && family_members.length === 0) {
      return Alert.alert('Missing', 'Add at least one family member name');
    }
    try {
      await api(`/trips/${id}/members/${mid}`, {
        method: 'PATCH',
        body: {
          name: name.trim(), kind, family_members,
          email: email.trim() || null,
          reweight_past: reweightPast,
        },
      });
      router.back();
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const submit = () => {
    if (!member) return;
    if (!name.trim()) return Alert.alert('Missing', 'Name is required');
    if (email.trim() && !isGmail(email)) return Alert.alert('Invalid email', GMAIL_ONLY_MESSAGE);
    const newFM = kind === 'family'
      ? familyText.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (kind === 'family' && newFM.length === 0) {
      return Alert.alert('Missing', 'Add at least one family member name');
    }
    // A change to the member's effective per-capita weight (family grow/shrink, or family<->individual)
    // re-splits past PER_CAPITA expenses. Prompt only when qualifying past expenses exist.
    const oldW = effWeight(originalKind, originalFM);
    const newW = effWeight(kind, newFM);
    if (oldW !== newW && qualifiesForRecalc) {
      setDelta({ from: oldW, to: newW });
      setModalVisible(true);
    } else {
      save(true);
    }
  };

  const onDelete = () => {
    if (!member || member.user_id) {
      return Alert.alert('Cannot delete', 'App-user members cannot be removed.');
    }
    Alert.alert('Delete member?', '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try { await api(`/trips/${id}/members/${mid}`, { method: 'DELETE' }); router.back(); }
          catch (e: any) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  if (!member) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><T style={{ padding: SPACING.lg }}>Loading…</T></SafeAreaView>;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }} keyboardShouldPersistTaps="handled">
          <T variant="h1">Edit member</T>

          <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
            {(['individual', 'family'] as const).map((k) => (
              <TouchableOpacity key={k} onPress={() => setKind(k)}
                testID={`em-kind-${k}`}
                style={[styles.pill, { backgroundColor: kind === k ? colors.primary : colors.surfaceMuted, borderColor: colors.border }]}>
                <Ionicons name={k === 'family' ? 'people' : 'person'} size={16}
                  color={kind === k ? colors.primaryText : colors.textMain} />
                <T style={{ fontWeight: '700', marginLeft: 6 }}
                  color={kind === k ? colors.primaryText : colors.textMain}>
                  {k === 'family' ? 'Family' : 'Individual'}
                </T>
              </TouchableOpacity>
            ))}
          </View>

          <View>
            <T variant="label" muted>{kind === 'family' ? 'Family name' : 'Name'} *</T>
            <TextInput testID="em-name" value={name} onChangeText={setName}
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          {kind === 'family' && (
            <View>
              <T variant="label" muted>Family member names (comma separated) *</T>
              <TextInput testID="em-family" value={familyText} onChangeText={setFamilyText}
                placeholderTextColor={colors.textMuted}
                style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
            </View>
          )}

          <View>
            <T variant="label" muted>Linked email</T>
            <TextInput testID="em-email" value={email} onChangeText={setEmail}
              autoCapitalize="none" keyboardType="email-address"
              placeholder="(optional) you@gmail.com"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
            {!!email.trim() && !isGmail(email) && (
              <T variant="caption" color={colors.owing} style={{ marginTop: 4 }}>{GMAIL_ONLY_MESSAGE}</T>
            )}
          </View>

          <TouchableOpacity testID="em-save" onPress={submit}
            style={[styles.btn, { backgroundColor: colors.primary }]}>
            <T color={colors.primaryText} variant="h3">Save</T>
          </TouchableOpacity>

          {!member.user_id && (
            <TouchableOpacity testID="em-delete" onPress={onDelete}
              style={[styles.btn, { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.owing }]}>
              <T color={colors.owing} style={{ fontWeight: '700' }}>Delete member</T>
            </TouchableOpacity>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmModal
        visible={modalVisible}
        testID="recalc-modal"
        title="Apply to past expenses?"
        message={`The number of people in this split changed (${delta.from} → ${delta.to}). Apply updates retroactively to prior expenses, or apply to future items only?`}
        onRequestClose={() => setModalVisible(false)}
        actions={[
          { label: 'Apply retroactively', variant: 'primary', testID: 'recalc-retro', onPress: () => { setModalVisible(false); save(true); } },
          { label: 'Future items only', variant: 'default', testID: 'recalc-future', onPress: () => { setModalVisible(false); save(false); } },
          { label: 'Cancel', variant: 'cancel', testID: 'recalc-cancel', onPress: () => setModalVisible(false) },
        ]}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.pill, borderWidth: 1 },
  input: { marginTop: 4, paddingHorizontal: SPACING.md, paddingVertical: 14, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 16 },
  btn: { marginTop: SPACING.md, paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
