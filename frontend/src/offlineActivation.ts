import { Platform } from 'react-native';

// Only a disposable QA APK may exercise writes before the native release gates pass.
// Expo inlines this public build variable; preview and production builds leave it unset.
export const ANDROID_OFFLINE_WRITES_ENABLED = process.env.EXPO_PUBLIC_OFFLINE_QA === 'true';

export const offlineWritesActive = () => Platform.OS === 'android' && ANDROID_OFFLINE_WRITES_ENABLED;
