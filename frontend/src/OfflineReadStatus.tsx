import React from 'react';
import T from './T';
import { useTheme } from './ThemeContext';
import type { ReadResult } from './offlineReads';

export function lastSyncLabel(fetchedAt: number): string {
  return `Last synced ${new Date(fetchedAt).toLocaleString()}`;
}

export default function OfflineReadStatus({ result }: {
  result: Pick<ReadResult<unknown>, 'source' | 'fetchedAt'>;
}) {
  const { colors } = useTheme();
  if (!result.fetchedAt) return null;
  const label = result.source === 'cache'
    ? `Showing saved server-confirmed data. ${lastSyncLabel(result.fetchedAt)}`
    : lastSyncLabel(result.fetchedAt);
  return (
    <T variant="caption" color={result.source === 'cache' ? colors.warning : colors.textMuted}
      accessibilityLabel={label} testID="offline-read-status">{label}</T>
  );
}
