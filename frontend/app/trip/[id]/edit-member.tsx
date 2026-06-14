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

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; email?: string | null; user_id?: string | null };

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
  const [hasExpenses, setHasExpenses] = useState(false);

  useEffect(() => {
    (async () => {
      const trip: any = await api(`/trips/${id}`);
      const m = (trip.members as Member[]).find((x) => x.id === mid);
      if (!m) return;
      setMember(m); setName(m.name); setKind(m.kind); setEmail(m.email || '');
      setFamilyText(m.family_members.join(', '));
      setOriginalFM(m.family_members);
      // check if this member has any expenses
      const exps: any[] = await api(`/trips/${id}/expenses`);
      const used = exps.some((e) => e.paid_by_member_id === mid || (e.split_member_ids || []).includes(mid));
      setHasExpenses(used);
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
    if (email.trim() && !isGmail(email)) return Alert.alert('Invalid email', GMAIL_ONLY_MESSAGE);
    const newFM = kind === 'family'
      ? familyText.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const familyChanged = kind === 'family' && hasExpenses &&
      JSON.stringify(newFM) !== JSON.stringify(originalFM) &&
      newFM.length !== originalFM.length;

    if (familyChanged) {
      Alert.alert(
        'Apply to past expenses?',
        `The number of family members changed (${originalFM.length} → ${newFM.length}).\n\nShould past expenses be re-split among the NEW members, or keep the ORIGINAL split?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Keep original split', onPress: () => save(false) },
          { text: 'Re-split with new members', onPress: () => save(true) },
        ]
      );
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.pill, borderWidth: 1 },
  input: { marginTop: 4, paddingHorizontal: SPACING.md, paddingVertical: 14, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 16 },
  btn: { marginTop: SPACING.md, paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
