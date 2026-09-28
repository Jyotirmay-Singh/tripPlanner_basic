import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { Alert, Linking, Platform } from 'react-native';

import { api } from './api';
import type {
  PushNotificationSettingsSnapshot,
  PushPermissionState,
  PushSyncOptions,
  PushUnregisterReason,
} from './pushNotificationTypes';


const INSTALLATION_ID_KEY = 'push_installation_id';
const NOTIFICATIONS_ENABLED_KEY = 'push_notifications_enabled';
const RATIONALE_SEEN_KEY = 'push_rationale_seen';
const RATIONALE_ACCEPTED_KEY = 'push_rationale_accepted';
const CHANNEL_ID = 'trip_activity';

let currentSync: Promise<PushPermissionState> | null = null;
let currentSettingsChange: Promise<PushNotificationSettingsSnapshot> | null = null;


if (Platform.OS === 'android') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}


async function ensureChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Trip activity',
    description: 'Private updates for trip activity and join requests',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#1FC89A',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}


function pushDiagnostic(event: string, data: Record<string, unknown> = {}): void {
  // Never pass native errors, auth material, installation ids, or Expo tokens to this helper.
  console.info(`[push-notifications] ${event}`, data);
}


function permissionState(status: Notifications.NotificationPermissionsStatus): PushPermissionState {
  if (status.granted || status.status === Notifications.PermissionStatus.GRANTED) return 'granted';
  if (status.status === Notifications.PermissionStatus.DENIED) return 'denied';
  return 'undetermined';
}


function unavailableSettings(
  userPreference: boolean | null = null,
): PushNotificationSettingsSnapshot {
  return {
    userPreference,
    permission: 'unavailable',
    canAskAgain: false,
    enabled: false,
  };
}


function settingsSnapshot(
  userPreference: boolean | null,
  permissions: Notifications.NotificationPermissionsStatus,
): PushNotificationSettingsSnapshot {
  const permission = permissionState(permissions);
  return {
    userPreference,
    permission,
    canAskAgain: permissions.canAskAgain === true,
    enabled: userPreference !== false && permission === 'granted',
  };
}


async function notificationPreference(): Promise<boolean | null> {
  const stored = await AsyncStorage.getItem(NOTIFICATIONS_ENABLED_KEY);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return null;
}


async function settingsForPreference(
  userPreference: boolean | null,
): Promise<PushNotificationSettingsSnapshot> {
  try {
    return settingsSnapshot(userPreference, await Notifications.getPermissionsAsync());
  } catch {
    return unavailableSettings(userPreference);
  }
}


async function installationId(create: boolean): Promise<string | null> {
  const stored = await AsyncStorage.getItem(INSTALLATION_ID_KEY);
  if (stored || !create) return stored;
  const generated = Crypto.randomUUID();
  await AsyncStorage.setItem(INSTALLATION_ID_KEY, generated);
  return generated;
}


function easProjectId(): string | null {
  const fromExtra = Constants.expoConfig?.extra?.eas?.projectId;
  const fromEasConfig = Constants.easConfig?.projectId;
  return typeof fromExtra === 'string'
    ? fromExtra
    : typeof fromEasConfig === 'string'
      ? fromEasConfig
      : null;
}


async function hasPushEligibility(): Promise<boolean> {
  try {
    const result = await api<{ eligible: boolean }>('/push/eligibility');
    return result.eligible === true;
  } catch {
    pushDiagnostic('eligibility_check_unavailable');
    return false;
  }
}


async function showRationaleOnce(): Promise<boolean> {
  const [seen, accepted] = await Promise.all([
    AsyncStorage.getItem(RATIONALE_SEEN_KEY),
    AsyncStorage.getItem(RATIONALE_ACCEPTED_KEY),
  ]);
  if (seen === 'true') return accepted === 'true';

  return new Promise((resolve) => {
    Alert.alert(
      'Stay updated on your trips',
      'Trip Splitter alerts may appear on your lock screen. They can show the trip name and activity type; a chat sender; an expense creator and description or category; or payment parties, amount, and currency. Payment notes, UPI details, email addresses, receipts, message text, credentials, and rejection reasons are never included.',
      [
        {
          text: 'Not now',
          style: 'cancel',
          onPress: () => {
            void AsyncStorage.multiSet([
              [RATIONALE_SEEN_KEY, 'true'],
              [RATIONALE_ACCEPTED_KEY, 'false'],
            ]).then(() => resolve(false), () => resolve(false));
          },
        },
        {
          text: 'Enable notifications',
          onPress: () => {
            void AsyncStorage.multiSet([
              [RATIONALE_SEEN_KEY, 'true'],
              [RATIONALE_ACCEPTED_KEY, 'true'],
            ]).then(() => resolve(true), () => resolve(true));
          },
        },
      ],
      { cancelable: false },
    );
  });
}


async function registerGrantedInstallation(): Promise<PushPermissionState> {
  const projectId = easProjectId();
  if (!projectId) {
    pushDiagnostic('registration_unavailable', { reason: 'missing_project_id' });
    return 'unavailable';
  }
  const id = await installationId(true);
  if (!id) {
    pushDiagnostic('registration_unavailable', { reason: 'missing_installation_id' });
    return 'unavailable';
  }
  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    pushDiagnostic('registration_unavailable', { reason: 'native_token_error' });
    return 'unavailable';
  }
  try {
    await api(`/push/devices/${id}`, {
      method: 'PUT',
      body: { token, platform: 'android' },
    });
    pushDiagnostic('registration_succeeded');
    return 'granted';
  } catch {
    pushDiagnostic('registration_unavailable', { reason: 'api_registration_error' });
    return 'unavailable';
  }
}


