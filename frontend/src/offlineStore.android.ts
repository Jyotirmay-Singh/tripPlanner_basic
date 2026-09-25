import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { migrateOfflineSchema } from './offlineSchema';
import {
  OfflineStoreError, safeSnapshotJson, sanitizedIdentity,
  type CachedIdentityRecord, type OfflineStore,
  type OutboxOperation, type OutboxState, type ReadKind, type Snapshot, type StoredOutboxItem,
} from './offlineStore.shared';

const DB_NAME = 'trip_offline_v1.db';
const KEY_NAME = 'offline_db_key_v1';
const READY_NAME = 'offline_db_initialized_v1';
let activeAccountId: string | null = null;
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

function assertAccount(accountId: string): void {
  if (!accountId || activeAccountId !== accountId) {
    throw new OfflineStoreError('account_mismatch');
  }
}

async function openEncryptedDatabase(): Promise<SQLite.SQLiteDatabase> {
  const exists = new File(SQLite.defaultDatabaseDirectory, DB_NAME).exists;
  const [storedKey, initialized] = await Promise.all([
    SecureStore.getItemAsync(KEY_NAME),
    SecureStore.getItemAsync(READY_NAME),
  ]);
  if (!exists && initialized) throw new OfflineStoreError('database_missing');
  if (exists && !storedKey) throw new OfflineStoreError('key_missing');
  const key = storedKey ?? Array.from(Crypto.getRandomBytes(32))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!/^[0-9a-f]{64}$/.test(key)) throw new OfflineStoreError('key_missing');
  if (!storedKey) await SecureStore.setItemAsync(KEY_NAME, key);

  const db = await SQLite.openDatabaseAsync(DB_NAME);
  try {
    // SQLCipher accepts a raw 256-bit hex key. The strict hex check above makes this interpolation safe.
    await db.execAsync(`PRAGMA key = "x'${key}'"`);
    const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
    if (!cipher?.cipher_version) throw new OfflineStoreError('encryption_unavailable');
    await db.getFirstAsync('SELECT count(*) AS count FROM sqlite_master');
    await db.execAsync('PRAGMA foreign_keys = ON');
    try {
      await migrateOfflineSchema(db);
    } catch {
      throw new OfflineStoreError('migration_failed');
    }
    await SecureStore.setItemAsync(READY_NAME, '1');
    return db;
  } catch (error) {
    await db.closeAsync().catch(() => {});
    if (error instanceof OfflineStoreError) throw error;
    throw new OfflineStoreError('unreadable');
  }
}

