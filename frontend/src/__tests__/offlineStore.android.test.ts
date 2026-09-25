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
    getAllAsync: jest.fn(async (_sql: string) => [] as { kind: string; payload_json: string; fetched_at: number }[]),
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

it('commits one expense UUID durably, rejects changed intent, and retains it after a cold module restart', async () => {
  const { offlineStore, db, secrets } = environment();
  offlineStore.setActiveAccount('account-a');
  await offlineStore.saveIdentity(identity);
  const rows = new Map<string, Record<string, unknown>>();
  let failInsert = false;
  db.withExclusiveTransactionAsync.mockImplementation(async (task: any) => {
    const staged: (() => void)[] = [];
    await task({
      getFirstAsync: async (_sql: string, id: string) => rows.get(id) ?? null,
      runAsync: async (sql: string, ...args: unknown[]) => {
        if (sql.includes('INSERT INTO outbox')) {
          if (failInsert) throw new Error('disk full');
          staged.push(() => rows.set(args[0] as string, {
            client_mutation_id: args[0], account_id: args[1], trip_id: args[2],
            operation: args[3], payload_json: args[4], precondition_json: args[5],
            queued_at: args[6], state: args[7], attempt_count: args[8],
            next_retry_at: args[9], last_safe_error_code: args[10],
            canonical_resource_id: args[11], acknowledged_response_json: args[12],
          }));
        }
      },
    });
    staged.forEach((write) => write());
  });
  db.getAllAsync.mockImplementation(async (sql: string) =>
    (sql.includes('FROM outbox') ? [...rows.values()] : []) as any);
  const item = {
    clientMutationId: '7fa30d5e-b4f6-4cb3-b45a-27b4119d0101',
    accountId: 'account-a', tripId: 'trip-1', operation: 'expense_create' as const,
    payload: { amount: -20, currency: 'INR', split_member_ids: ['member-1'] },
    precondition: { currency: 'INR', members: [{ id: 'member-1' }] },
    queuedAt: 123, state: 'queued' as const, attemptCount: 0, nextRetryAt: null,
    lastSafeErrorCode: null, canonicalResourceId: null, acknowledgedResponse: null,
  };
  failInsert = true;
  await expect(offlineStore.enqueueOutbox(item)).rejects.toThrow('disk full');
  expect(rows.size).toBe(0);
  failInsert = false;
  await offlineStore.enqueueOutbox(item);
  await offlineStore.enqueueOutbox(item);
  expect(rows.size).toBe(1);
  await expect(offlineStore.enqueueOutbox({ ...item, payload: { amount: -30 } }))
    .rejects.toThrow('another expense');

  jest.resetModules();
  const { File } = require('expo-file-system');
  const SecureStore = require('expo-secure-store');
  const SQLite = require('expo-sqlite');
  File.mockImplementation(() => ({ exists: true }));
  SecureStore.getItemAsync.mockImplementation(async (key: string) => secrets.get(key) ?? null);
  SQLite.openDatabaseAsync.mockResolvedValue(db);
  db.getFirstAsync.mockImplementation(async (sql: string) => {
    if (sql === 'PRAGMA cipher_version') return { cipher_version: '4.6.0' };
    if (sql === 'PRAGMA user_version') return { user_version: 3 };
    return { count: 0 };
  });
  const restored = require('../offlineStore.android').offlineStore;
  restored.setActiveAccount('account-a');
  expect(await restored.listOutbox('account-a')).toEqual([{
    ...item, budgetApproved: false, reviewContext: null,
  }]);
  restored.setActiveAccount('account-b');
  await expect(restored.listOutbox('account-a')).rejects.toMatchObject({ code: 'account_mismatch' });
});

