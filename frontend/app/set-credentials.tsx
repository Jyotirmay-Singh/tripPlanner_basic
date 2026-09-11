import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';
import {
  isValidPassword,
  PASSWORD_TOO_SHORT_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_HINT_MESSAGE,
} from '../src/validation';
import { AuthShell, Input, Button, useToast } from '../src/ui';
import { postAuthHref, upiSetupHref } from '../src/inviteNavigation';

// Google verifies account ownership. This required one-time step adds the local password that
// enables email/password sign-in before the user can enter protected application screens.
export default function SetCredentials() {
  const router = useRouter();
  const toast = useToast();
  const { refresh, signOut, pendingInvitePath, upiOnboardingPending } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [action, setAction] = useState<'save' | 'switch' | null>(null);
  const busy = action !== null;
  const [fieldError, setFieldError] = useState<{ field: 'password' | 'confirm'; message: string } | null>(null);

  const passwordError = fieldError?.field === 'password'
    ? fieldError.message : !!password && !isValidPassword(password) ? PASSWORD_TOO_SHORT_MESSAGE : null;
  const confirmError = fieldError?.field === 'confirm'
    ? fieldError.message : !!confirm && confirm !== password ? PASSWORD_MISMATCH_MESSAGE : null;

  const submit = async () => {
    if (!isValidPassword(password)) {
      setFieldError({ field: 'password', message: PASSWORD_TOO_SHORT_MESSAGE });
      return toast.show(PASSWORD_TOO_SHORT_MESSAGE, 'error');
    }
    if (password !== confirm) {
      setFieldError({ field: 'confirm', message: PASSWORD_MISMATCH_MESSAGE });
      return toast.show(PASSWORD_MISMATCH_MESSAGE, 'error');
    }
    setFieldError(null);
    setAction('save');
    try {
      await api('/auth/set-credentials', { method: 'POST', body: { password } });
      await refresh();
      toast.show('Password created. Your account is ready.', 'success');
      router.replace(upiOnboardingPending
        ? upiSetupHref(pendingInvitePath)
        : postAuthHref(pendingInvitePath));
    } catch (e: any) {
      toast.show(e.message || 'Could not save your password. Try again.', 'error');
    } finally {
      setAction(null);
    }
  };

  const useAnotherAccount = async () => {
    setAction('switch');
    try {
      await signOut(true);
      router.replace(pendingInvitePath
        ? { pathname: '/(auth)/login', params: { returnTo: pendingInvitePath } }
        : '/(auth)/login');
    } catch {
      toast.show('Could not switch accounts. Try again.', 'error');
      setAction(null);
    }
  };

  return (
    <AuthShell
      brandIcon="shield-check"
      title="Create your password"
      subtitle="Add a password to finish setting up your account and enable email sign-in."
    >
      <Input
        testID="setcred-password"
        label="Password"
        value={password}
        onChangeText={(value) => { setPassword(value); if (fieldError?.field === 'password') setFieldError(null); }}
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
        secureTextEntry
        placeholder="At least 9 characters"
        icon="lock"
        helper={PASSWORD_HINT_MESSAGE}
        error={passwordError}
        focusOnError={fieldError?.field === 'password'}
        returnKeyType="next"
      />
      <Input
        testID="setcred-confirm"
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
        label="Save and continue"
        icon="check"
        onPress={submit}
        loading={action === 'save'}
        disabled={busy}
        fullWidth
        size="lg"
        testID="setcred-submit"
      />
      <Button
        label="Use another account"
        variant="ghost"
        onPress={useAnotherAccount}
        loading={action === 'switch'}
        disabled={busy}
        fullWidth
        testID="setcred-use-another"
        haptic={false}
      />
    </AuthShell>
  );
}
