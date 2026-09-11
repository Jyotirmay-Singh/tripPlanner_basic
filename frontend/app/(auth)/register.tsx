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
import { upiSetupHref } from '../../src/inviteNavigation';

export default function Register() {
  const { register, pendingInvitePath } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [fieldError, setFieldError] = useState<{
    field: 'name' | 'email' | 'password' | 'confirm'; message: string;
  } | null>(null);

  const emailError = fieldError?.field === 'email'
    ? fieldError.message : !!email && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null;
  const passwordError = fieldError?.field === 'password'
    ? fieldError.message : !!password && !isValidPassword(password) ? PASSWORD_TOO_SHORT_MESSAGE : null;
  const confirmError = fieldError?.field === 'confirm'
    ? fieldError.message : !!confirm && confirm !== password ? PASSWORD_MISMATCH_MESSAGE : null;

  const submit = async () => {
    if (!name.trim()) {
      setFieldError({ field: 'name', message: 'Enter your name' });
      return toast.show('Enter your name', 'error');
    }
    if (!email.trim()) {
      setFieldError({ field: 'email', message: 'Enter your email' });
      return toast.show('Enter your email', 'error');
    }
    if (!isGmail(email)) {
      setFieldError({ field: 'email', message: GMAIL_ONLY_MESSAGE });
      return toast.show(GMAIL_ONLY_MESSAGE, 'error');
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
    setLoading(true);
    try {
      await register(email.trim(), name.trim(), password);
      router.replace(upiSetupHref(pendingInvitePath));
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
      <Input
        testID="reg-name"
        label="Your name"
        value={name}
        onChangeText={(value) => { setName(value); if (fieldError?.field === 'name') setFieldError(null); }}
        placeholder="Jane Doe"
        icon="user"
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        error={fieldError?.field === 'name' ? fieldError.message : null}
        focusOnError={fieldError?.field === 'name'}
        returnKeyType="next"
      />
      <Input
        testID="reg-email"
        label="Email"
        value={email}
        onChangeText={(value) => { setEmail(value); if (fieldError?.field === 'email') setFieldError(null); }}
        autoCapitalize="none"
        autoComplete="email"
        textContentType="emailAddress"
        keyboardType="email-address"
        placeholder="you@gmail.com"
        icon="mail"
        error={emailError}
        focusOnError={fieldError?.field === 'email'}
        returnKeyType="next"
      />
      <Input
        testID="reg-password"
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
        testID="reg-confirm-password"
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
      <Button label="Create account" icon="check" onPress={submit} loading={loading} fullWidth size="lg" testID="reg-submit" />
      <GoogleSignInButton />
    </AuthShell>
  );
}
