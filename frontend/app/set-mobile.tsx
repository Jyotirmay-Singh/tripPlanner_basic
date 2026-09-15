import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { CountryCode } from 'libphonenumber-js';

import ConfirmModal from '../src/ConfirmModal';
import MobileNumberInput from '../src/MobileNumberInput';
import T from '../src/T';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';
import {
  canonicalMobileNumber,
  countryFromLocale,
  formatMobileDraft,
  MOBILE_INVALID_MESSAGE,
} from '../src/mobileNumber';
import { postAuthHref, safeInviteReturnTo, upiSetupHref } from '../src/inviteNavigation';
import { RADIUS, SPACING } from '../src/theme';
import { AuthShell, Button, Card, Icon, useToast } from '../src/ui';

type MutationAction = 'save' | 'remove' | null;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function mutationError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function SetMobile() {
  const params = useLocalSearchParams<{
    mode?: string | string[];
    returnTo?: string | string[];
  }>();
  const profileMode = firstParam(params.mode) === 'profile';
  const {
    user,
    pendingInvitePath,
    upiOnboardingPending,
    updateMobileNumber,
    completeMobileOnboarding,
  } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const localeCountry = useRef(countryFromLocale()).current;
  const savedCountry = (user?.mobile_country_code || localeCountry) as CountryCode;
  const initialDraft = user?.mobile_number
    ? formatMobileDraft(user.mobile_number, savedCountry)
    : { country: savedCountry, display: '' };
  const userLoaded = user !== undefined;
  const profileValueInitialized = useRef(userLoaded);
  const mutationInFlight = useRef(false);
  const [country, setCountry] = useState<CountryCode>(initialDraft.country);
  const [mobileNumber, setMobileNumber] = useState(profileMode ? initialDraft.display : '');
  const [error, setError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [action, setAction] = useState<MutationAction>(null);
  const [removeConfirmationVisible, setRemoveConfirmationVisible] = useState(false);
  const busy = action !== null;
  const inviteReturnTo = safeInviteReturnTo(params.returnTo)
    ?? safeInviteReturnTo(pendingInvitePath);

  useEffect(() => {
    if (!profileMode || profileValueInitialized.current || !userLoaded) return;
    profileValueInitialized.current = true;
    const nextCountry = (user?.mobile_country_code || localeCountry) as CountryCode;
    const nextDraft = user?.mobile_number
      ? formatMobileDraft(user.mobile_number, nextCountry)
      : { country: nextCountry, display: '' };
    setCountry(nextDraft.country);
    setMobileNumber(nextDraft.display);
  }, [localeCountry, profileMode, user?.mobile_country_code, user?.mobile_number, userLoaded]);

  const finishOnboarding = () => {
    completeMobileOnboarding();
    router.replace(upiOnboardingPending
      ? upiSetupHref(inviteReturnTo)
      : postAuthHref(inviteReturnTo));
  };

  const returnToProfile = () => router.replace('/(tabs)/profile');

  const save = async () => {
    if (mutationInFlight.current) return;
    let canonical: string;
    try {
      canonical = canonicalMobileNumber(mobileNumber, country);
    } catch {
      setSaveFailed(true);
      setError(MOBILE_INVALID_MESSAGE);
      return;
    }

    mutationInFlight.current = true;
    setAction('save');
    setError(null);
    try {
      const updated = await updateMobileNumber(canonical, country);
      const updatedCountry = (updated.mobile_country_code || country) as CountryCode;
      const draft = formatMobileDraft(updated.mobile_number || canonical, updatedCountry);
      setCountry(draft.country);
      setMobileNumber(draft.display);
      setSaveFailed(false);
      toast.show('Mobile number saved.', 'success');
      if (profileMode) returnToProfile();
      else finishOnboarding();
    } catch (saveError: unknown) {
      setSaveFailed(true);
      setError(mutationError(saveError, 'Could not save your mobile number. Try again.'));
    } finally {
      mutationInFlight.current = false;
      setAction(null);
    }
  };

  const skip = () => {
    if (!mutationInFlight.current) finishOnboarding();
  };

  const remove = async () => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setAction('remove');
    setError(null);
    try {
      await updateMobileNumber(null, null);
      setMobileNumber('');
      setRemoveConfirmationVisible(false);
      toast.show('Mobile number removed.', 'success');
      returnToProfile();
    } catch (removeError: unknown) {
      setRemoveConfirmationVisible(false);
      setError(mutationError(removeError, 'Could not remove your mobile number. Try again.'));
    } finally {
      mutationInFlight.current = false;
      setAction(null);
    }
  };

  const changeMobile = (value: string, nextCountry: CountryCode) => {
    setMobileNumber(value);
    setCountry(nextCountry);
    setError(null);
    setSaveFailed(false);
  };

  return (
    <AuthShell
      brandIcon="phone"
      title={profileMode ? 'Mobile number' : 'Add your number'}
      subtitle={profileMode
        ? 'Add or update the number friends can use to reach you on a trip.'
        : 'Friends can reach you while you travel together.'}
    >
      <MobileNumberInput
        value={mobileNumber}
        country={country}
        onChange={changeMobile}
        error={error}
        editable={!busy}
        focusOnError={!!error}
      />

      <Card variant="muted" style={styles.privacyCard} testID="mobile-privacy-note">
        <Icon name="shield-check" size={20} color={colors.primary} />
        <T variant="caption" style={styles.privacyCopy}>
          People in your trips can see this number. You can remove it anytime from Profile.
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
        testID="mobile-save"
      />

      {profileMode ? (
        <>
          <Button
            label="Cancel"
            variant="secondary"
            onPress={returnToProfile}
            disabled={busy}
            fullWidth
            testID="mobile-cancel"
            haptic={false}
          />
          {user?.mobile_number ? (
            <Button
              label="Remove mobile number"
              variant="destructive"
              onPress={() => setRemoveConfirmationVisible(true)}
              disabled={busy}
              fullWidth
              testID="mobile-remove"
            />
          ) : null}
        </>
      ) : (
        <Button
          label="Not now"
          variant="ghost"
          onPress={skip}
          disabled={busy}
          fullWidth
          testID="mobile-skip"
          haptic={false}
        />
      )}

      <ConfirmModal
        visible={profileMode && removeConfirmationVisible}
        title="Remove mobile number?"
        message="People in your trips will no longer see this number. You can add it again anytime."
        testID="mobile-remove-confirm-modal"
        onRequestClose={() => {
          if (!mutationInFlight.current) setRemoveConfirmationVisible(false);
        }}
        actions={[
          {
            label: action === 'remove' ? 'Removing...' : 'Remove mobile number',
            variant: 'destructive',
            testID: 'mobile-remove-confirm',
            disabled: busy,
            onPress: remove,
          },
          {
            label: 'Cancel',
            variant: 'cancel',
            testID: 'mobile-remove-cancel',
            disabled: busy,
            onPress: () => setRemoveConfirmationVisible(false),
          },
        ]}
      />
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  privacyCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    borderRadius: RADIUS.lg,
  },
  privacyCopy: { flex: 1 },
});
