export type PushPermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export type PushSyncOptions = {
  allowPermissionPrompt?: boolean;
};
