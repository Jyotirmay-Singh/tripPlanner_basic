/* eslint-disable @typescript-eslint/no-require-imports */
import { migrateOfflineSchema } from '../offlineSchema';
import { OFFLINE_RETENTION_MS, pruneOfflineData } from '../offlineRetention';

let DatabaseSync: any;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Older Node lacks built-in SQLite. */ }
const sqliteIt = DatabaseSync ? it : it.skip;

sqliteIt('retains every unresolved action and its trip copy while expiring old confirmed data', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE outbox (account_id TEXT, trip_id TEXT, state TEXT, synced_at INTEGER);
      CREATE TABLE trip_snapshots (account_id TEXT, trip_id TEXT, fetched_at INTEGER);
      CREATE TABLE read_snapshots (account_id TEXT, trip_id TEXT, fetched_at INTEGER);
      CREATE TABLE account_read_snapshots (account_id TEXT, kind TEXT, fetched_at INTEGER);
      CREATE TABLE sync_meta (account_id TEXT, trip_id TEXT);
    `);
    const now = OFFLINE_RETENTION_MS * 3;
    const old = now - OFFLINE_RETENTION_MS - 1;
    const recent = now - OFFLINE_RETENTION_MS + 1;
    const trips = ['queued', 'review', 'reconciling', 'synced-old', 'synced-new'];
    for (const trip of trips) {
      db.prepare('INSERT INTO trip_snapshots VALUES (?, ?, ?)').run('account-a', trip, old);
      db.prepare('INSERT INTO read_snapshots VALUES (?, ?, ?)').run('account-a', trip, old);
      db.prepare('INSERT INTO sync_meta VALUES (?, ?)').run('account-a', trip);
    }
    for (const [trip, state, syncedAt] of [
      ['queued', 'queued', null], ['review', 'needs_review', null],
      ['reconciling', 'awaiting_reconcile', null], ['synced-old', 'synced', old],
      ['synced-new', 'synced', recent],
    ] as const) {
      db.prepare('INSERT INTO outbox VALUES (?, ?, ?, ?)').run('account-a', trip, state, syncedAt);
    }
    db.prepare('INSERT INTO account_read_snapshots VALUES (?, ?, ?)').run('account-a', 'trip_list', old);
    db.prepare('INSERT INTO account_read_snapshots VALUES (?, ?, ?)').run('account-a', 'dashboard_overview', recent);
    db.prepare('INSERT INTO trip_snapshots VALUES (?, ?, ?)').run('account-b', 'other', old);
    db.prepare('INSERT INTO read_snapshots VALUES (?, ?, ?)').run('account-b', 'other', old);
    db.prepare('INSERT INTO outbox VALUES (?, ?, ?, ?)').run('account-b', 'other', 'synced', old);

    const tx = { runAsync: async (sql: string, ...params: (string | number)[]) => {
      db.prepare(sql).run(...params);
    } };
    db.exec('BEGIN');
    await pruneOfflineData(tx, 'account-a', now);
    db.exec('COMMIT');
    const names = (table: string, account: string) => db.prepare(
      `SELECT trip_id FROM ${table} WHERE account_id = ? ORDER BY trip_id`,
    ).all(account).map((row: { trip_id: string }) => row.trip_id);
    expect(names('outbox', 'account-a')).toEqual([
      'queued', 'reconciling', 'review', 'synced-new',
    ]);
    expect(names('trip_snapshots', 'account-a')).toEqual(['queued', 'reconciling', 'review']);
    expect(names('read_snapshots', 'account-a')).toEqual(['queued', 'reconciling', 'review']);
    expect(names('sync_meta', 'account-a')).toEqual(['queued', 'reconciling', 'review']);
    expect(db.prepare('SELECT kind FROM account_read_snapshots WHERE account_id = ?')
      .all('account-a').map((row: { kind: string }) => row.kind)).toEqual(['dashboard_overview']);
    expect(names('outbox', 'account-b')).toEqual(['other']);
    expect(names('trip_snapshots', 'account-b')).toEqual(['other']);
  } finally { db.close(); }
});

sqliteIt('rolls back a failed v5 migration and preserves queued rows on retry', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE outbox (account_id TEXT, state TEXT);
      INSERT INTO outbox VALUES ('account-a', 'queued');
      INSERT INTO outbox VALUES ('account-a', 'synced');
      PRAGMA user_version = 4;`);
    let failOnce = true;
    const adapter = {
      getFirstAsync: async <T,>(sql: string) => db.prepare(sql).get() as T,
      execAsync: async (sql: string) => { db.exec(sql); },
      withExclusiveTransactionAsync: async (task: (tx: { execAsync: (sql: string) => Promise<void> }) => Promise<void>) => {
        db.exec('BEGIN');
        try {
          await task({ execAsync: async (sql) => {
            if (failOnce && sql.includes('CREATE INDEX outbox_account_synced_at')) {
              failOnce = false;
              throw new Error('disk full');
            }
            db.exec(sql);
          } });
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    };
    await expect(migrateOfflineSchema(adapter)).rejects.toThrow('disk full');
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
    expect(db.prepare('PRAGMA table_info(outbox)').all()
      .map((row: { name: string }) => row.name)).not.toContain('synced_at');
    await migrateOfflineSchema(adapter);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    expect(db.prepare('SELECT state, synced_at FROM outbox ORDER BY state').all())
      .toEqual([{ state: 'queued', synced_at: null },
        { state: 'synced', synced_at: expect.any(Number) }]);
  } finally { db.close(); }
});
