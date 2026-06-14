import React, { useState } from 'react';
import {
  View, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  Platform, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';
import GoogleSignInButton from '../../src/GoogleSignInButton';

export default function Login() {
  const { signIn, savedEmail, forgetSavedEmail } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [email, setEmail] = useState(savedEmail || '');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email) return Alert.alert('Missing', 'Enter your email');
    if (!isGmail(email)) return Alert.alert('Invalid email', GMAIL_ONLY_MESSAGE);
    if (pin.length !== 4) return Alert.alert('Missing', 'Enter your 4-digit PIN');
    setLoading(true);
    try {
      await signIn(email.trim(), undefined, pin);
      router.replace('/(tabs)/dashboard');
    } catch (e: any) {
      Alert.alert('Login failed', e.message || 'Try again');
    } finally { setLoading(false); }
  };

  const useDifferent = async () => {
    await forgetSavedEmail();
    setEmail('');
    setPin('');
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={[styles.brand, { backgroundColor: colors.primary }]}>
            <Ionicons name="airplane" size={28} color={colors.primaryText} />
          </View>
          <T variant="h1" style={{ marginTop: SPACING.lg }}>
            {savedEmail ? 'Welcome back' : 'Sign in'}
          </T>
          <T variant="body" muted style={{ marginTop: SPACING.xs }}>
            Use your 4-digit PIN to continue.
          </T>

          <View style={{ marginTop: SPACING.xl, gap: SPACING.md }}>
            {savedEmail ? (
              <View style={[styles.savedEmailBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Ionicons name="person-circle-outline" size={28} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <T variant="caption" muted>Signing in as</T>
                  <T variant="h3">{savedEmail}</T>
                </View>
                <TouchableOpacity testID="login-switch-account" onPress={useDifferent}>
                  <T color={colors.primary} style={{ fontWeight: '700' }}>Switch</T>
                </TouchableOpacity>
              </View>
            ) : (
              <View>
                <T variant="label" muted>Email</T>
                <TextInput
                  testID="login-email"
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  placeholder="you@gmail.com"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}
                />
                {!!email && !isGmail(email) && (
                  <T variant="caption" color={colors.owing} style={{ marginTop: 4 }}>{GMAIL_ONLY_MESSAGE}</T>
                )}
              </View>
            )}

            <View>
              <T variant="label" muted>4-digit PIN</T>
              <TextInput
                testID="login-pin"
                value={pin}
                onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))}
                secureTextEntry
                keyboardType="number-pad"
                maxLength={4}
                autoFocus={!!savedEmail}
                placeholder="••••"
                placeholderTextColor={colors.textMuted}
                style={[styles.pinInput, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}
              />
            </View>

            <TouchableOpacity
              testID="login-submit"
              onPress={submit}
              disabled={loading}
              style={[styles.btn, { backgroundColor: colors.primary }]}
            >
              {loading ? <ActivityIndicator color={colors.primaryText} /> :
                <T variant="h3" color={colors.primaryText}>Unlock</T>}
            </TouchableOpacity>

            <Link href="/(auth)/forgot" asChild>
              <TouchableOpacity testID="login-forgot-link">
                <T color={colors.primary} style={{ textAlign: 'center' }}>Forgot PIN?</T>
              </TouchableOpacity>
            </Link>

            <GoogleSignInButton />

            <View style={styles.bottomRow}>
              <T muted>New here?  </T>
              <Link href="/(auth)/register" asChild>
                <TouchableOpacity testID="login-register-link"><T color={colors.primary} style={{ fontWeight: '700' }}>Create an account</T></TouchableOpacity>
              </Link>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: SPACING.lg, flexGrow: 1, justifyContent: 'center' },
  brand: {
    width: 56, height: 56, borderRadius: RADIUS.lg,
    alignItems: 'center', justifyContent: 'center',
  },
  input: {
    marginTop: SPACING.xs, paddingHorizontal: SPACING.md, paddingVertical: 14,
    borderRadius: RADIUS.md, borderWidth: 1, fontSize: 16,
  },
  pinInput: {
    marginTop: SPACING.xs, paddingHorizontal: SPACING.md, paddingVertical: 18,
    borderRadius: RADIUS.md, borderWidth: 1,
    fontSize: 28, fontWeight: '700', letterSpacing: 16, textAlign: 'center',
  },
  savedEmailBox: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1,
  },
  btn: {
    marginTop: SPACING.sm, paddingVertical: 16, borderRadius: RADIUS.pill,
    alignItems: 'center',
  },
  bottomRow: { flexDirection: 'row', justifyContent: 'center' },
});
