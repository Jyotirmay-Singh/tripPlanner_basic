export type PushPermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export type PushSyncOptions = {
  allowPermissionPrompt?: boolean;
};

export type PushNotificationSettingsSnapshot = {
  userPreference: boolean | null;
  permission: PushPermissionState;
  canAskAgain: boolean;
  enabled: boolean;
};

export type PushUnregisterReason = 'logout' | 'permission_denied' | 'user_disabled';
