import { useCallback, useState } from 'react';
import { Alert, AppState, Platform, Switch, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { useTheme } from './ThemeContext';
import { RADIUS, SPACING } from './theme';
import T from './T';
import { Card, Icon } from './ui';
import {
  getPushPermissionState,
  openPushNotificationSettings,
} from './pushNotifications';
import type { PushPermissionState } from './pushNotificationTypes';


type DisplayState = PushPermissionState | 'loading';


export default function NotificationSettingsRow() {
  const { colors } = useTheme();
  const isAndroid = Platform.OS === 'android';
  const [permission, setPermission] = useState<DisplayState>(
    isAndroid ? 'loading' : 'unavailable',
  );
  const [busy, setBusy] = useState(false);

  useFocusEffect(useCallback(() => {
    if (!isAndroid) return undefined;
    let active = true;

    const refreshPermission = async () => {
      const nextPermission = await getPushPermissionState();
      if (active) setPermission(nextPermission);
    };

    void refreshPermission();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refreshPermission();
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, [isAndroid]));

  const enabled = permission === 'granted';
  const available = isAndroid && permission !== 'loading' && permission !== 'unavailable';
  const status = permission === 'loading'
    ? 'Checking\u2026'
    : permission === 'unavailable'
      ? 'Not available'
      : enabled
        ? 'Enabled'
        : 'Disabled';

  const confirmSettingsChange = () => {
    if (!available || busy) return;
    const action = enabled ? 'Disable' : 'Enable';
    const direction = enabled ? 'off' : 'on';

    Alert.alert(
      `${action} notifications?`,
      `Android manages this permission. Open Trip Splitter's app settings and turn Notifications ${direction}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Open settings',
          onPress: async () => {
            if (busy) return;
            setBusy(true);
            try {
              await openPushNotificationSettings();
            } catch {
              Alert.alert(
                'Unable to open settings',
                'Open Android Settings, select Trip Splitter, then choose Notifications.',
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const accessibilityLabel = enabled
    ? 'Notifications enabled. Open Android settings to disable.'
    : 'Notifications disabled. Open Android settings to enable.';

  return (
    <Card
      onPress={available ? confirmSettingsChange : undefined}
      testID="profile-notification-settings"
      accessibilityLabel={available ? accessibilityLabel : undefined}
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
        pointerEvents="none"
        accessible={false}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={colors.surface}
      />
    </Card>
  );
}
