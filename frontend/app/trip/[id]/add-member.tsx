import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, CONTROL } from '../../../src/theme';
import T from '../../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../../src/validation';

export default function AddMember() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<'individual' | 'family'>('individual');
  const [familyText, setFamilyText] = useState('');

  const submit = async () => {
    if (!name.trim()) return Alert.alert('Missing', 'Name is required');
    const family_members = kind === 'family'
      ? familyText.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (kind === 'family' && family_members.length === 0) {
      return Alert.alert('Missing', 'Add at least one family member name');
    }
    if (email.trim() && !isGmail(email)) return Alert.alert('Invalid email', GMAIL_ONLY_MESSAGE);
    try {
      await api(`/trips/${id}/members`, {
        method: 'POST',
        body: {
          name: name.trim(), kind, family_members,
          email: email.trim() || null,
        },
      });
      router.back();
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }} keyboardShouldPersistTaps="handled">
          <T variant="h1">Add member</T>

          <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
            {(['individual', 'family'] as const).map((k) => (
              <TouchableOpacity key={k} onPress={() => setKind(k)}
                testID={`mem-kind-${k}`}
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
            <TextInput testID="mem-name" value={name} onChangeText={setName}
              placeholder={kind === 'family' ? 'e.g. Sharma Family' : 'e.g. Priya'}
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          {kind === 'family' && (
            <View>
              <T variant="label" muted>Family member names (comma separated) *</T>
              <TextInput testID="mem-family" value={familyText} onChangeText={setFamilyText}
                placeholder="e.g. Arjun, Priya, Rohan"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
              <T muted variant="caption" style={{ marginTop: 4 }}>
                Expenses applied to this family will be split per family member.
              </T>
            </View>
          )}

          <View>
            <T variant="label" muted>Linked email (optional)</T>
            <TextInput testID="mem-email" value={email} onChangeText={setEmail}
              autoCapitalize="none" keyboardType="email-address"
              placeholder="family@gmail.com"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
            {email.trim() && !isGmail(email) ? (
              <T variant="caption" color={colors.owing} style={{ marginTop: 4 }}>{GMAIL_ONLY_MESSAGE}</T>
            ) : (
              <T muted variant="caption" style={{ marginTop: 4 }}>
                If this email belongs to an app user, they'll be automatically linked to this {kind === 'family' ? 'family' : 'member'} when they join the trip.
              </T>
            )}
          </View>

          <TouchableOpacity testID="mem-submit" onPress={submit}
            style={[styles.btn, { backgroundColor: colors.primary }]}>
            <T color={colors.primaryText} variant="h3">Add member</T>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.pill, borderWidth: 1 },
  input: { marginTop: 4, paddingHorizontal: SPACING.md, paddingVertical: CONTROL.paddingY, borderRadius: CONTROL.radius, borderWidth: 1, fontSize: CONTROL.fontSize },
  btn: { marginTop: SPACING.md, paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
