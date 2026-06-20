import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { api } from '../../src/api';
import { SPACING } from '../../src/theme';
import T from '../../src/T';
import { AuthShell, Input, PinInput, Button, useToast } from '../../src/ui';

export default function Reset() {
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ token?: string }>();
  const [token, setToken] = useState((params.token as string) || '');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!token) return toast.show('Enter the reset token from your email', 'error');
    if (!/^\d{4}$/.test(pin)) return toast.show('PIN must be 4 digits', 'error');
    setBusy(true);
    try {
      await api('/auth/reset-pin', { method: 'POST', body: { token: token.trim(), new_pin: pin }, auth: false });
      toast.show('PIN reset. Sign in with your new PIN.', 'success');
      setTimeout(() => router.replace('/(auth)/login'), 900);
    } catch (e: any) { toast.show(e.message || 'Something went wrong', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <AuthShell brandIcon="lock" title="Reset PIN" subtitle="Paste the token from your email and choose a new 4-digit PIN.">
      <Input
        testID="reset-token"
        label="Reset token"
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        placeholder="Token from email"
        icon="key"
      />
      <View style={{ gap: SPACING.sm }}>
        <T variant="label" muted style={{ textAlign: 'center' }}>New 4-digit PIN</T>
        <PinInput testID="reset-pin" value={pin} onChangeText={setPin} onSubmit={submit} />
      </View>
      <Button label={busy ? 'Resetting…' : 'Reset PIN'} icon="check" onPress={submit} loading={busy} fullWidth size="lg" testID="reset-submit" />
    </AuthShell>
  );
}