function database(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = openEncryptedDatabase().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

type IdentityRow = { profile_json: string; verified_at: number; token_expires_at: number };
type SnapshotRow = { payload_json: string; fetched_at: number };
type OutboxRow = {
  client_mutation_id: string; account_id: string; trip_id: string;
  operation: OutboxOperation; payload_json: string; precondition_json: string;
  queued_at: number; state: OutboxState; attempt_count: number; next_retry_at: number | null;
  last_safe_error_code: string | null; canonical_resource_id: string | null;
  acknowledged_response_json: string | null;
};

export const offlineStore: OfflineStore = {
  setActiveAccount(accountId) { activeAccountId = accountId; },

  async getIdentity(accountId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const row = await db.getFirstAsync<IdentityRow>(
      'SELECT profile_json, verified_at, token_expires_at FROM account_meta WHERE account_id = ?',
      accountId,
    );
    assertAccount(accountId);
    if (!row) return null;
    try {
      const profile = JSON.parse(row.profile_json);
      if (profile.id !== accountId || typeof profile.email !== 'string'
        || typeof profile.name !== 'string' || typeof profile.role !== 'string'
        || !Number.isFinite(row.verified_at) || !Number.isFinite(row.token_expires_at)) {
        throw new Error('Invalid cached identity');
      }
      return { profile, verifiedAt: row.verified_at, tokenExpiresAt: row.token_expires_at };
    } catch {
      throw new OfflineStoreError('unreadable');
    }
  },

  async saveIdentity(record: CachedIdentityRecord) {
    const accountId = record.profile.id;
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    await db.runAsync(
      `INSERT INTO account_meta (account_id, profile_json, verified_at, token_expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET profile_json=excluded.profile_json,
         verified_at=excluded.verified_at, token_expires_at=excluded.token_expires_at`,
      accountId, JSON.stringify(sanitizedIdentity(record.profile)),
      record.verifiedAt, record.tokenExpiresAt,
    );
  },

  async getTripSnapshot(accountId, tripId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const row = await db.getFirstAsync<SnapshotRow>(
      'SELECT payload_json, fetched_at FROM trip_snapshots WHERE account_id = ? AND trip_id = ?',
      accountId, tripId,
    );
    assertAccount(accountId);
    return row ? { payload: JSON.parse(row.payload_json), fetchedAt: row.fetched_at } : null;
  },

  async putTripSnapshot(accountId, tripId, snapshot) {
    assertAccount(accountId);
    const payload = safeSnapshotJson(snapshot.payload);
    const db = await database();
    assertAccount(accountId);
    await db.runAsync(
      `INSERT INTO trip_snapshots (account_id, trip_id, payload_json, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, trip_id) DO UPDATE SET payload_json=excluded.payload_json,
         fetched_at=excluded.fetched_at`,
      accountId, tripId, payload, snapshot.fetchedAt,
    );
  },

  async getReadSnapshot(accountId, tripId, kind: ReadKind) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const row = await db.getFirstAsync<SnapshotRow>(
      'SELECT payload_json, fetched_at FROM read_snapshots WHERE account_id = ? AND trip_id = ? AND kind = ?',
      accountId, tripId, kind,
    );
    assertAccount(accountId);
    return row ? { payload: JSON.parse(row.payload_json), fetchedAt: row.fetched_at } : null;
  },

  async putReadSnapshot(accountId, tripId, kind: ReadKind, snapshot: Snapshot) {
    assertAccount(accountId);
    const payload = safeSnapshotJson(snapshot.payload);
    const db = await database();
    assertAccount(accountId);
    await db.runAsync(
      `INSERT INTO read_snapshots (account_id, trip_id, kind, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, trip_id, kind) DO UPDATE SET payload_json=excluded.payload_json,
         fetched_at=excluded.fetched_at`,
      accountId, tripId, kind, payload, snapshot.fetchedAt,
    );
  },

  async enqueueOutbox(item: StoredOutboxItem) {
    assertAccount(item.accountId);
    const payload = safeSnapshotJson(item.payload);
    const precondition = safeSnapshotJson(item.precondition);
    const db = await database();
    assertAccount(item.accountId);
    await db.runAsync(
      `INSERT INTO outbox (client_mutation_id, account_id, trip_id, operation,
         payload_json, precondition_json, queued_at, state, attempt_count, next_retry_at,
         last_safe_error_code, canonical_resource_id, acknowledged_response_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.clientMutationId, item.accountId, item.tripId, item.operation, payload, precondition,
      item.queuedAt, item.state, item.attemptCount, item.nextRetryAt, item.lastSafeErrorCode,
      item.canonicalResourceId,
      item.acknowledgedResponse === null ? null : safeSnapshotJson(item.acknowledgedResponse),
    );
  },

  async listOutbox(accountId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const rows = await db.getAllAsync<OutboxRow>(
      'SELECT * FROM outbox WHERE account_id = ? ORDER BY queued_at, client_mutation_id',
      accountId,
    );
    assertAccount(accountId);
    return rows.map((row) => ({
      clientMutationId: row.client_mutation_id,
      accountId: row.account_id,
      tripId: row.trip_id,
      operation: row.operation,
      payload: JSON.parse(row.payload_json),
      precondition: JSON.parse(row.precondition_json),
      queuedAt: row.queued_at,
      state: row.state,
      attemptCount: row.attempt_count,
      nextRetryAt: row.next_retry_at,
      lastSafeErrorCode: row.last_safe_error_code,
      canonicalResourceId: row.canonical_resource_id,
      acknowledgedResponse: row.acknowledged_response_json
        ? JSON.parse(row.acknowledged_response_json) : null,
    }));
  },

  async pendingCount(accountId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const row = await db.getFirstAsync<{ count: number }>(
      `SELECT count(*) AS count FROM outbox WHERE account_id = ? AND state != 'synced'`,
      accountId,
    );
    assertAccount(accountId);
    return row?.count ?? 0;
  },

  async purgeAccount(accountId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    await db.runAsync('DELETE FROM account_meta WHERE account_id = ?', accountId);
  },
};

export { purgeAccountChatOutbox } from './chatOutboxCleanup';
