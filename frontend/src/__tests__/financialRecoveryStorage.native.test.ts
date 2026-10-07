import { readRecovery, writeRecovery, removeRecovery } from '../financialRecoveryStorage.native';
import * as SecureStore from 'expo-secure-store';
const mockValues = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockValues.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockValues.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockValues.delete(key); }),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'test-generation' }));
beforeEach(() => { mockValues.clear(); jest.clearAllMocks(); });
test('large Unicode requests survive chunked native recovery without entering the read cache', async () => {
  const value = JSON.stringify({ reference: 'private-reference', note: '😀'.repeat(1000) });
  await writeRecovery('["account","trip"]', value);
  expect(await readRecovery('["account","trip"]')).toBe(value);
  expect(await readRecovery('["other-account","trip"]')).toBeNull();
  expect([...mockValues.values()].filter(part => part.includes('😀')).every(part => Buffer.byteLength(part, 'utf8') < 2048)).toBe(true);
  await removeRecovery('["account","trip"]'); expect(mockValues.size).toBe(0);
});
test('failed chunk verification never publishes a partial request', async () => {
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  await expect(writeRecovery('scope', 'payload')).rejects.toThrow('No request was sent');
  expect(await readRecovery('scope')).toBeNull();
});
