import React, { useState } from 'react';
import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../../src/api';
import { useTheme } from '../../src/ThemeContext';
import T from '../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';
import { AuthShell, Input, Button, useToast } from '../../src/ui';

export default function Forgot() {
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const emailError = !!email && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;

  const submit = async () => {
    if (!email) return toast.show('Enter your email', 'error');
    if (!isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    setBusy(true);
    try {
      await api('/auth/forgot-pin', { method: 'POST', body: { email: email.trim() }, auth: false });
      toast.show('If an account exists, a reset link is on its way to your inbox.', 'success');
      setTimeout(() => router.replace('/(auth)/reset'), 900);
    } catch (e: any) { toast.show(e.message || 'Something went wrong', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <AuthShell
      brandIcon="key"
      title="Forgot PIN"
      subtitle="Enter your email and we'll send a link to reset your 4-digit PIN."
    >
      <Input
        testID="forgot-email"
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="you@gmail.com"
        icon="mail"
        error={emailError}
      />
      <Button label={busy ? 'Sending…' : 'Send reset link'} icon="mail" onPress={submit} loading={busy} fullWidth size="lg" testID="forgot-submit" />
      <Pressable onPress={() => router.push('/(auth)/reset')} hitSlop={8}>
        <T color={colors.primary} style={{ textAlign: 'center' }}>I already have a token</T>
      </Pressable>
    </AuthShell>
  );
}
