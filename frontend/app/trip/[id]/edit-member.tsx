import React, { useEffect, useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE, isEmailTaken, DUPLICATE_EMAIL_MESSAGE } from '../../../src/validation';
import ConfirmModal from '../../../src/ConfirmModal';
import FamilyMembersEditor from '../../../src/FamilyMembersEditor';
import { FamilyRow, familyToRows, rowsToPayload, familyEmailIssue, tripMemberEmails } from '../../../src/familyParticipation';
import { Input, Button, SegmentedControl, useToast } from '../../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; family_member_ids?: (string | null)[]; family_member_emails?: (string | null)[]; email?: string | null; user_id?: string | null };

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
  const [familyRows, setFamilyRows] = useState<FamilyRow[]>([]);
  const [originalFM, setOriginalFM] = useState<string[]>([]);
  const [originalKind, setOriginalKind] = useState<'individual' | 'family'>('individual');
  const [qualifiesForRecalc, setQualifiesForRecalc] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [delta, setDelta] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  // Other members' linked emails (excluding this row), to mirror the server's one-email rule.
  const [takenEmails, setTakenEmails] = useState<(string | null | undefined)[]>([]);

  const emailError = email.trim() && !isGmail(email)
    ? GMAIL_ONLY_MESSAGE
    : isEmailTaken(email, takenEmails) ? DUPLICATE_EMAIL_MESSAGE : null;

  useEffect(() => {
    (async () => {
      const trip: any = await api(`/trips/${id}`);
      const m = (trip.members as Member[]).find((x) => x.id === mid);
      if (!m) return;
      setTakenEmails(tripMemberEmails(trip.members as Member[], mid));
      setMember(m); setName(m.name); setKind(m.kind); setEmail(m.email || '');
      setFamilyRows(familyToRows(m.family_members, m.family_member_ids, m.family_member_emails));
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
    const { family_members, family_member_ids, family_member_emails } = kind === 'family'
      ? rowsToPayload(familyRows) : { family_members: [], family_member_ids: [], family_member_emails: [] };
    if (kind === 'family' && family_members.length === 0) return toast.show('Add at least one family member name', 'error');
    try {
      await api(`/trips/${id}/members/${mid}`, {
        method: 'PATCH',
        body: { name: name.trim(), kind, family_members, family_member_ids, family_member_emails, email: email.trim() || null, reweight_past: reweightPast },
      });
      router.back();
    } catch (e: any) { toast.show(e.message || 'Could not save', 'error'); }
  };

  const submit = () => {
    if (!member) return;
    if (!name.trim()) return toast.show('Name is required', 'error');
    if (email.trim() && !isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    if (isEmailTaken(email, takenEmails)) return toast.show(DUPLICATE_EMAIL_MESSAGE, 'error');
    if (kind === 'family') {
      const issue = familyEmailIssue(familyRows, takenEmails);
      if (issue === 'gmail') return toast.show(GMAIL_ONLY_MESSAGE, 'error');
      if (issue === 'duplicate') return toast.show(DUPLICATE_EMAIL_MESSAGE, 'error');
    }
    const newFM = kind === 'family' ? rowsToPayload(familyRows).family_members : [];
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
              <FamilyMembersEditor rows={familyRows} onChange={setFamilyRows} takenEmails={takenEmails} testIDPrefix="em-fam" />
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
    </SafeAreaView>
  );
}
