export type PushPermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export type PushSyncOptions = {
  allowPermissionPrompt?: boolean;
};

export type PushUnregisterReason = 'logout' | 'permission_denied';
