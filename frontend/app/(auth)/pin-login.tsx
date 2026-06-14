import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';

export default function PinLogin() {
  const { signIn } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');

  const submit = async () => {
    if (!email || pin.length !== 4) return Alert.alert('Missing', 'Email + 4-digit PIN');
    if (!isGmail(email)) return Alert.alert('Invalid email', GMAIL_ONLY_MESSAGE);
    try {
      await signIn(email.trim(), undefined, pin);
      router.replace('/(tabs)/dashboard');
    } catch (e: any) {
      Alert.alert('Login failed', e.message || 'Try again');
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: SPACING.lg }}>
      <T variant="h2">Quick PIN login</T>
      <T muted style={{ marginTop: 4 }}>For returning users</T>

      <View style={{ marginTop: SPACING.lg, gap: SPACING.md }}>
        <View>
          <TextInput testID="pin-email" value={email} onChangeText={setEmail}
            autoCapitalize="none" keyboardType="email-address"
            placeholder="Email" placeholderTextColor={colors.textMuted}
            style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          {!!email && !isGmail(email) && (
            <T variant="caption" color={colors.owing} style={{ marginTop: 4 }}>{GMAIL_ONLY_MESSAGE}</T>
          )}
        </View>
        <TextInput testID="pin-code" value={pin}
          onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))}
          secureTextEntry keyboardType="number-pad" maxLength={4}
          placeholder="PIN" placeholderTextColor={colors.textMuted}
          style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border, letterSpacing: 12, textAlign: 'center', fontSize: 24 }]} />

        <TouchableOpacity testID="pin-submit" onPress={submit}
          style={[styles.btn, { backgroundColor: colors.primary }]}>
          <T variant="h3" color={colors.primaryText}>Unlock</T>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  input: { paddingHorizontal: SPACING.md, paddingVertical: 14, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 16 },
  btn: { paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
