/* eslint-disable @typescript-eslint/no-require-imports */
import type { CachedIdentityRecord } from '../offlineStore.shared';

jest.mock('expo-file-system', () => ({
  File: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getAllKeys: jest.fn(), multiRemove: jest.fn() },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
}));
jest.mock('expo-crypto', () => ({ getRandomBytes: jest.fn(() => new Uint8Array(32).fill(1)) }));
jest.mock('expo-sqlite', () => ({
  defaultDatabaseDirectory: 'file:///databases',
  openDatabaseAsync: jest.fn(),
}));

const identity: CachedIdentityRecord = {
  profile: { id: 'account-a', email: 'a@gmail.com', name: 'A', role: 'user' },
  verifiedAt: 1000,
  tokenExpiresAt: 2000,
};

function environment(options: {
  fileExists?: boolean; migrationFails?: boolean; cipherMissing?: boolean;
} = {}) {
  jest.resetModules();
  const { File } = require('expo-file-system');
  const SecureStore = require('expo-secure-store');
  const SQLite = require('expo-sqlite');
  const secrets = new Map<string, string>();
  const identities = new Map<string, { profile_json: string; verified_at: number; token_expires_at: number }>();
  let version = 0;
  File.mockImplementation(() => ({ exists: options.fileExists ?? false }));
  SecureStore.getItemAsync.mockImplementation(async (key: string) => secrets.get(key) ?? null);
  SecureStore.setItemAsync.mockImplementation(async (key: string, value: string) => { secrets.set(key, value); });
  const db = {
    execAsync: jest.fn(async () => {}),
    closeAsync: jest.fn(async () => {}),
    getFirstAsync: jest.fn(async (sql: string, accountId?: string) => {
      if (sql === 'PRAGMA cipher_version') {
        return options.cipherMissing ? null : { cipher_version: '4.6.0' };
      }
      if (sql === 'PRAGMA user_version') return { user_version: version };
      if (sql.includes('FROM account_meta')) return identities.get(accountId ?? '') ?? null;
      return { count: 0 };
    }),
    getAllAsync: jest.fn(async () => [] as { kind: string; payload_json: string; fetched_at: number }[]),
    runAsync: jest.fn(async (sql: string, accountId: string, profileJson: string,
      verifiedAt: number, expiresAt: number) => {
      if (sql.includes('INSERT INTO account_meta')) {
        identities.set(accountId, {
          profile_json: profileJson, verified_at: verifiedAt, token_expires_at: expiresAt,
        });
      }
    }),
    withExclusiveTransactionAsync: jest.fn(async (task: (tx: { execAsync: (sql: string) => Promise<void> }) => Promise<void>) => {
      if (options.migrationFails) throw new Error('migration failure');
      await task({ execAsync: async (sql) => {
        if (sql.includes('PRAGMA user_version = 1')) version = 1;
      } });
    }),
  };
  SQLite.openDatabaseAsync.mockResolvedValue(db);
  const { offlineStore } = require('../offlineStore.android');
  return { offlineStore, secrets, identities, db, SQLite };
}

it('keeps identity reads scoped to the currently active account', async () => {
  const { offlineStore, secrets } = environment();
  offlineStore.setActiveAccount('account-a');
  await offlineStore.saveIdentity(identity);
  expect(await offlineStore.getIdentity('account-a')).toEqual(identity);
  expect(secrets.get('offline_db_key_v1')).toMatch(/^[0-9a-f]{64}$/);
  offlineStore.setActiveAccount('account-b');
  await expect(offlineStore.getIdentity('account-a')).rejects.toMatchObject({
    code: 'account_mismatch',
  });
});

it('refuses a restored database whose encryption key is missing', async () => {
  const { offlineStore, SQLite } = environment({ fileExists: true });
  offlineStore.setActiveAccount('account-a');
  await expect(offlineStore.getIdentity('account-a')).rejects.toMatchObject({ code: 'key_missing' });
  expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
});

it('keeps the encrypted database and key intact after migration failure', async () => {
  const { offlineStore, secrets, SQLite } = environment({ migrationFails: true });
  offlineStore.setActiveAccount('account-a');
  await expect(offlineStore.saveIdentity(identity)).rejects.toMatchObject({ code: 'migration_failed' });
  expect(secrets.has('offline_db_key_v1')).toBe(true);
  expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
});

it('refuses to use a plaintext SQLite runtime', async () => {
  const { offlineStore, db } = environment({ cipherMissing: true });
  offlineStore.setActiveAccount('account-a');
  await expect(offlineStore.saveIdentity(identity)).rejects.toMatchObject({
    code: 'encryption_unavailable',
  });
  expect(db.closeAsync).toHaveBeenCalled();
});

it('replaces all five trip reads atomically and retains the old set after a failed write', async () => {
  const { offlineStore, db } = environment();
  offlineStore.setActiveAccount('account-a');
  await offlineStore.saveIdentity(identity);
  let tripRow: { payload_json: string; fetched_at: number } | null = null;
  const readRows = new Map<string, { kind: string; payload_json: string; fetched_at: number }>();
  let failPayments = false;
  db.withExclusiveTransactionAsync.mockImplementation(async (task: any) => {
    const staged: (() => void)[] = [];
    await task({
      runAsync: async (sql: string, ...args: unknown[]) => {
        if (sql.includes('INSERT INTO trip_snapshots')) {
          staged.push(() => { tripRow = { payload_json: args[2] as string, fetched_at: args[3] as number }; });
        } else if (sql.includes('INSERT INTO read_snapshots')) {
          if (args[2] === 'payments' && failPayments) throw new Error('disk full');
          staged.push(() => { readRows.set(args[2] as string, {
            kind: args[2] as string, payload_json: args[3] as string,
            fetched_at: args[4] as number,
          }); });
        }
      },
    });
    staged.forEach((write) => write());
  });
  db.getFirstAsync.mockImplementation(async (sql: string) =>
    sql.includes('FROM trip_snapshots') ? tripRow as any : null);
  db.getAllAsync.mockImplementation(async () => [...readRows.values()]);
  const original = { trip: { name: 'Coast' }, expenses: [{ amount: 100 }],
    balances: { net: { a: 100 } }, spend: { total: 100 }, payments: [] };
  await offlineStore.putTripReadBundle('account-a', 'trip-1', { payload: original, fetchedAt: 10 });
  expect(await offlineStore.getTripReadBundle('account-a', 'trip-1')).toEqual({
    payload: original, fetchedAt: 10,
  });
  offlineStore.setActiveAccount('account-b');
  await expect(offlineStore.getTripReadBundle('account-a', 'trip-1'))
    .rejects.toMatchObject({ code: 'account_mismatch' });
  offlineStore.setActiveAccount('account-a');
  failPayments = true;
  await expect(offlineStore.putTripReadBundle('account-a', 'trip-1', {
    payload: { ...original, expenses: [{ amount: 900 }] }, fetchedAt: 20,
  })).rejects.toThrow('disk full');
  expect(await offlineStore.getTripReadBundle('account-a', 'trip-1')).toEqual({
    payload: original, fetchedAt: 10,
  });
  expect(db.runAsync).toHaveBeenCalledTimes(1); // Identity only; bundle writes use the transaction.
});
