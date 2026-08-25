import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Platform } from 'react-native';

import { useTheme } from './ThemeContext';
import { SPACING, RADIUS } from './theme';
import T from './T';
import { Card, Icon } from './ui';
import {
  enablePushNotificationsFromSettings,
  getPushPermissionState,
} from './pushNotifications';
import type { PushPermissionState } from './pushNotificationTypes';


export default function NotificationSettingsRow() {
  const { colors } = useTheme();
  const [permission, setPermission] = useState<PushPermissionState>('unavailable');
  const [busy, setBusy] = useState(false);

  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'android') return undefined;
    let mounted = true;
    void getPushPermissionState().then((value) => {
      if (mounted) setPermission(value);
    });
    return () => { mounted = false; };
  }, []));

  if (Platform.OS !== 'android' || permission === 'granted' || permission === 'unavailable') return null;

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setPermission(await enablePushNotificationsFromSettings());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      onPress={enable}
      testID="profile-notification-settings"
      accessibilityLabel={permission === 'denied' ? 'Open notification settings' : 'Enable notifications'}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
        borderRadius: RADIUS.lg, opacity: busy ? 0.65 : 1,
      }}
    >
      <Icon name="settings" size={20} color={colors.primary} />
      <T style={{ flex: 1 }}>
        {permission === 'denied' ? 'Notification settings' : 'Enable notifications'}
      </T>
      <Icon name="chevron-right" size={18} color={colors.textMuted} />
    </Card>
  );
}
