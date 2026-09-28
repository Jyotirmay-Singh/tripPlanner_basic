import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import ConfirmModal from '../src/ConfirmModal';
import T from '../src/T';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';
import { postAuthHref, safeInviteReturnTo } from '../src/inviteNavigation';
import { RADIUS, SPACING } from '../src/theme';
import { isValidUpiId, normalizeUpiId, UPI_ID_INVALID_MESSAGE } from '../src/validation';
import { AuthShell, Button, Card, Icon, Input, useToast } from '../src/ui';

type MutationAction = 'save' | 'remove' | null;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function mutationError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function SetUpi() {
  const params = useLocalSearchParams<{
    mode?: string | string[];
    returnTo?: string | string[];
  }>();
  const profileMode = firstParam(params.mode) === 'profile';
  const {
    user,
    pendingInvitePath,
    updateUpiId,
    completeUpiOnboarding,
  } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const savedUpiId = user?.upi_id ?? '';
  const userLoaded = user !== undefined;
  const profileValueInitialized = useRef(userLoaded);
  const mutationInFlight = useRef(false);
  const [upiId, setUpiId] = useState(profileMode ? savedUpiId : '');
  const [error, setError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [action, setAction] = useState<MutationAction>(null);
  const [removeConfirmationVisible, setRemoveConfirmationVisible] = useState(false);
  const busy = action !== null;
  const inviteReturnTo = safeInviteReturnTo(params.returnTo)
    ?? safeInviteReturnTo(pendingInvitePath);

  // A protected deep link can mount for one render while AuthContext restores its user. Populate
  // the profile form once that read completes without overwriting later user edits.
  useEffect(() => {
    if (!profileMode || profileValueInitialized.current || !userLoaded) return;
    profileValueInitialized.current = true;
    setUpiId(savedUpiId);
  }, [profileMode, savedUpiId, userLoaded]);

  const finishOnboarding = () => {
    completeUpiOnboarding();
    router.replace(postAuthHref(inviteReturnTo));
  };

  const returnToProfile = () => {
    router.replace('/(tabs)/profile');
  };

  const save = async () => {
    if (mutationInFlight.current) return;
    if (!isValidUpiId(upiId)) {
      setSaveFailed(true);
      setError(UPI_ID_INVALID_MESSAGE);
      return;
    }

    const normalized = normalizeUpiId(upiId);
    mutationInFlight.current = true;
    setAction('save');
    setError(null);
    try {
      const updated = await updateUpiId(normalized);
      setUpiId(updated.upi_id ?? '');
      setSaveFailed(false);
      toast.show('UPI ID saved.', 'success');
      if (profileMode) returnToProfile();
      else finishOnboarding();
    } catch (saveError: unknown) {
      setSaveFailed(true);
      setError(mutationError(saveError, 'Could not save your UPI ID. Try again.'));
    } finally {
      mutationInFlight.current = false;
      setAction(null);
    }
  };

  const skip = () => {
    if (mutationInFlight.current) return;
    finishOnboarding();
  };

  const remove = async () => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setAction('remove');
    setError(null);
    try {
      await updateUpiId(null);
      setUpiId('');
      setRemoveConfirmationVisible(false);
      toast.show('UPI ID removed.', 'success');
      returnToProfile();
    } catch (removeError: unknown) {
      setRemoveConfirmationVisible(false);
      setError(mutationError(removeError, 'Could not remove your UPI ID. Try again.'));
    } finally {
      mutationInFlight.current = false;
      setAction(null);
    }
  };

  const changeUpiId = (value: string) => {
    setUpiId(value);
    setError(null);
    setSaveFailed(false);
  };

  return (
    <AuthShell
      brandIcon="wallet"
      title={profileMode ? 'Payment details' : 'Set up your UPI ID'}
      subtitle={profileMode
        ? 'Add or update the UPI ID friends can use to pay you directly.'
        : 'Enter your UPI ID so friends can pay you directly. You can change it anytime in Profile.'}
    >
      <Input
        testID="upi-input"
        label="UPI ID"
        value={upiId}
        onChangeText={changeUpiId}
        placeholder="name@bank"
        icon="wallet"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        returnKeyType="done"
        onSubmitEditing={save}
        editable={!busy}
        error={error}
        errorTestID="upi-error"
        focusOnError={!!error}
      />

      <Card variant="muted" style={styles.safetyCard} testID="upi-security-note">
        <Icon name="shield-check" size={20} color={colors.primary} />
        <T variant="caption" style={styles.safetyCopy}>
          Trip Splitter never requests a UPI PIN, bank password, or QR upload.
        </T>
      </Card>

      <Button
        label={saveFailed ? 'Try again' : profileMode ? 'Save changes' : 'Save and continue'}
        icon={saveFailed ? 'retry' : 'check'}
        onPress={save}
        loading={action === 'save'}
        disabled={busy}
        fullWidth
        size="lg"
        testID="upi-save"
      />

      {profileMode ? (
        <>
          <Button
            label="Cancel"
            variant="secondary"
            onPress={returnToProfile}
            disabled={busy}
            fullWidth
            testID="upi-cancel"
            haptic={false}
          />
          {savedUpiId ? (
            <Button
              label="Remove UPI ID"
              variant="destructive"
              onPress={() => setRemoveConfirmationVisible(true)}
              disabled={busy}
              fullWidth
              testID="upi-remove"
            />
          ) : null}
        </>
      ) : (
        <Button
          label="Skip for now"
          variant="ghost"
          onPress={skip}
          disabled={busy}
          fullWidth
          testID="upi-skip"
          haptic={false}
        />
      )}

      <ConfirmModal
        visible={profileMode && removeConfirmationVisible}
        title="Remove UPI ID?"
        message="Friends will no longer see a UPI ID in your payment details."
        testID="upi-remove-confirm-modal"
        onRequestClose={() => {
          if (!mutationInFlight.current) setRemoveConfirmationVisible(false);
        }}
        actions={[
          {
            label: action === 'remove' ? 'Removing...' : 'Remove UPI ID',
            variant: 'destructive',
            testID: 'upi-remove-confirm',
            disabled: busy,
            onPress: remove,
          },
          {
            label: 'Cancel',
            variant: 'cancel',
            testID: 'upi-remove-cancel',
            disabled: busy,
            onPress: () => setRemoveConfirmationVisible(false),
          },
        ]}
      />
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  safetyCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    borderRadius: RADIUS.lg,
  },
  safetyCopy: { flex: 1 },
});
