import { Platform } from 'react-native';

// Android saves use the durable outbox in ordinary builds. Expo inlines these variables;
// an explicit false is a build-time opt-out, while the separate QA package stays enabled.
// Capture and delivery still require the server's account-scoped protocol-v1 capability.
export const ANDROID_OFFLINE_WRITES_ENABLED = process.env.EXPO_PUBLIC_OFFLINE_QA === 'true'
  || process.env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES !== 'false';

export const offlineWritesActive = () => Platform.OS === 'android' && ANDROID_OFFLINE_WRITES_ENABLED;
