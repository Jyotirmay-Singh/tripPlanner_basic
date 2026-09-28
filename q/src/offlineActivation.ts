import { Platform } from 'react-native';

// The release build opts in only after backend and device gates pass. Both variables are
// inlined by Expo; ordinary builds remain off, and runtime protocol checks still fail closed.
export const ANDROID_OFFLINE_WRITES_ENABLED = process.env.EXPO_PUBLIC_OFFLINE_QA === 'true'
  || process.env.EXPO_PUBLIC_ANDROID_OFFLINE_WRITES === 'true';

export const offlineWritesActive = () => Platform.OS === 'android' && ANDROID_OFFLINE_WRITES_ENABLED;
