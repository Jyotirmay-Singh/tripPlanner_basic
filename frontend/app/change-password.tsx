import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { api } from '../src/api';
import { SPACING } from '../src/theme';
import T from '../src/T';
import {
  isValidPassword, PASSWORD_TOO_SHORT_MESSAGE, PASSWORD_MISMATCH_MESSAGE, PASSWORD_HINT_MESSAGE,
} from '../src/validation';
import { Screen, Card, Input, Button, useToast } from '../src/ui';

// In-app "change my password" for a signed-in user (Bearer). Sibling to reset-password /
// set-credentials, but proves ownership with the current password instead of an email link.
// Reached from a Profile row; pushed with a header back-button (see app/_layout.tsx).
export default function ChangePassword() {
  const router = useRouter();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  // Wrong-current-password comes back from the server (401) and renders under the current field.
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const newError = !!next && !isValidPassword(next) ? PASSWORD_TOO_SHORT_MESSAGE : null;
  const confirmError = !!confirm && confirm !== next ? PASSWORD_MISMATCH_MESSAGE : null;
  const canSubmit = !!current && isValidPassword(next) && next === confirm && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setCurrentError(null);
    try {
      await api('/auth/change-password', {
        method: 'POST', body: { current_password: current, new_password: next },
      });
      toast.show('Password updated', 'success');
      setTimeout(() => router.back(), 700);
    } catch (e: any) {
      if (e.status === 401) setCurrentError(e.message || 'Current password is incorrect');
      else toast.show(e.message || 'Could not update password', 'error');
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <Card style={{ gap: SPACING.md }}>
        <T muted>Choose a new password for signing in with your email. Your 4-digit PIN stays the same.</T>
        <Input
          testID="cp-current"
          label="Current password"
          value={current}
          onChangeText={(v) => { setCurrent(v); setCurrentError(null); }}
          autoCapitalize="none"
          secureTextEntry
          placeholder="Enter current password"
          icon="lock"
          error={currentError}
          textContentType="password"
          autoComplete="current-password"
        />
        <Input
          testID="cp-new"
          label="New password"
          value={next}
          onChangeText={setNext}
          autoCapitalize="none"
          secureTextEntry
          placeholder="At least 9 characters"
          icon="lock"
          helper={PASSWORD_HINT_MESSAGE}
          error={newError}
          textContentType="newPassword"
          autoComplete="new-password"
        />
        <Input
          testID="cp-confirm"
          label="Confirm new password"
          value={confirm}
          onChangeText={setConfirm}
          autoCapitalize="none"
          secureTextEntry
          placeholder="Re-enter new password"
          icon="lock"
          error={confirmError}
          textContentType="newPassword"
          autoComplete="new-password"
        />
        <Button
          label="Update password"
          icon="check"
          onPress={submit}
          loading={busy}
          disabled={!canSubmit}
          fullWidth
          size="lg"
          testID="cp-submit"
        />
      </Card>
    </Screen>
  );
}
