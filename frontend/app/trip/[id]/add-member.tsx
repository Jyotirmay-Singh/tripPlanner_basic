import React, { useEffect, useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE, isEmailTaken, DUPLICATE_EMAIL_MESSAGE } from '../../../src/validation';
import FamilyMembersEditor from '../../../src/FamilyMembersEditor';
import { FamilyRow, rowsToPayload } from '../../../src/familyParticipation';
import { Input, Button, SegmentedControl, useToast } from '../../../src/ui';

export default function AddMember() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<'individual' | 'family'>('individual');
  const [familyRows, setFamilyRows] = useState<FamilyRow[]>([{ id: null, name: '' }]);
  const [saving, setSaving] = useState(false);
  // Existing trip linked-emails, to mirror the server's one-email-per-trip rule (UX only).
  const [takenEmails, setTakenEmails] = useState<(string | null | undefined)[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const trip: any = await api(`/trips/${id}`);
        setTakenEmails((trip.members || []).map((m: any) => m.email));
      } catch { /* the server still enforces uniqueness on submit */ }
    })();
  }, [id]);

  const emailError = email.trim() && !isGmail(email)
    ? GMAIL_ONLY_MESSAGE
    : isEmailTaken(email, takenEmails) ? DUPLICATE_EMAIL_MESSAGE : null;

  const submit = async () => {
    if (!name.trim()) return toast.show('Name is required', 'error');
    const { family_members, family_member_ids } = kind === 'family'
      ? rowsToPayload(familyRows) : { family_members: [], family_member_ids: [] };
    if (kind === 'family' && family_members.length === 0) return toast.show('Add at least one family member name', 'error');
    if (email.trim() && !isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    if (isEmailTaken(email, takenEmails)) return toast.show(DUPLICATE_EMAIL_MESSAGE, 'error');
    setSaving(true);
    try {
      await api(`/trips/${id}/members`, {
        method: 'POST',
        body: { name: name.trim(), kind, family_members, family_member_ids, email: email.trim() || null },
      });
      router.back();
    } catch (e: any) { toast.show(e.message || 'Could not add member', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <T variant="h1">Add member</T>

            <SegmentedControl
              segments={[{ value: 'individual', label: 'Individual', icon: 'user' }, { value: 'family', label: 'Family', icon: 'users' }]}
              value={kind}
              onChange={setKind}
              testIDPrefix="mem-kind"
            />

            <Input
              testID="mem-name"
              label={`${kind === 'family' ? 'Family name' : 'Name'} *`}
              value={name}
              onChangeText={setName}
              placeholder={kind === 'family' ? 'e.g. Sharma Family' : 'e.g. Priya'}
            />

            {kind === 'family' && (
              <FamilyMembersEditor rows={familyRows} onChange={setFamilyRows} testIDPrefix="mem-fam" />
            )}

            <Input
              testID="mem-email"
              label="Linked email (optional)"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="family@gmail.com"
              icon="mail"
              error={emailError}
              helper={`If this email belongs to an app user, they'll be linked to this ${kind === 'family' ? 'family' : 'member'} when they join.`}
            />

            <Button label="Add member" icon="plus" onPress={submit} loading={saving} fullWidth size="lg" testID="mem-submit" style={{ marginTop: SPACING.sm }} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
