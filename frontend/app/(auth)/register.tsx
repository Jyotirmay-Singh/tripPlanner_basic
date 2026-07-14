import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import { SPACING } from '../../src/theme';
import T from '../../src/T';
import {
  isGmail,
  GMAIL_ONLY_MESSAGE,
  isValidPassword,
  PASSWORD_TOO_SHORT_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
} from '../../src/validation';
import GoogleSignInButton from '../../src/GoogleSignInButton';
import { AuthShell, Input, PinInput, Button, useToast } from '../../src/ui';

export default function Register() {
  const { register } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);

  const emailError = !!email && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;
  const passwordError = !!password && !isValidPassword(password) ? PASSWORD_TOO_SHORT_MESSAGE : null;
  const confirmError = !!confirm && confirm !== password ? PASSWORD_MISMATCH_MESSAGE : null;

  const submit = async () => {
    if (!name || !email || pin.length !== 4) return toast.show('Fill name, email, and a 4-digit PIN.', 'error');
    if (!isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    if (!isValidPassword(password)) return toast.show(PASSWORD_TOO_SHORT_MESSAGE, 'error');
    if (password !== confirm) return toast.show(PASSWORD_MISMATCH_MESSAGE, 'error');
    if (!/^\d{4}$/.test(pin)) return toast.show('PIN must be 4 digits', 'error');
    setLoading(true);
    try {
      await register(email.trim(), pin, name.trim(), password);
      router.replace('/(tabs)/dashboard');
    } catch (e: any) {
      toast.show(e.message || 'Registration failed. Try again.', 'error');
    } finally { setLoading(false); }
  };

  return (
    <AuthShell brandImage={require('../../assets/images/wordmark.png')} title="Let's get started" subtitle="Your trips, shared seamlessly.">
      <Input testID="reg-name" label="Your name" value={name} onChangeText={setName} placeholder="Jane Doe" icon="user" />
      <Input
        testID="reg-email"
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
        testID="reg-password"
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
        testID="reg-confirm-password"
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

      <View style={{ gap: SPACING.sm }}>
        <T variant="label" muted style={{ textAlign: 'center' }}>Choose a 4-digit PIN</T>
        <PinInput testID="reg-pin" value={pin} onChangeText={setPin} onSubmit={submit} />
        <T muted variant="caption" style={{ textAlign: 'center' }}>
          {"You'll log in with your email + PIN. Forgot your PIN? Reset it with your password."}
        </T>
      </View>

      <Button label="Create account" icon="check" onPress={submit} loading={loading} fullWidth size="lg" testID="reg-submit" />
      <GoogleSignInButton />
    </AuthShell>
  );
}
