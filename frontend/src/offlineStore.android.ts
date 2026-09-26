import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { migrateOfflineSchema } from './offlineSchema';
import { pruneOfflineData } from './offlineRetention';
import {
  OfflineStoreError, safeSnapshotJson, sanitizedIdentity,
  type CachedIdentityRecord, type OfflineStore,
  type OutboxOperation, type OutboxState, type ReadKind, type Snapshot, type StoredOutboxItem,
  type TripReadBundle,
} from './offlineStore.shared';

const DB_NAME = 'trip_offline_v1.db';
const KEY_NAME = 'offline_db_key_v1';
const READY_NAME = 'offline_db_initialized_v1';
let activeAccountId: string | null = null;
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let databaseKey: string | null = null;

function assertAccount(accountId: string): void {
  if (!accountId || activeAccountId !== accountId) {
    throw new OfflineStoreError('account_mismatch');
  }
}

async function withEncryptedTransaction(
  task: (tx: SQLite.SQLiteDatabase) => Promise<void>,
  key = databaseKey,
): Promise<void> {
  if (!key) throw new OfflineStoreError('key_missing');
  // Expo's exclusive transaction API opens a new connection without copying PRAGMA key.
  // Open and key an isolated connection before beginning its transaction instead.
  const tx = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
  try {
    await tx.execAsync(`PRAGMA key = "x'${key}'"`);
    await tx.getFirstAsync('SELECT count(*) AS count FROM sqlite_master');
    await tx.execAsync('PRAGMA foreign_keys = ON');
    await tx.withTransactionAsync(() => task(tx));
  } finally {
    await tx.closeAsync().catch(() => {});
  }
}

async function openEncryptedDatabase(): Promise<SQLite.SQLiteDatabase> {
  // expo-sqlite exposes a filesystem path on Android, while expo-file-system requires a file URI.
  const directory = SQLite.defaultDatabaseDirectory;
  const exists = new File(directory.startsWith('file://') ? directory : `file://${directory}`, DB_NAME).exists;
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
      await migrateOfflineSchema({
        execAsync: (sql) => db.execAsync(sql),
        getFirstAsync: <T,>(sql: string) => db.getFirstAsync<T>(sql),
        withExclusiveTransactionAsync: (task) => withEncryptedTransaction(task, key),
      });
    } catch {
      throw new OfflineStoreError('migration_failed');
    }
    await SecureStore.setItemAsync(READY_NAME, '1');
    databaseKey = key;
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
      databaseKey = null;
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
  budget_approved: number; review_context_json: string | null;
  synced_at: number | null;
};

