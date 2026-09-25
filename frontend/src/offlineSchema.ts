export const OFFLINE_SCHEMA_VERSION = 3;

type MigrationTransaction = {
  execAsync(sql: string): Promise<void>;
};
export type MigrationDatabase = MigrationTransaction & {
  getFirstAsync<T>(sql: string): Promise<T | null>;
  withExclusiveTransactionAsync(task: (tx: MigrationTransaction) => Promise<void>): Promise<void>;
};

const FIRST_SCHEMA = `
CREATE TABLE account_meta (
  account_id TEXT PRIMARY KEY NOT NULL,
  profile_json TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  token_expires_at INTEGER NOT NULL,
  offline_protocol_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE trip_snapshots (
  account_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  roster_fingerprint TEXT,
  PRIMARY KEY (account_id, trip_id),
  FOREIGN KEY (account_id) REFERENCES account_meta(account_id) ON DELETE CASCADE
);
CREATE TABLE read_snapshots (
  account_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expenses', 'balances', 'spend', 'payments')),
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, trip_id, kind),
  FOREIGN KEY (account_id) REFERENCES account_meta(account_id) ON DELETE CASCADE
);
CREATE TABLE outbox (
  client_mutation_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('expense_create', 'manual_payment_create')),
  payload_json TEXT NOT NULL,
  precondition_json TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'sending', 'awaiting_reconcile', 'synced', 'needs_review', 'paused_auth'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  last_safe_error_code TEXT,
  canonical_resource_id TEXT,
  acknowledged_response_json TEXT,
  FOREIGN KEY (account_id) REFERENCES account_meta(account_id) ON DELETE CASCADE
);
CREATE INDEX outbox_account_queue ON outbox(account_id, state, queued_at);
CREATE TABLE sync_meta (
  account_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  last_successful_refresh_at INTEGER,
  last_error_class TEXT,
  worker_lease_until INTEGER,
  PRIMARY KEY (account_id, trip_id),
  FOREIGN KEY (account_id) REFERENCES account_meta(account_id) ON DELETE CASCADE
);
`;

const SECOND_SCHEMA = `
CREATE TABLE account_read_snapshots (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('trip_list', 'dashboard_overview')),
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind),
  FOREIGN KEY (account_id) REFERENCES account_meta(account_id) ON DELETE CASCADE
);
`;

const THIRD_SCHEMA = `
ALTER TABLE outbox ADD COLUMN budget_approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN review_context_json TEXT;
`;

export async function migrateOfflineSchema(db: MigrationDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;
  if (version > OFFLINE_SCHEMA_VERSION || version < 0) {
    throw new Error(`Unsupported offline schema version ${version}`);
  }
  if (version === OFFLINE_SCHEMA_VERSION) return;
  if (version < 1) {
    await db.withExclusiveTransactionAsync(async (tx) => {
      await tx.execAsync(FIRST_SCHEMA);
      await tx.execAsync('PRAGMA user_version = 1');
    });
  }
  if (version < 2) {
    await db.withExclusiveTransactionAsync(async (tx) => {
      await tx.execAsync(SECOND_SCHEMA);
      await tx.execAsync('PRAGMA user_version = 2');
    });
  }
  if (version < 3) {
    await db.withExclusiveTransactionAsync(async (tx) => {
      await tx.execAsync(THIRD_SCHEMA);
      await tx.execAsync('PRAGMA user_version = 3');
    });
  }
}
