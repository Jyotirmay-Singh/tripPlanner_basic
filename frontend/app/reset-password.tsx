import React, { useState } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { api } from '../src/api';
import {
  isValidPassword, PASSWORD_TOO_SHORT_MESSAGE, PASSWORD_MISMATCH_MESSAGE,
} from '../src/validation';
import { AuthShell, Input, Button, useToast } from '../src/ui';

// Landing page for the password-reset email link (top-level — works signed-out). Collects a new
// password (same rules as registration) and posts the token + password to the reset endpoint.
export default function ResetPassword() {
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ token?: string }>();
  const [token, setToken] = useState((params.token as string) || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const passwordError = !!password && !isValidPassword(password) ? PASSWORD_TOO_SHORT_MESSAGE : null;
  const confirmError = !!confirm && confirm !== password ? PASSWORD_MISMATCH_MESSAGE : null;

  const submit = async () => {
    if (!token) return toast.show('Enter the token from your email', 'error');
    if (!isValidPassword(password)) return toast.show(PASSWORD_TOO_SHORT_MESSAGE, 'error');
    if (password !== confirm) return toast.show(PASSWORD_MISMATCH_MESSAGE, 'error');
    setBusy(true);
    try {
      await api('/auth/reset-password', {
        method: 'POST', body: { token: token.trim(), new_password: password }, auth: false,
      });
      toast.show('Password updated. Sign in with your new password.', 'success');
      setTimeout(() => router.replace('/(auth)/login'), 900);
    } catch (e: any) {
      toast.show(e.message || 'This link is invalid or has expired.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <AuthShell
      brandIcon="lock"
      title="Reset password"
      subtitle="Choose a new password. Your 4-digit PIN stays the same."
    >
      <Input
        testID="reset-pw-token"
        label="Reset token"
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        placeholder="Token from email"
        icon="key"
      />
      <Input
        testID="reset-pw-password"
        label="New password"
        value={password}
        onChangeText={setPassword}
        autoCapitalize="none"
        secureTextEntry
        placeholder="At least 9 characters"
        icon="lock"
        error={passwordError}
      />
      <Input
        testID="reset-pw-confirm"
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        autoCapitalize="none"
        secureTextEntry
        placeholder="Re-enter your password"
        icon="lock"
        error={confirmError}
      />
      <Button
        label={busy ? 'Updating…' : 'Set new password'}
        icon="check"
        onPress={submit}
        loading={busy}
        fullWidth
        size="lg"
        testID="reset-pw-submit"
      />
    </AuthShell>
  );
}
