import React, { useEffect, useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../../src/validation';
import ConfirmModal from '../../../src/ConfirmModal';
import { Input, Button, SegmentedControl, useToast } from '../../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; email?: string | null; user_id?: string | null };

const effWeight = (kind: 'individual' | 'family', fm: string[]) => (kind === 'family' ? fm.length : 1);

export default function EditMember() {
  const { id, mid } = useLocalSearchParams<{ id: string; mid: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
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
  const [confirmDelete, setConfirmDelete] = useState(false);

  const emailError = email.trim() && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;

  useEffect(() => {
    (async () => {
      const trip: any = await api(`/trips/${id}`);
      const m = (trip.members as Member[]).find((x) => x.id === mid);
      if (!m) return;
      setMember(m); setName(m.name); setKind(m.kind); setEmail(m.email || '');
      setFamilyText(m.family_members.join(', '));
      setOriginalFM(m.family_members);
      setOriginalKind(m.kind);
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
    if (!name.trim()) return toast.show('Name is required', 'error');
    const family_members = kind === 'family' ? familyText.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (kind === 'family' && family_members.length === 0) return toast.show('Add at least one family member name', 'error');
    try {
      await api(`/trips/${id}/members/${mid}`, {
        method: 'PATCH',
        body: { name: name.trim(), kind, family_members, email: email.trim() || null, reweight_past: reweightPast },
      });
      router.back();
    } catch (e: any) { toast.show(e.message || 'Could not save', 'error'); }
  };

  const submit = () => {
    if (!member) return;
    if (!name.trim()) return toast.show('Name is required', 'error');
    if (email.trim() && !isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    const newFM = kind === 'family' ? familyText.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (kind === 'family' && newFM.length === 0) return toast.show('Add at least one family member name', 'error');
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
    if (!member || member.user_id) return toast.show('App-user members cannot be removed.', 'error');
    setConfirmDelete(true);
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    try { await api(`/trips/${id}/members/${mid}`, { method: 'DELETE' }); router.back(); }
    catch (e: any) { toast.show(e.message || 'Delete failed', 'error'); }
  };

  if (!member) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><T style={{ padding: SPACING.lg }}>Loading…</T></SafeAreaView>;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <T variant="h1">Edit member</T>

            <SegmentedControl
              segments={[{ value: 'individual', label: 'Individual', icon: 'user' }, { value: 'family', label: 'Family', icon: 'users' }]}
              value={kind}
              onChange={setKind}
              testIDPrefix="em-kind"
            />

            <Input testID="em-name" label={`${kind === 'family' ? 'Family name' : 'Name'} *`} value={name} onChangeText={setName} />

            {kind === 'family' && (
              <Input testID="em-family" label="Family member names (comma separated) *" value={familyText} onChangeText={setFamilyText} />
            )}

            <Input
              testID="em-email"
              label="Linked email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="(optional) you@gmail.com"
              icon="mail"
              error={emailError}
            />

            <Button label="Save" icon="check" onPress={submit} fullWidth size="lg" testID="em-save" style={{ marginTop: SPACING.sm }} />

            {!member.user_id && (
              <Button label="Delete member" icon="trash" variant="destructive" onPress={onDelete} fullWidth testID="em-delete" />
            )}
          </View>
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

      <ConfirmModal
        visible={confirmDelete}
        title="Delete member?"
        message="This removes the member from the trip."
        onRequestClose={() => setConfirmDelete(false)}
        actions={[
          { label: 'Cancel', variant: 'cancel', onPress: () => setConfirmDelete(false) },
          { label: 'Delete', variant: 'destructive', onPress: doDelete, testID: 'em-delete-confirm' },
        ]}
      />
    </SafeAreaView>
  );
}
