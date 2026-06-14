import React, { useState } from 'react';
import {
  View, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  Platform, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';
import GoogleSignInButton from '../../src/GoogleSignInButton';

export default function Register() {
  const { register } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!name || !email || pin.length !== 4) {
      return Alert.alert('Missing', 'Fill name, email, and a 4-digit PIN.');
    }
    if (!isGmail(email)) return Alert.alert('Invalid email', GMAIL_ONLY_MESSAGE);
    if (!/^\d{4}$/.test(pin)) return Alert.alert('Invalid PIN', 'PIN must be 4 digits');
    setLoading(true);
    try {
      await register(email.trim(), pin, name.trim());
      router.replace('/(tabs)/dashboard');
    } catch (e: any) {
      Alert.alert('Registration failed', e.message || 'Try again');
    } finally { setLoading(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }} keyboardShouldPersistTaps="handled">
          <T variant="h1">Let's get started</T>
          <T muted>Your trips, shared seamlessly.</T>

          <View>
            <T variant="label" muted>Your name</T>
            <TextInput testID="reg-name" value={name} onChangeText={setName}
              placeholder="Jane Doe" placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>
          <View>
            <T variant="label" muted>Email</T>
            <TextInput testID="reg-email" value={email} onChangeText={setEmail}
              autoCapitalize="none" keyboardType="email-address"
              placeholder="you@gmail.com" placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
            {!!email && !isGmail(email) && (
              <T variant="caption" color={colors.owing} style={{ marginTop: 4 }}>{GMAIL_ONLY_MESSAGE}</T>
            )}
          </View>
          <View>
            <T variant="label" muted>4-digit PIN (your only login credential)</T>
            <TextInput testID="reg-pin" value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))}
              secureTextEntry keyboardType="number-pad" maxLength={4}
              placeholder="0000" placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border, letterSpacing: 8 }]} />
            <T muted variant="caption" style={{ marginTop: 4 }}>
              You'll log in using only your email + PIN. If you forget your PIN, you can reset it via email.
            </T>
          </View>

          <TouchableOpacity testID="reg-submit" onPress={submit} disabled={loading}
            style={[styles.btn, { backgroundColor: colors.primary }]}>
            {loading ? <ActivityIndicator color={colors.primaryText} /> :
              <T variant="h3" color={colors.primaryText}>Create account</T>}
          </TouchableOpacity>

          <GoogleSignInButton />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  input: { marginTop: SPACING.xs, paddingHorizontal: SPACING.md, paddingVertical: 14, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 16 },
  btn: { marginTop: SPACING.md, paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
