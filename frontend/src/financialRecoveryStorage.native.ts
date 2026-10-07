import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

// Small verified chunks avoid SecureStore's per-value size limits. The manifest is committed last,
// so a killed process never reads a partially written request. No token is stored here.
const key = (scope: string) => `financial_recovery_v1.${Array.from(scope).map(c => c.codePointAt(0)!.toString(16)).join('_')}`;
type Manifest = { generation: string; count: number };
async function manifest(base: string): Promise<Manifest | null> {
  const raw = await SecureStore.getItemAsync(base);
  if (!raw) return null;
  const value = JSON.parse(raw) as Manifest;
  if (!/^[\w-]+$/.test(value.generation) || !Number.isInteger(value.count) || value.count < 1 || value.count > 100)
    throw new Error('Payment recovery is unreadable. Check your pending payments while connected.');
  return value;
}
async function discard(base: string, value: Manifest | null) {
  if (value) await Promise.all(Array.from({ length: value.count }, (_, i) =>
    SecureStore.deleteItemAsync(`${base}.${value.generation}.${i}`)));
}
export async function readRecovery(scope: string): Promise<string | null> {
  const base = key(scope), value = await manifest(base);
  if (!value) return null;
  const parts = await Promise.all(Array.from({ length: value.count }, (_, i) =>
    SecureStore.getItemAsync(`${base}.${value.generation}.${i}`)));
  if (parts.some(part => part === null)) throw new Error('Payment recovery is incomplete. Check your pending payments while connected.');
  return parts.join('');
}
export async function writeRecovery(scope: string, value: string): Promise<void> {
  const base = key(scope), prior = await manifest(base);
  const chunks: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 400, value.length);
    // Do not split a UTF-16 surrogate pair across independently encoded native values.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
    chunks.push(value.slice(start, end)); start = end;
  }
  const next = { generation: Crypto.randomUUID(), count: chunks.length };
  if (!next.count) throw new Error('Payment recovery is empty. No request was sent.');
  if (next.count > 100) throw new Error('Payment recovery is too large. Shorten the payment note.');
  try {
    for (let i = 0; i < next.count; i++) {
      const partKey = `${base}.${next.generation}.${i}`, part = chunks[i];
      await SecureStore.setItemAsync(partKey, part);
      if (await SecureStore.getItemAsync(partKey) !== part) throw new Error('Payment recovery could not be saved. No request was sent.');
    }
  } catch (failure) {
    await discard(base, next).catch(() => {});
    throw failure;
  }
  await SecureStore.setItemAsync(base, JSON.stringify(next));
  if (await SecureStore.getItemAsync(base) !== JSON.stringify(next)) throw new Error('Payment recovery could not be saved. No request was sent.');
  await discard(base, prior).catch(() => {});
}
export async function removeRecovery(scope: string): Promise<void> {
  const base = key(scope), prior = await manifest(base);
  await SecureStore.deleteItemAsync(base);
  await discard(base, prior);
}
