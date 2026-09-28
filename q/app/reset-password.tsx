import React, { useState } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';
import {
  isValidPassword, PASSWORD_TOO_SHORT_MESSAGE, PASSWORD_MISMATCH_MESSAGE,
} from '../src/validation';
import { AuthShell, Input, Button, useToast } from '../src/ui';

// Landing page for the password-reset email link (top-level — works signed-out). Collects a new
// password (same rules as registration) and posts the token + password to the reset endpoint.
export default function ResetPassword() {
  const router = useRouter();
  const { refresh } = useAuth();
  const toast = useToast();
  const params = useLocalSearchParams<{ token?: string }>();
  const [token, setToken] = useState((params.token as string) || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<{
    field: 'token' | 'password' | 'confirm'; message: string;
  } | null>(null);

  const passwordError = fieldError?.field === 'password'
    ? fieldError.message : !!password && !isValidPassword(password) ? PASSWORD_TOO_SHORT_MESSAGE : null;
  const confirmError = fieldError?.field === 'confirm'
    ? fieldError.message : !!confirm && confirm !== password ? PASSWORD_MISMATCH_MESSAGE : null;

  const submit = async () => {
    if (!token.trim()) {
      setFieldError({ field: 'token', message: 'Enter the token from your email' });
      return toast.show('Enter the token from your email', 'error');
    }
    if (!isValidPassword(password)) {
      setFieldError({ field: 'password', message: PASSWORD_TOO_SHORT_MESSAGE });
      return toast.show(PASSWORD_TOO_SHORT_MESSAGE, 'error');
    }
    if (password !== confirm) {
      setFieldError({ field: 'confirm', message: PASSWORD_MISMATCH_MESSAGE });
      return toast.show(PASSWORD_MISMATCH_MESSAGE, 'error');
    }
    setFieldError(null);
    setBusy(true);
    try {
      await api('/auth/reset-password', {
        method: 'POST', body: { token: token.trim(), new_password: password }, auth: false,
      });
      await refresh();
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
      subtitle="Choose a secure new password for your account."
    >
      <Input
        testID="reset-pw-token"
        label="Reset token"
        value={token}
        onChangeText={(value) => { setToken(value); if (fieldError?.field === 'token') setFieldError(null); }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        placeholder="Token from email"
        icon="key"
        error={fieldError?.field === 'token' ? fieldError.message : null}
        focusOnError={fieldError?.field === 'token'}
        returnKeyType="next"
      />
      <Input
        testID="reset-pw-password"
        label="New password"
        value={password}
        onChangeText={(value) => { setPassword(value); if (fieldError?.field === 'password') setFieldError(null); }}
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
        secureTextEntry
        placeholder="At least 9 characters"
        icon="lock"
        error={passwordError}
        focusOnError={fieldError?.field === 'password'}
        returnKeyType="next"
      />
      <Input
        testID="reset-pw-confirm"
        label="Confirm password"
        value={confirm}
        onChangeText={(value) => { setConfirm(value); if (fieldError?.field === 'confirm') setFieldError(null); }}
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
        secureTextEntry
        placeholder="Re-enter your password"
        icon="lock"
        error={confirmError}
        focusOnError={fieldError?.field === 'confirm'}
        returnKeyType="done"
        onSubmitEditing={submit}
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
