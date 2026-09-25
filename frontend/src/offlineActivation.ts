import { Platform } from 'react-native';

// Activation waits for native SQLCipher restart and live MongoDB transaction verification.
export const ANDROID_OFFLINE_WRITES_ENABLED = false;

export const offlineWritesActive = () => Platform.OS === 'android' && ANDROID_OFFLINE_WRITES_ENABLED;
