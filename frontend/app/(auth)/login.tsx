import React, { useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';
import GoogleSignInButton, { googleAuthAvailable } from '../../src/GoogleSignInButton';
import { AuthShell, Card, Input, PinInput, Button, Icon, useToast } from '../../src/ui';

// TODO(login-ui): email-based password reset is temporarily hidden on the login screen. Flip this to
// re-enable the "Forgot password?" link. Nothing else is removed — the (auth)/forgot-password screen
// and the POST /auth/request-password-reset + /auth/reset-password endpoints remain intact.
const SHOW_FORGOT_PASSWORD = false;

export default function Login() {
  const { signIn, savedEmail, forgetSavedEmail, emailFeaturesEnabled } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState(savedEmail || '');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);

  const emailError = !!email && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;

  const submit = async () => {
    if (!email) return toast.show('Enter your email', 'error');
    if (!isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    if (pin.length !== 4) return toast.show('Enter your 4-digit PIN', 'error');
    setLoading(true);
    try {
      await signIn(email.trim(), undefined, pin);
      router.replace('/(tabs)/dashboard');
    } catch (e: any) {
      toast.show(e.message || 'Login failed. Try again.', 'error');
    } finally { setLoading(false); }
  };

  const useDifferent = async () => {
    await forgetSavedEmail();
    setEmail('');
    setPin('');
  };

  return (
    <AuthShell title={savedEmail ? 'Welcome back' : 'Sign in'} subtitle="Use your 4-digit PIN to continue.">
      {savedEmail ? (
        <Card style={styles.savedRow}>
          <Icon name="user-round" size={26} color={colors.primary} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="caption" muted>Signing in as</T>
            <T variant="h4" numberOfLines={1}>{savedEmail}</T>
          </View>
          <Button label="Switch" variant="ghost" size="sm" onPress={useDifferent} testID="login-switch-account" haptic={false} />
        </Card>
      ) : (
        <Input
          testID="login-email"
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          keyboardType="email-address"
          placeholder="you@gmail.com"
          icon="mail"
          error={emailError}
        />
      )}

      <View style={{ gap: SPACING.sm }}>
        <T variant="label" muted style={{ textAlign: 'center' }}>4-digit PIN</T>
        <PinInput testID="login-pin" value={pin} onChangeText={setPin} autoFocus={!!savedEmail} onSubmit={submit} />
      </View>

      <Button label="Unlock" icon="lock" onPress={submit} loading={loading} fullWidth size="lg" testID="login-submit" />

      <View style={styles.linksRow}>
        <Pressable testID="login-forgot-link" onPress={() => router.push('/(auth)/forgot')} hitSlop={8}>
          <T color={colors.primary}>Forgot PIN?</T>
        </Pressable>
        {/* Email-based password reset is hidden on the login UI (SHOW_FORGOT_PASSWORD). "Forgot PIN?"
            (no email) stays. See the flag comment at the top of this file to re-enable. */}
        {SHOW_FORGOT_PASSWORD && emailFeaturesEnabled !== false && (
          <Pressable testID="login-forgot-password-link" onPress={() => router.push('/(auth)/forgot-password')} hitSlop={8}>
            <T color={colors.primary}>Forgot password?</T>
          </Pressable>
        )}
      </View>

      {googleAuthAvailable && (
        <View style={styles.divider}>
          <View style={[styles.rule, { backgroundColor: colors.border }]} />
          <T variant="caption" muted>or continue with</T>
          <View style={[styles.rule, { backgroundColor: colors.border }]} />
        </View>
      )}
      <GoogleSignInButton />

      <View style={[styles.bottomRule, { backgroundColor: colors.border }]} />
      <View style={styles.bottomRow}>
        <T muted>New here?  </T>
        <Pressable testID="login-register-link" onPress={() => router.push('/(auth)/register')} hitSlop={8}>
          <T color={colors.primary} style={{ fontWeight: '700' }}>Create an account</T>
        </Pressable>
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, borderRadius: RADIUS.lg },
  // Centered so the lone "Forgot PIN?" isn't left-stranded; gap keeps it tidy if the password link
  // is re-enabled via SHOW_FORGOT_PASSWORD.
  linksRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: SPACING.lg },
  divider: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  bottomRule: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  bottomRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
});