async function performSync(options: PushSyncOptions): Promise<PushPermissionState> {
  if (Platform.OS !== 'android') return 'unavailable';
  try {
    const userPreference = await notificationPreference();
    if (userPreference === false) {
      // Persisted intent wins over the OS permission. Retrying this best-effort DELETE on every
      // eligible foreground sync repairs an offline disable without ever prompting Android.
      await unregisterCurrentPushInstallation('user_disabled');
      return getPushPermissionState();
    }
    if (!(await hasPushEligibility())) return getPushPermissionState();
    await ensureChannel();

    let permissions = await Notifications.getPermissionsAsync();
    let state = permissionState(permissions);
    if (
      userPreference === null
      && state === 'undetermined'
      && options.allowPermissionPrompt !== false
    ) {
      const accepted = await showRationaleOnce();
      if (accepted) {
        permissions = await Notifications.requestPermissionsAsync();
        state = permissionState(permissions);
      }
    }
    if (state === 'denied') {
      // A token can remain valid after permission is revoked. Deactivate the server binding so
      // receipt success is not mistaken for a notification Android will never display.
      await unregisterCurrentPushInstallation('permission_denied');
      pushDiagnostic('permission_denied');
      return state;
    }
    if (state !== 'granted') return state;
    return registerGrantedInstallation();
  } catch {
    pushDiagnostic('synchronization_unavailable');
    return 'unavailable';
  }
}


export function syncPushRegistrationIfEligible(
  options: PushSyncOptions = {},
): Promise<PushPermissionState> {
  if (!currentSync) {
    const pendingSettingsChange = currentSettingsChange;
    const sync = pendingSettingsChange
      ? pendingSettingsChange.then(() => performSync(options))
      : performSync(options);
    currentSync = sync.finally(() => { currentSync = null; });
  }
  return currentSync;
}


async function performSettingsChange(
  enabled: boolean,
): Promise<PushNotificationSettingsSnapshot> {
  if (Platform.OS !== 'android') return unavailableSettings();
  // Capture only work that predates this action. A foreground sync started after the switch action
  // waits for currentSettingsChange instead, avoiding both registration races and circular waits.
  const pendingSync = currentSync;

  try {
    // Save intent before any network/native work. If a startup sync is already in flight, waiting
    // for it below and applying this action last prevents a stale registration from winning.
    await AsyncStorage.setItem(NOTIFICATIONS_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    pushDiagnostic('preference_update_unavailable');
    return unavailableSettings();
  }

  if (!enabled) {
    // Deactivate immediately, then repeat after any older startup sync. The second idempotent
    // DELETE guarantees an already-running registration cannot win the race with this opt-out.
    await unregisterCurrentPushInstallation('user_disabled');
    if (pendingSync) {
      await pendingSync;
      await unregisterCurrentPushInstallation('user_disabled');
    }
    return settingsForPreference(false);
  }

  if (pendingSync) await pendingSync;

  let permissions: Notifications.NotificationPermissionsStatus;
  try {
    await ensureChannel();
    permissions = await Notifications.getPermissionsAsync();
    if (permissionState(permissions) !== 'granted' && permissions.canAskAgain === true) {
      // The switch is explicit user intent, so it deliberately bypasses the optional first-run
      // privacy rationale (including a previously saved "Not now" choice).
      permissions = await Notifications.requestPermissionsAsync();
    }
  } catch {
    pushDiagnostic('settings_update_unavailable');
    return unavailableSettings(true);
  }

  const snapshot = settingsSnapshot(true, permissions);
  if (snapshot.permission === 'denied') {
    await unregisterCurrentPushInstallation('permission_denied');
    return snapshot;
  }
  if (snapshot.permission !== 'granted') return snapshot;

  await registerGrantedInstallation();
  return snapshot;
}


export function setPushNotificationsEnabled(
  enabled: boolean,
): Promise<PushNotificationSettingsSnapshot> {
  if (!currentSettingsChange) {
    currentSettingsChange = performSettingsChange(enabled)
      .finally(() => { currentSettingsChange = null; });
  }
  return currentSettingsChange;
}


export async function unregisterCurrentPushInstallation(
  reason: PushUnregisterReason = 'logout',
): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const id = await installationId(false);
    if (!id) return;
    const suffix = reason === 'logout' ? '' : `?reason=${encodeURIComponent(reason)}`;
    await api(`/push/devices/${id}${suffix}`, { method: 'DELETE' });
    pushDiagnostic('registration_deactivated');
  } catch {
    // Logout and local preference changes must always complete. Foreground synchronization retries
    // a persisted opt-out, and a later authenticated token upsert safely reassigns an installation.
    pushDiagnostic('registration_deactivation_unavailable');
  }
}


export async function getPushPermissionState(): Promise<PushPermissionState> {
  if (Platform.OS !== 'android') return 'unavailable';
  try {
    return permissionState(await Notifications.getPermissionsAsync());
  } catch {
    return 'unavailable';
  }
}


export async function getPushNotificationSettings(): Promise<PushNotificationSettingsSnapshot> {
  if (Platform.OS !== 'android') return unavailableSettings();
  try {
    const [userPreference, permissions] = await Promise.all([
      notificationPreference(),
      Notifications.getPermissionsAsync(),
    ]);
    return settingsSnapshot(userPreference, permissions);
  } catch {
    return unavailableSettings();
  }
}


export async function openPushNotificationSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await ensureChannel();
  } catch {
    // Opening Android settings is still useful if channel setup is temporarily unavailable.
    pushDiagnostic('settings_channel_unavailable');
  }
  await Linking.openSettings();
}