function outboxItem(row: OutboxRow): StoredOutboxItem {
  return {
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
    syncedAt: row.synced_at ?? null,
    budgetApproved: row.budget_approved === 1,
    reviewContext: row.review_context_json ? JSON.parse(row.review_context_json) : null,
  };
}

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

  async getExpenseProtocolVersion(accountId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const row = await db.getFirstAsync<{ offline_protocol_version: number }>(
      'SELECT offline_protocol_version FROM account_meta WHERE account_id = ?', accountId,
    );
    assertAccount(accountId);
    return row?.offline_protocol_version ?? 0;
  },

  async setExpenseProtocolVersion(accountId, version) {
    assertAccount(accountId);
    if (version !== 0 && version !== 1) throw new Error('Unsupported expense protocol version');
    const db = await database();
    assertAccount(accountId);
    await db.runAsync(
      'UPDATE account_meta SET offline_protocol_version = ? WHERE account_id = ?',
      version, accountId,
    );
  },

  async getPaymentProtocolVersion(accountId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const row = await db.getFirstAsync<{ payment_protocol_version: number }>(
      'SELECT payment_protocol_version FROM account_meta WHERE account_id = ?', accountId,
    );
    assertAccount(accountId);
    return row?.payment_protocol_version ?? 0;
  },

  async setPaymentProtocolVersion(accountId, version) {
    assertAccount(accountId);
    if (version !== 0 && version !== 1) throw new Error('Unsupported payment protocol version');
    const db = await database();
    assertAccount(accountId);
    await db.runAsync(
      'UPDATE account_meta SET payment_protocol_version = ? WHERE account_id = ?',
      version, accountId,
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

  async getTripReadBundle(accountId, tripId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const trip = await db.getFirstAsync<SnapshotRow>(
      'SELECT payload_json, fetched_at FROM trip_snapshots WHERE account_id = ? AND trip_id = ?',
      accountId, tripId,
    );
    const rows = await db.getAllAsync<SnapshotRow & { kind: ReadKind }>(
      'SELECT kind, payload_json, fetched_at FROM read_snapshots WHERE account_id = ? AND trip_id = ?',
      accountId, tripId,
    );
    assertAccount(accountId);
    if (!trip || rows.length !== 4 || rows.some((row) => row.fetched_at !== trip.fetched_at)) {
      return null;
    }
    try {
      const payload: Partial<TripReadBundle> = { trip: JSON.parse(trip.payload_json) };
      for (const row of rows) payload[row.kind] = JSON.parse(row.payload_json);
      if (payload.expenses === undefined || payload.balances === undefined
        || payload.spend === undefined || payload.payments === undefined) return null;
      return { payload: payload as TripReadBundle, fetchedAt: trip.fetched_at };
    } catch {
      throw new OfflineStoreError('unreadable');
    }
  },

  async putTripReadBundle(accountId, tripId, snapshot) {
    assertAccount(accountId);
    const bundle = snapshot.payload as TripReadBundle;
    const tripJson = safeSnapshotJson(bundle.trip);
    const rows: { kind: ReadKind; json: string }[] = [
      { kind: 'expenses', json: safeSnapshotJson(bundle.expenses) },
      { kind: 'balances', json: safeSnapshotJson(bundle.balances) },
      { kind: 'spend', json: safeSnapshotJson(bundle.spend) },
      { kind: 'payments', json: safeSnapshotJson(bundle.payments) },
    ];
    await database();
    assertAccount(accountId);
    await withEncryptedTransaction(async (tx) => {
      assertAccount(accountId);
      await tx.runAsync(
        `INSERT INTO trip_snapshots (account_id, trip_id, payload_json, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, trip_id) DO UPDATE SET payload_json=excluded.payload_json,
           fetched_at=excluded.fetched_at`,
        accountId, tripId, tripJson, snapshot.fetchedAt,
      );
      for (const row of rows) {
        await tx.runAsync(
          `INSERT INTO read_snapshots (account_id, trip_id, kind, payload_json, fetched_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id, trip_id, kind) DO UPDATE SET payload_json=excluded.payload_json,
             fetched_at=excluded.fetched_at`,
          accountId, tripId, row.kind, row.json, snapshot.fetchedAt,
        );
      }
      assertAccount(accountId);
    });
  },

  async removeTripReadData(accountId, tripId) {
    assertAccount(accountId);
    await database();
    assertAccount(accountId);
    await withEncryptedTransaction(async (tx) => {
      assertAccount(accountId);
      await tx.runAsync('DELETE FROM read_snapshots WHERE account_id = ? AND trip_id = ?', accountId, tripId);
      await tx.runAsync('DELETE FROM trip_snapshots WHERE account_id = ? AND trip_id = ?', accountId, tripId);
    });
  },

  async getAccountReadSnapshot(accountId, kind) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const row = await db.getFirstAsync<SnapshotRow>(
      'SELECT payload_json, fetched_at FROM account_read_snapshots WHERE account_id = ? AND kind = ?',
      accountId, kind,
    );
    assertAccount(accountId);
    if (!row) return null;
    try {
      return { payload: JSON.parse(row.payload_json), fetchedAt: row.fetched_at };
    } catch {
      throw new OfflineStoreError('unreadable');
    }
  },

  async putAccountReadSnapshot(accountId, kind, snapshot) {
    assertAccount(accountId);
    const payload = safeSnapshotJson(snapshot.payload);
    const db = await database();
    assertAccount(accountId);
    await db.runAsync(
      `INSERT INTO account_read_snapshots (account_id, kind, payload_json, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, kind) DO UPDATE SET payload_json=excluded.payload_json,
         fetched_at=excluded.fetched_at`,
      accountId, kind, payload, snapshot.fetchedAt,
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
    await database();
    assertAccount(item.accountId);
    await withEncryptedTransaction(async (tx) => {
      assertAccount(item.accountId);
      const existing = await tx.getFirstAsync<OutboxRow>(
        'SELECT * FROM outbox WHERE client_mutation_id = ?', item.clientMutationId,
      );
      if (existing) {
        if (existing.account_id !== item.accountId || existing.trip_id !== item.tripId
          || existing.operation !== item.operation || existing.payload_json !== payload
          || existing.precondition_json !== precondition) {
          throw new Error('This save ID already belongs to another transaction');
        }
        return;
      }
      await tx.runAsync(
        `INSERT INTO outbox (client_mutation_id, account_id, trip_id, operation,
           payload_json, precondition_json, queued_at, state, attempt_count, next_retry_at,
           last_safe_error_code, canonical_resource_id, acknowledged_response_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.clientMutationId, item.accountId, item.tripId, item.operation, payload, precondition,
        item.queuedAt, item.state, item.attemptCount, item.nextRetryAt, item.lastSafeErrorCode,
        item.canonicalResourceId,
        item.acknowledgedResponse === null ? null : safeSnapshotJson(item.acknowledgedResponse),
      );
      assertAccount(item.accountId);
    });
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
    return rows.map(outboxItem);
  },

  async updateOutbox(accountId, mutationId, from, update) {
    assertAccount(accountId);
    if (!from.length) throw new Error('Expected outbox state is required');
    const response = update.acknowledgedResponse === undefined ? undefined
      : update.acknowledgedResponse === null ? null : safeSnapshotJson(update.acknowledgedResponse);
    const context = update.reviewContext === undefined ? undefined
      : update.reviewContext === null ? null : safeSnapshotJson(update.reviewContext);
    await database();
    assertAccount(accountId);
    let updated = false;
    await withEncryptedTransaction(async (tx) => {
      assertAccount(accountId);
      const row = await tx.getFirstAsync<OutboxRow>(
        'SELECT * FROM outbox WHERE account_id = ? AND client_mutation_id = ?',
        accountId, mutationId,
      );
      if (!row || !from.includes(row.state)) return;
      const next = { ...outboxItem(row), ...update };
      const changed = await tx.runAsync(
        `UPDATE outbox SET state = ?, attempt_count = ?, next_retry_at = ?,
          last_safe_error_code = ?, canonical_resource_id = ?, acknowledged_response_json = ?,
          budget_approved = ?, review_context_json = ?, synced_at = ?
         WHERE account_id = ? AND client_mutation_id = ? AND state = ?`,
        next.state, next.attemptCount, next.nextRetryAt, next.lastSafeErrorCode,
        next.canonicalResourceId,
        response === undefined ? row.acknowledged_response_json : response,
        next.budgetApproved ? 1 : 0,
        context === undefined ? row.review_context_json : context,
        next.syncedAt ?? null,
        accountId, mutationId, row.state,
      );
      assertAccount(accountId);
      updated = changed.changes === 1;
    });
    return updated;
  },

  async getSyncMeta(accountId, tripId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    const row = await db.getFirstAsync<{
      last_successful_refresh_at: number | null; last_error_class: string | null;
    }>('SELECT last_successful_refresh_at, last_error_class FROM sync_meta WHERE account_id = ? AND trip_id = ?',
      accountId, tripId);
    assertAccount(accountId);
    return row ? { lastSuccessfulRefreshAt: row.last_successful_refresh_at,
      lastErrorClass: row.last_error_class } : null;
  },

  async putSyncMeta(accountId, tripId, meta) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    await db.runAsync(
      `INSERT INTO sync_meta (account_id, trip_id, last_successful_refresh_at, last_error_class)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, trip_id) DO UPDATE SET
         last_successful_refresh_at = excluded.last_successful_refresh_at,
         last_error_class = excluded.last_error_class`,
      accountId, tripId, meta.lastSuccessfulRefreshAt, meta.lastErrorClass,
    );
    assertAccount(accountId);
  },

  async replaceReviewExpense(accountId, oldMutationId, item) {
    assertAccount(accountId);
    if (item.accountId !== accountId || item.operation !== 'expense_create'
      || item.clientMutationId === oldMutationId) throw new Error('Invalid reviewed expense');
    const payload = safeSnapshotJson(item.payload);
    const precondition = safeSnapshotJson(item.precondition);
    await database();
    assertAccount(accountId);
    await withEncryptedTransaction(async (tx) => {
      const old = await tx.getFirstAsync<OutboxRow>(
        'SELECT * FROM outbox WHERE client_mutation_id = ? AND account_id = ?',
        oldMutationId, accountId,
      );
      if (!old || old.operation !== 'expense_create' || old.state !== 'needs_review'
        || old.trip_id !== item.tripId) throw new Error('Expense is no longer ready for review');
      await tx.runAsync(
        `INSERT INTO outbox (client_mutation_id, account_id, trip_id, operation,
           payload_json, precondition_json, queued_at, state, attempt_count, next_retry_at,
           last_safe_error_code, canonical_resource_id, acknowledged_response_json)
         VALUES (?, ?, ?, 'expense_create', ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL)`,
        item.clientMutationId, accountId, item.tripId, payload, precondition, item.queuedAt,
      );
      await tx.runAsync(
        'DELETE FROM outbox WHERE client_mutation_id = ? AND account_id = ? AND state = ?',
        oldMutationId, accountId, 'needs_review',
      );
      assertAccount(accountId);
    });
  },

  async replaceReviewPayment(accountId, oldMutationId, item) {
    assertAccount(accountId);
    if (item.accountId !== accountId || item.operation !== 'manual_payment_create'
      || item.clientMutationId === oldMutationId) throw new Error('Invalid reviewed payment');
    const payload = safeSnapshotJson(item.payload);
    const precondition = safeSnapshotJson(item.precondition);
    await database();
    assertAccount(accountId);
    await withEncryptedTransaction(async (tx) => {
      const old = await tx.getFirstAsync<OutboxRow>(
        'SELECT * FROM outbox WHERE client_mutation_id = ? AND account_id = ?',
        oldMutationId, accountId,
      );
      if (!old || old.operation !== 'manual_payment_create' || old.state !== 'needs_review'
        || old.canonical_resource_id || old.trip_id !== item.tripId
        || old.last_safe_error_code === 'client_mutation_conflict') {
        throw new Error('Payment is no longer ready for review');
      }
      await tx.runAsync(
        `INSERT INTO outbox (client_mutation_id, account_id, trip_id, operation,
           payload_json, precondition_json, queued_at, state, attempt_count, next_retry_at,
           last_safe_error_code, canonical_resource_id, acknowledged_response_json)
         VALUES (?, ?, ?, 'manual_payment_create', ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL)`,
        item.clientMutationId, accountId, item.tripId, payload, precondition, item.queuedAt,
      );
      await tx.runAsync(
        'DELETE FROM outbox WHERE client_mutation_id = ? AND account_id = ? AND state = ?',
        oldMutationId, accountId, 'needs_review',
      );
      assertAccount(accountId);
    });
  },

  async discardReviewExpense(accountId, mutationId) {
    assertAccount(accountId);
    await database();
    assertAccount(accountId);
    await withEncryptedTransaction(async (tx) => {
      const row = await tx.getFirstAsync<OutboxRow>(
        'SELECT * FROM outbox WHERE client_mutation_id = ? AND account_id = ?', mutationId, accountId,
      );
      if (!row || row.operation !== 'expense_create' || row.state !== 'needs_review') {
        throw new Error('Expense is no longer ready for review');
      }
      await tx.runAsync('DELETE FROM outbox WHERE client_mutation_id = ? AND account_id = ?',
        mutationId, accountId);
      assertAccount(accountId);
    });
  },

  async discardReviewPayment(accountId, mutationId) {
    assertAccount(accountId);
    await database();
    assertAccount(accountId);
    await withEncryptedTransaction(async (tx) => {
      const row = await tx.getFirstAsync<OutboxRow>(
        'SELECT * FROM outbox WHERE client_mutation_id = ? AND account_id = ?', mutationId, accountId,
      );
      if (!row || row.operation !== 'manual_payment_create' || row.state !== 'needs_review') {
        throw new Error('Payment is no longer ready for review');
      }
      await tx.runAsync('DELETE FROM outbox WHERE client_mutation_id = ? AND account_id = ?',
        mutationId, accountId);
      assertAccount(accountId);
    });
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

  async pruneRetainedData(accountId, now) {
    assertAccount(accountId);
    await database();
    assertAccount(accountId);
    await withEncryptedTransaction(async (tx) => {
      assertAccount(accountId);
      await pruneOfflineData(tx, accountId, now);
      assertAccount(accountId);
    });
  },

  async purgeAccount(accountId) {
    assertAccount(accountId);
    const db = await database();
    assertAccount(accountId);
    await db.runAsync('DELETE FROM account_meta WHERE account_id = ?', accountId);
  },
};
