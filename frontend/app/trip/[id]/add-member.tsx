import React, { useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../../src/validation';
import { Input, Button, SegmentedControl, useToast } from '../../../src/ui';

export default function AddMember() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<'individual' | 'family'>('individual');
  const [familyText, setFamilyText] = useState('');
  const [saving, setSaving] = useState(false);

  const emailError = email.trim() && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;

  const submit = async () => {
    if (!name.trim()) return toast.show('Name is required', 'error');
    const family_members = kind === 'family' ? familyText.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (kind === 'family' && family_members.length === 0) return toast.show('Add at least one family member name', 'error');
    if (email.trim() && !isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    setSaving(true);
    try {
      await api(`/trips/${id}/members`, {
        method: 'POST',
        body: { name: name.trim(), kind, family_members, email: email.trim() || null },
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
              <Input
                testID="mem-family"
                label="Family member names (comma separated) *"
                value={familyText}
                onChangeText={setFamilyText}
                placeholder="e.g. Arjun, Priya, Rohan"
                helper="Expenses applied to this family will be split per family member."
              />
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
