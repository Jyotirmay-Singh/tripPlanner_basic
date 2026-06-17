import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { api } from '../../src/api';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS, CONTROL } from '../../src/theme';
import T from '../../src/T';

export default function Reset() {
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const [token, setToken] = useState((params.token as string) || '');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!token) return Alert.alert('Missing', 'Enter the reset token from your email');
    if (!/^\d{4}$/.test(pin)) return Alert.alert('Invalid', 'PIN must be 4 digits');
    setBusy(true);
    try {
      await api('/auth/reset-pin', { method: 'POST', body: { token: token.trim(), new_pin: pin }, auth: false });
      Alert.alert('Success', 'PIN reset. Please sign in with your new PIN.', [
        { text: 'OK', onPress: () => router.replace('/(auth)/login') },
      ]);
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: SPACING.lg }}>
      <T variant="h2">Reset PIN</T>
      <T muted style={{ marginTop: 4 }}>Paste the token from your email and choose a new 4-digit PIN.</T>

      <View style={{ marginTop: SPACING.lg, gap: SPACING.md }}>
        <TextInput testID="reset-token" value={token} onChangeText={setToken}
          placeholder="Reset token from email" placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
        <TextInput testID="reset-pin" value={pin}
          onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))}
          secureTextEntry keyboardType="number-pad" maxLength={4}
          placeholder="New 4-digit PIN" placeholderTextColor={colors.textMuted}
          style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border, letterSpacing: 12, textAlign: 'center', fontSize: 24 }]} />
        <TouchableOpacity testID="reset-submit" onPress={submit} disabled={busy}
          style={[styles.btn, { backgroundColor: colors.primary }]}>
          <T variant="h3" color={colors.primaryText}>{busy ? 'Resetting…' : 'Reset PIN'}</T>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  input: { paddingHorizontal: SPACING.md, paddingVertical: CONTROL.paddingY, borderRadius: CONTROL.radius, borderWidth: 1, fontSize: CONTROL.fontSize },
  btn: { paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
