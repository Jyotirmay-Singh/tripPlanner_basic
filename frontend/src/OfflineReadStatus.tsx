import React from 'react';
import { View } from 'react-native';
import T from './T';
import { useTheme } from './ThemeContext';
import { SPACING } from './theme';
import type { ReadResult } from './offlineReads';

export function lastSyncLabel(fetchedAt: number): string {
  return `Last synced ${new Date(fetchedAt).toLocaleString()}`;
}

export default function OfflineReadStatus({ result }: {
  result: Pick<ReadResult<unknown>, 'source' | 'fetchedAt' | 'cacheError'>;
}) {
  const { colors } = useTheme();
  if (!result.fetchedAt && !result.cacheError) return null;
  const label = result.source === 'cache'
    ? `Showing saved server-confirmed data. ${lastSyncLabel(result.fetchedAt!)}`
    : result.fetchedAt ? lastSyncLabel(result.fetchedAt) : '';
  return (
    <View style={{ gap: SPACING.xs }}>
      {label ? (
        <T variant="caption" color={result.source === 'cache' ? colors.warning : colors.textMuted}
          accessibilityLabel={label} testID="offline-read-status">{label}</T>
      ) : null}
      {result.cacheError ? (
        <T variant="caption" color={colors.warning} testID="offline-save-warning">
          Offline copy could not be saved on this device.
        </T>
      ) : null}
    </View>
  );
}
