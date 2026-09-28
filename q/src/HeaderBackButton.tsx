import React from 'react';
import { useRouter } from 'expo-router';
import { IconButton } from './ui';
import { goBackOrTrips } from './tripNav';

// Guaranteed header back affordance for the trip detail screen. Trip routes live in the root stack,
// so the default back button is missing when the trip is reached without history (replace after
// create/join, deep-link, web refresh). This always shows and falls back to the Trips tab.
// Wired as `headerLeft` only — it does not touch the `headerRight` ProfileAvatarButton.
export default function HeaderBackButton() {
  const router = useRouter();
  return (
    <IconButton
      name="chevron-left"
      onPress={() => goBackOrTrips(router)}
      accessibilityLabel="Back"
      variant="plain"
      size={24}
    />
  );
}
