import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { Alert, Linking, Platform } from 'react-native';

import { api } from './api';
import type {
  PushPermissionState,
  PushSyncOptions,
  PushUnregisterReason,
} from './pushNotificationTypes';


const INSTALLATION_ID_KEY = 'push_installation_id';
const RATIONALE_SEEN_KEY = 'push_rationale_seen';
const RATIONALE_ACCEPTED_KEY = 'push_rationale_accepted';
const CHANNEL_ID = 'trip_activity';

let currentSync: Promise<PushPermissionState> | null = null;


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
    description: 'Private updates for expenses, payments, settlements, and group messages',
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


async function hasTripAccess(): Promise<boolean> {
  try {
    const trips = await api<{ id: string }[]>('/trips');
    return trips.length > 0;
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
      'Trip Splitter can send private alerts for new expenses, recorded payments, paid settlements, and group messages. Amounts, names, and message text are never shown on the lock screen.',
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
    if (!(await hasTripAccess())) return getPushPermissionState();
    await ensureChannel();

    let permissions = await Notifications.getPermissionsAsync();
    let state = permissionState(permissions);
    if (state === 'undetermined' && options.allowPermissionPrompt !== false) {
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
    currentSync = performSync(options).finally(() => { currentSync = null; });
  }
  return currentSync;
}


export async function unregisterCurrentPushInstallation(
  reason: PushUnregisterReason = 'logout',
): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const id = await installationId(false);
    if (!id) return;
    const suffix = reason === 'permission_denied' ? '?reason=permission_denied' : '';
    await api(`/push/devices/${id}${suffix}`, { method: 'DELETE' });
    pushDiagnostic('registration_deactivated');
  } catch {
    // Logout must always complete. The next authenticated token upsert reassigns this installation.
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


export async function enablePushNotificationsFromSettings(): Promise<PushPermissionState> {
  if (Platform.OS !== 'android') return 'unavailable';
  try {
    await ensureChannel();
    let state = await getPushPermissionState();
    if (state === 'denied') {
      await Linking.openSettings();
      return getPushPermissionState();
    }
    if (state === 'undetermined') {
      await AsyncStorage.multiSet([
        [RATIONALE_SEEN_KEY, 'true'],
        [RATIONALE_ACCEPTED_KEY, 'true'],
      ]).catch(() => {});
      state = permissionState(await Notifications.requestPermissionsAsync());
    }
    if (state === 'granted') {
      return syncPushRegistrationIfEligible({ allowPermissionPrompt: false });
    }
    return state;
  } catch {
    return 'unavailable';
  }
}
