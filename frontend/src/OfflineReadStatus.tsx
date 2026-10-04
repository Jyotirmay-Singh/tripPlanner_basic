import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useAuth } from './AuthContext';
import ConfirmModal from './ConfirmModal';
import { offlineWritesActive } from './offlineActivation';
import type { ReadResult } from './offlineReads';
import T from './T';
import { useTheme } from './ThemeContext';
import { RADIUS, SPACING } from './theme';

let dismissed = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getDismissed = () => dismissed;
function setDismissed(value: boolean) {
  if (dismissed === value) return;
  dismissed = value;
  listeners.forEach((listener) => listener());
}

export default function OfflineReadStatus({ result }: {
  result: Pick<ReadResult<unknown>, 'source'>;
}) {
  const { colors } = useTheme();
  const { sessionMode } = useAuth();
  const [showDetails, setShowDetails] = useState(false);
  const noticeDismissed = useSyncExternalStore(subscribe, getDismissed, getDismissed);
  const offline = sessionMode === 'offline' || result.source === 'cache';

  useEffect(() => {
    if (result.source === 'live' && sessionMode !== 'offline') setDismissed(false);
  }, [result.source, sessionMode]);

  if (!offline || noticeDismissed) return null;
  const details = offlineWritesActive()
    ? 'In saved groups, add expenses and refunds or record suggested payments. They show Pending sync and reach others when you reconnect. Foreign-currency entries need approval.'
    : 'You can view groups you opened before. Adding expenses and payments needs a connection.';

  return (
    <>
      <View testID="offline-read-status" style={[
        styles.notice, { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
      ]}>
        <Pressable accessibilityRole="button"
          accessibilityLabel="You're offline. Learn what you can do offline."
          testID="offline-notice-details"
          onPress={() => setShowDetails(true)} style={styles.open}>
          <T variant="caption">{"You're offline"}</T>
          <T variant="body" muted accessibilityElementsHidden>›</T>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss offline notice"
          testID="offline-notice-dismiss" hitSlop={8}
          onPress={() => setDismissed(true)} style={styles.dismiss}>
          <T variant="body" muted accessibilityElementsHidden>×</T>
        </Pressable>
      </View>
      <ConfirmModal visible={showDetails} title="Offline mode" message={details}
        onRequestClose={() => setShowDetails(false)}
        actions={[{ label: 'Got it', onPress: () => setShowDetails(false) }]}
        testID="offline-notice-modal" />
    </>
  );
}

const styles = StyleSheet.create({
  notice: {
    borderWidth: 1, borderRadius: RADIUS.md, flexDirection: 'row', alignItems: 'center',
  },
  open: {
    flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingLeft: SPACING.md, paddingRight: SPACING.sm,
  },
  dismiss: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
