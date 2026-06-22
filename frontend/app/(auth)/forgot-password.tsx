import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { api } from '../../src/api';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';
import { AuthShell, Input, Button, useToast } from '../../src/ui';

// Forgot-PASSWORD via email link (distinct from forgot.tsx, which resets the PIN using the
// account password). Always shows the same generic confirmation — the backend never reveals
// whether the account exists.
export default function ForgotPassword() {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const emailError = !!email && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;

  const submit = async () => {
    if (!email) return toast.show('Enter your email', 'error');
    if (!isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    setBusy(true);
    try {
      await api('/auth/request-password-reset', { method: 'POST', body: { email: email.trim() }, auth: false });
      setSent(true);
    } catch (e: any) {
      toast.show(e.message || 'Something went wrong. Try again.', 'error');
    } finally { setBusy(false); }
  };

  if (sent) {
    return (
      <AuthShell
        brandIcon="mail"
        title="Check your email"
        subtitle="If an account exists for that address, we've sent a link to reset your password."
      >
        <Button label="Back to sign in" icon="chevron-left" onPress={() => router.replace('/(auth)/login')} fullWidth size="lg" testID="forgot-pw-back" />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      brandIcon="lock"
      title="Forgot password"
      subtitle="Enter your email and we'll send you a link to reset your password."
    >
      <Input
        testID="forgot-pw-email"
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="you@gmail.com"
        icon="mail"
        error={emailError}
      />
      <Button
        label={busy ? 'Sending…' : 'Send reset link'}
        icon="mail"
        onPress={submit}
        loading={busy}
        fullWidth
        size="lg"
        testID="forgot-pw-submit"
      />
    </AuthShell>
  );
}
