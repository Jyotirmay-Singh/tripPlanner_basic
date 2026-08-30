export type SystemBarIconStyle = 'light' | 'dark';

export function themedNavigationStyle(
  mode: 'light' | 'dark',
  platform: string,
  version: number | string,
): SystemBarIconStyle {
  const androidVersion = typeof version === 'number'
    ? version
    : Number.parseInt(String(version), 10);
  // Android added dark navigation buttons in API 26. Older releases need light buttons over the
  // compatibility scrim supplied by Android's edge-to-edge implementation.
  return mode === 'dark' || (platform === 'android' && androidVersion < 26) ? 'light' : 'dark';
}
