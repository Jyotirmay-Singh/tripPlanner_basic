import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';
import { SPACING } from '../src/theme';
import T from '../src/T';
import {
  isValidPassword, PASSWORD_TOO_SHORT_MESSAGE, PASSWORD_MISMATCH_MESSAGE,
} from '../src/validation';
import { AuthShell, Input, PinInput, Button, useToast } from '../src/ui';

// One-time "set PIN + password" step for a first-time Google user (whose pin/password are random
// placeholders). Reached while signed in (Bearer), so it's a top-level route — the auth guard
// only bounces signed-in users out of the (auth) group, not from here. Also reachable later from
// Profile. Skippable: the dashboard banner / next Google login will prompt again.
export default function SetCredentials() {
  const router = useRouter();
  const toast = useToast();
  const { refresh } = useAuth();
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const passwordError = !!password && !isValidPassword(password) ? PASSWORD_TOO_SHORT_MESSAGE : null;
  const confirmError = !!confirm && confirm !== password ? PASSWORD_MISMATCH_MESSAGE : null;

  const goDashboard = () => router.replace('/(tabs)/dashboard');

  const submit = async () => {
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) return toast.show('Choose a 4-digit PIN', 'error');
    if (!isValidPassword(password)) return toast.show(PASSWORD_TOO_SHORT_MESSAGE, 'error');
    if (password !== confirm) return toast.show(PASSWORD_MISMATCH_MESSAGE, 'error');
    setBusy(true);
    try {
      await api('/auth/set-credentials', { method: 'POST', body: { pin, password } });
      await refresh().catch(() => {});
      toast.show('All set! You can now sign in with your email + PIN.', 'success');
      goDashboard();
    } catch (e: any) {
      toast.show(e.message || 'Could not save. Try again.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <AuthShell
      brandIcon="shield-check"
      title="Set up quick sign-in"
      subtitle="Choose a 4-digit PIN and a password so you can sign in without Google next time."
    >
      <View style={{ gap: SPACING.sm }}>
        <T variant="label" muted style={{ textAlign: 'center' }}>Choose a 4-digit PIN</T>
        <PinInput testID="setcred-pin" value={pin} onChangeText={setPin} />
      </View>
      <Input
        testID="setcred-password"
        label="Password"
        value={password}
        onChangeText={setPassword}
        autoCapitalize="none"
        secureTextEntry
        placeholder="At least 9 characters"
        icon="lock"
        error={passwordError}
      />
      <Input
        testID="setcred-confirm"
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        autoCapitalize="none"
        secureTextEntry
        placeholder="Re-enter your password"
        icon="lock"
        error={confirmError}
      />
      <T muted variant="caption" style={{ textAlign: 'center' }}>
        {"Choose a password you'll remember — for your security, we can't recover it for you."}
      </T>
      <Button label="Save & continue" icon="check" onPress={submit} loading={busy} fullWidth size="lg" testID="setcred-submit" />
      <Button label="Skip for now" variant="ghost" onPress={goDashboard} fullWidth testID="setcred-skip" haptic={false} />
    </AuthShell>
  );
}