it('persists acknowledgement and review decisions with state checks in one transaction', async () => {
  const { offlineStore, db } = environment();
  offlineStore.setActiveAccount('account-a');
  await offlineStore.saveIdentity(identity);
  const id = '7fa30d5e-b4f6-4cb3-b45a-27b4119d0101';
  const row: Record<string, any> = {
    client_mutation_id: id, account_id: 'account-a', trip_id: 'trip-1',
    operation: 'expense_create', payload_json: JSON.stringify({ client_mutation_id: id }),
    precondition_json: '{}', queued_at: 123, state: 'sending', attempt_count: 1,
    next_retry_at: null, last_safe_error_code: null, canonical_resource_id: null,
    acknowledged_response_json: null, budget_approved: 0, review_context_json: null,
  };
  db.withExclusiveTransactionAsync.mockImplementation(async (task: any) => {
    await task({
      getFirstAsync: async (_sql: string, accountId: string, mutationId: string) =>
        accountId === 'account-a' && mutationId === id ? row : null,
      runAsync: async (_sql: string, ...args: unknown[]) => {
        if (row.state !== args[10]) return { changes: 0 };
        [row.state, row.attempt_count, row.next_retry_at, row.last_safe_error_code,
          row.canonical_resource_id, row.acknowledged_response_json, row.budget_approved,
          row.review_context_json] = args.slice(0, 8);
        return { changes: 1 };
      },
    });
  });
  db.getAllAsync.mockImplementation(async () => [row] as any);
  expect(await offlineStore.updateOutbox('account-a', id, ['queued'], { state: 'needs_review' }))
    .toBe(false);
  expect(await offlineStore.updateOutbox('account-a', id, ['sending'], {
    state: 'awaiting_reconcile', canonicalResourceId: 'server-1',
    acknowledgedResponse: { expense: { id: 'server-1' } },
  })).toBe(true);
  expect(await offlineStore.listOutbox('account-a')).toMatchObject([{
    state: 'awaiting_reconcile', canonicalResourceId: 'server-1',
    acknowledgedResponse: { expense: { id: 'server-1' } },
  }]);
  offlineStore.setActiveAccount('account-b');
  await expect(offlineStore.updateOutbox('account-a', id, ['awaiting_reconcile'],
    { state: 'synced' })).rejects.toMatchObject({ code: 'account_mismatch' });
});

it('keeps a rejected intent if edit storage fails and replaces or discards it only by explicit action', async () => {
  const { offlineStore, db } = environment();
  offlineStore.setActiveAccount('account-a');
  await offlineStore.saveIdentity(identity);
  const oldId = 'old-id';
  const rows = new Map<string, Record<string, unknown>>([[oldId, {
    client_mutation_id: oldId, account_id: 'account-a', trip_id: 'trip-1',
    operation: 'expense_create', state: 'needs_review',
  }]]);
  let failInsert = true;
  db.withExclusiveTransactionAsync.mockImplementation(async (task: any) => {
    const staged: (() => void)[] = [];
    await task({
      getFirstAsync: async (_sql: string, id: string) => rows.get(id) ?? null,
      runAsync: async (sql: string, ...args: unknown[]) => {
        if (sql.includes('INSERT INTO outbox')) {
          if (failInsert) throw new Error('disk full');
          staged.push(() => rows.set(args[0] as string, {
            client_mutation_id: args[0], account_id: args[1], trip_id: args[2],
            operation: 'expense_create', state: 'queued',
          }));
        } else if (sql.includes('DELETE FROM outbox')) {
          staged.push(() => rows.delete(args[0] as string));
        }
      },
    });
    staged.forEach((write) => write());
  });
  const updated = {
    clientMutationId: 'new-id', accountId: 'account-a', tripId: 'trip-1',
    operation: 'expense_create' as const, payload: { amount: 25 }, precondition: {},
    queuedAt: 123, state: 'queued' as const, attemptCount: 0, nextRetryAt: null,
    lastSafeErrorCode: null, canonicalResourceId: null, acknowledgedResponse: null,
  };
  await expect(offlineStore.replaceReviewExpense('account-a', oldId, updated))
    .rejects.toThrow('disk full');
  expect([...rows.keys()]).toEqual([oldId]);
  failInsert = false;
  await offlineStore.replaceReviewExpense('account-a', oldId, updated);
  expect([...rows.keys()]).toEqual(['new-id']);
  await expect(offlineStore.discardReviewExpense('account-a', 'new-id'))
    .rejects.toThrow('no longer ready');
  rows.get('new-id')!.state = 'needs_review';
  await offlineStore.discardReviewExpense('account-a', 'new-id');
  expect(rows.size).toBe(0);
  rows.set('payment-id', {
    client_mutation_id: 'payment-id', account_id: 'account-a', trip_id: 'trip-1',
    operation: 'manual_payment_create', state: 'needs_review',
  });
  await offlineStore.discardReviewPayment('account-a', 'payment-id');
  expect(rows.size).toBe(0);
});
