import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { getStoredToken, setStoredToken } from '../tokenStorage.android';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
}));

const legacy = new Map<string, string>();
const secure = new Map<string, string>();

beforeEach(() => {
  legacy.clear(); secure.clear(); jest.resetAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key) => legacy.get(key) ?? null);
  (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key) => { legacy.delete(key); });
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key) => secure.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key, value) => { secure.set(key, value); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key) => { secure.delete(key); });
});

it('migrates an existing Android token without signing out, then restores it after restart', async () => {
  legacy.set('auth_token', 'old-jwt');
  expect(await getStoredToken()).toBe('old-jwt');
  expect(secure.get('android_auth_token_v1')).toBe('old-jwt');
  expect(legacy.has('auth_token')).toBe(false);
  expect(await getStoredToken()).toBe('old-jwt');
});

it('keeps the sole legacy token when SecureStore migration fails', async () => {
  legacy.set('auth_token', 'old-jwt');
  (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keystore unavailable'));
  expect(await getStoredToken()).toBe('old-jwt');
  expect(legacy.get('auth_token')).toBe('old-jwt');
});

it('uses the legacy token online if SecureStore cannot be read during migration', async () => {
  legacy.set('auth_token', 'old-jwt');
  (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keystore unavailable'));
  expect(await getStoredToken()).toBe('old-jwt');
  expect(legacy.get('auth_token')).toBe('old-jwt');
});

it('sign-out removes both token locations', async () => {
  legacy.set('auth_token', 'old-jwt');
  secure.set('android_auth_token_v1', 'new-jwt');
  await setStoredToken(null);
  expect(await getStoredToken()).toBeNull();
});
