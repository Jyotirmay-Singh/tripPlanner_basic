import { useCallback, useRef, useState } from 'react';
import { Alert, AppState, Platform, Switch, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { useTheme } from './ThemeContext';
import { RADIUS, SPACING } from './theme';
import T from './T';
import { Card, Icon } from './ui';
import {
  getPushNotificationSettings,
  openPushNotificationSettings,
  setPushNotificationsEnabled,
} from './pushNotifications';
import type { PushNotificationSettingsSnapshot } from './pushNotificationTypes';


const UNAVAILABLE_SETTINGS: PushNotificationSettingsSnapshot = {
  userPreference: null,
  permission: 'unavailable',
  canAskAgain: false,
  enabled: false,
};


export default function NotificationSettingsRow() {
  const { colors } = useTheme();
  const isAndroid = Platform.OS === 'android';
  const [settings, setSettings] = useState<PushNotificationSettingsSnapshot | null>(
    isAndroid ? null : UNAVAILABLE_SETTINGS,
  );
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);

  useFocusEffect(useCallback(() => {
    if (!isAndroid) return undefined;
    let active = true;

    const refreshSettings = async () => {
      let nextSettings = UNAVAILABLE_SETTINGS;
      try {
        nextSettings = await getPushNotificationSettings();
      } catch {
        // Keep the row present but non-interactive if native state cannot be read.
      }
      if (active) setSettings(nextSettings);
    };

    void refreshSettings();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refreshSettings();
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, [isAndroid]));

  const openSettings = useCallback(async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    try {
      await openPushNotificationSettings();
    } catch {
      Alert.alert(
        'Unable to open settings',
        'Open Android Settings, select Trip Splitter, then choose Notifications.',
      );
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }, []);

  const showBlockedHelp = useCallback(() => {
    Alert.alert(
      'Notifications blocked by Android',
      'Go to Settings > Apps > Trip Splitter > Notifications, then turn on Allow notifications.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Open settings',
          onPress: openSettings,
        },
      ],
    );
  }, [openSettings]);

  const enabled = settings?.enabled === true;
  const available = isAndroid && settings !== null && settings.permission !== 'unavailable';
  const blocked = settings?.userPreference !== false
    && settings?.permission === 'denied'
    && !settings.canAskAgain;
  const status = settings === null
    ? 'Checking notification status\u2026'
    : settings.permission === 'unavailable'
      ? 'Notifications are unavailable on this device.'
      : enabled
        ? 'Trip activity and join request updates are on.'
        : blocked
          ? 'Blocked by Android. Tap the switch for help.'
          : 'Turn on updates for trip activity and join requests.';

  const changeEnabled = useCallback(async (nextEnabled: boolean) => {
    if (!available || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    let shouldShowBlockedHelp = false;
    try {
      const nextSettings = await setPushNotificationsEnabled(nextEnabled);
      setSettings(nextSettings);
      shouldShowBlockedHelp = nextEnabled
        && nextSettings.permission === 'denied'
        && !nextSettings.canAskAgain;
    } catch {
      setSettings(UNAVAILABLE_SETTINGS);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
    if (shouldShowBlockedHelp) showBlockedHelp();
  }, [available, showBlockedHelp]);

  const accessibilityHint = !available
    ? status
    : enabled
      ? 'Turns off trip activity and join request updates on this device.'
      : blocked
        ? 'Shows help for allowing notifications in Android settings.'
        : 'Requests permission and turns on trip activity and join request updates.';

  return (
    <Card
      testID="profile-notification-settings"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACING.md,
        borderRadius: RADIUS.lg,
        opacity: busy ? 0.65 : 1,
      }}
    >
      <Icon name="bell" size={20} color={colors.primary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T>Notifications</T>
        <T muted variant="caption">{status}</T>
      </View>
      <Switch
        testID="profile-notification-switch"
        value={enabled}
        disabled={!available || busy}
        onValueChange={changeEnabled}
        accessibilityLabel="Trip notifications"
        accessibilityHint={accessibilityHint}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={colors.surface}
      />
    </Card>
  );
}
