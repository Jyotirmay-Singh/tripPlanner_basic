import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { api } from '../../src/api';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';

export default function Forgot() {
  const { colors } = useTheme();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email) return;
    if (!isGmail(email)) return Alert.alert('Invalid email', GMAIL_ONLY_MESSAGE);
    setBusy(true);
    try {
      await api('/auth/forgot-pin', { method: 'POST', body: { email: email.trim() }, auth: false });
      Alert.alert(
        'Check your email',
        'If an account exists, a PIN reset link has been sent to your email. Open the email and tap the link, or copy the token and use it on the next screen.',
        [{ text: 'Continue', onPress: () => router.replace('/(auth)/reset') }]
      );
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: SPACING.lg }}>
      <T variant="h2">Forgot PIN</T>
      <T muted style={{ marginTop: 4 }}>Enter your email and we'll send you a link to reset your 4-digit PIN.</T>

      <View style={{ marginTop: SPACING.lg, gap: SPACING.md }}>
        <View>
          <TextInput testID="forgot-email" value={email} onChangeText={setEmail}
            autoCapitalize="none" keyboardType="email-address"
            placeholder="you@gmail.com" placeholderTextColor={colors.textMuted}
            style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          {!!email && !isGmail(email) && (
            <T variant="caption" color={colors.owing} style={{ marginTop: 4 }}>{GMAIL_ONLY_MESSAGE}</T>
          )}
        </View>

        <TouchableOpacity testID="forgot-submit" onPress={submit} disabled={busy}
          style={[styles.btn, { backgroundColor: colors.primary }]}>
          <T variant="h3" color={colors.primaryText}>{busy ? 'Sending…' : 'Send reset link'}</T>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.push('/(auth)/reset')}>
          <T color={colors.primary} style={{ textAlign: 'center' }}>I already have a token</T>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  input: { paddingHorizontal: SPACING.md, paddingVertical: 14, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 16 },
  btn: { paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
