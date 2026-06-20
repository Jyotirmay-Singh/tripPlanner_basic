import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import { SPACING } from '../../src/theme';
import T from '../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';
import { AuthShell, Input, PinInput, Button, useToast } from '../../src/ui';

export default function PinLogin() {
  const { signIn } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const emailError = !!email && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;

  const submit = async () => {
    if (!email || pin.length !== 4) return toast.show('Email + 4-digit PIN required', 'error');
    if (!isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    setBusy(true);
    try {
      await signIn(email.trim(), undefined, pin);
      router.replace('/(tabs)/dashboard');
    } catch (e: any) {
      toast.show(e.message || 'Login failed. Try again.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <AuthShell title="Quick PIN login" subtitle="For returning users">
      <Input
        testID="pin-email"
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="you@gmail.com"
        icon="mail"
        error={emailError}
      />
      <View style={{ gap: SPACING.sm }}>
        <T variant="label" muted style={{ textAlign: 'center' }}>4-digit PIN</T>
        <PinInput testID="pin-code" value={pin} onChangeText={setPin} onSubmit={submit} />
      </View>
      <Button label="Unlock" icon="lock" onPress={submit} loading={busy} fullWidth size="lg" testID="pin-submit" />
    </AuthShell>
  );
}
