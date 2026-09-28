import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const LEGACY_TOKEN_KEY = 'auth_token';
const SECURE_TOKEN_KEY = 'android_auth_token_v1';

export async function getStoredToken(): Promise<string | null> {
  let secureToken: string | null;
  try {
    secureToken = await SecureStore.getItemAsync(SECURE_TOKEN_KEY);
  } catch (error) {
    const legacyToken = await AsyncStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacyToken) return legacyToken;
    throw error;
  }
  if (secureToken) {
    // A previous cleanup failure must not leave a second plaintext copy indefinitely.
    await AsyncStorage.removeItem(LEGACY_TOKEN_KEY).catch(() => {});
    return secureToken;
  }
  const legacyToken = await AsyncStorage.getItem(LEGACY_TOKEN_KEY);
  if (!legacyToken) return null;
  try {
    await SecureStore.setItemAsync(SECURE_TOKEN_KEY, legacyToken);
    if (await SecureStore.getItemAsync(SECURE_TOKEN_KEY) !== legacyToken) {
      throw new Error('Secure token verification failed');
    }
    await AsyncStorage.removeItem(LEGACY_TOKEN_KEY).catch(() => {});
  } catch {
    // Keep the old token usable online and retry migration later. Never delete the sole copy.
  }
  return legacyToken;
}

export async function setStoredToken(token: string | null): Promise<void> {
  if (token) {
    await SecureStore.setItemAsync(SECURE_TOKEN_KEY, token);
    if (await SecureStore.getItemAsync(SECURE_TOKEN_KEY) !== token) {
      throw new Error('Secure token verification failed');
    }
    await AsyncStorage.removeItem(LEGACY_TOKEN_KEY).catch(() => {});
  } else {
    // Delete the legacy copy first, or a later get could migrate it back after logout.
    await AsyncStorage.removeItem(LEGACY_TOKEN_KEY);
    await SecureStore.deleteItemAsync(SECURE_TOKEN_KEY);
  }
}
