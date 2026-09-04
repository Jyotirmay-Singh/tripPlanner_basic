import type {
  PushPermissionState,
  PushSyncOptions,
  PushUnregisterReason,
} from './pushNotificationTypes';


// Browser/iOS-safe contract. Metro replaces this with pushNotifications.android.ts on Android;
// web and iOS never import expo-notifications or call the Android registration API.
export async function syncPushRegistrationIfEligible(
  _options: PushSyncOptions = {},
): Promise<PushPermissionState> {
  return 'unavailable';
}

export async function unregisterCurrentPushInstallation(
  _reason: PushUnregisterReason = 'logout',
): Promise<void> {}

export async function getPushPermissionState(): Promise<PushPermissionState> {
  return 'unavailable';
}

export async function enablePushNotificationsFromSettings(): Promise<PushPermissionState> {
  return 'unavailable';
}
