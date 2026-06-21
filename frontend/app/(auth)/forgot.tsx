import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../../src/api';
import { SPACING } from '../../src/theme';
import T from '../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';
import { AuthShell, Input, PinInput, Button, useToast } from '../../src/ui';

export default function Forgot() {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const emailError = !!email && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;

  const submit = async () => {
    if (!email) return toast.show('Enter your email', 'error');
    if (!isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    if (!password) return toast.show('Enter your password', 'error');
    if (!/^\d{4}$/.test(pin)) return toast.show('New PIN must be 4 digits', 'error');
    setBusy(true);
    try {
      await api('/auth/reset-pin-by-password', {
        method: 'POST',
        body: { email: email.trim(), password, new_pin: pin },
        auth: false,
      });
      toast.show('PIN updated. Sign in with your new PIN.', 'success');
      setTimeout(() => router.replace('/(auth)/login'), 900);
    } catch (e: any) {
      // Backend returns a deliberately generic "Invalid email or password" so we never reveal
      // whether the email exists or which field was wrong — surface it verbatim.
      toast.show(e.message || 'Could not reset your PIN. Check your details and try again.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <AuthShell
      brandIcon="key"
      title="Forgot PIN"
      subtitle="Confirm your email and password, then choose a new 4-digit PIN."
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
      <Input
        testID="forgot-password"
        label="Password"
        value={password}
        onChangeText={setPassword}
        autoCapitalize="none"
        secureTextEntry
        placeholder="Your account password"
        icon="lock"
      />
      <View style={{ gap: SPACING.sm }}>
        <T variant="label" muted style={{ textAlign: 'center' }}>New 4-digit PIN</T>
        <PinInput testID="forgot-pin" value={pin} onChangeText={setPin} onSubmit={submit} />
      </View>
      <Button
        label={busy ? 'Updating…' : 'Set new PIN'}
        icon="check"
        onPress={submit}
        loading={busy}
        fullWidth
        size="lg"
        testID="forgot-submit"
      />
    </AuthShell>
  );
}
