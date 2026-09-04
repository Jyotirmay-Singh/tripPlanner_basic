import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import {
  isGmail,
  GMAIL_ONLY_MESSAGE,
  isValidPassword,
  PASSWORD_TOO_SHORT_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_HINT_MESSAGE,
} from '../../src/validation';
import GoogleSignInButton from '../../src/GoogleSignInButton';
import { AuthShell, Input, Button, useToast } from '../../src/ui';
import { postAuthHref } from '../../src/inviteNavigation';

export default function Register() {
  const { register, pendingInvitePath } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const emailError = !!email && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;
  const passwordError = !!password && !isValidPassword(password) ? PASSWORD_TOO_SHORT_MESSAGE : null;
  const confirmError = !!confirm && confirm !== password ? PASSWORD_MISMATCH_MESSAGE : null;

  const submit = async () => {
    if (!name.trim() || !email.trim()) return toast.show('Enter your name and email', 'error');
    if (!isGmail(email)) return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    if (!isValidPassword(password)) return toast.show(PASSWORD_TOO_SHORT_MESSAGE, 'error');
    if (password !== confirm) return toast.show(PASSWORD_MISMATCH_MESSAGE, 'error');
    setLoading(true);
    try {
      await register(email.trim(), name.trim(), password);
      router.replace(postAuthHref(pendingInvitePath));
    } catch (e: any) {
      toast.show(e.message || 'Registration failed. Try again.', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      nativeHeader
      brandImage={require('../../assets/images/wordmark.png')}
      title="Let's get started"
      subtitle="Your trips, shared seamlessly."
    >
      <Input testID="reg-name" label="Your name" value={name} onChangeText={setName} placeholder="Jane Doe" icon="user" />
      <Input
        testID="reg-email"
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        textContentType="emailAddress"
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
        autoComplete="new-password"
        textContentType="newPassword"
        secureTextEntry
        placeholder="At least 9 characters"
        icon="lock"
        helper={PASSWORD_HINT_MESSAGE}
        error={passwordError}
      />
      <Input
        testID="reg-confirm-password"
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
        secureTextEntry
        placeholder="Re-enter your password"
        icon="lock"
        error={confirmError}
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      <Button label="Create account" icon="check" onPress={submit} loading={loading} fullWidth size="lg" testID="reg-submit" />
      <GoogleSignInButton />
    </AuthShell>
  );
}
