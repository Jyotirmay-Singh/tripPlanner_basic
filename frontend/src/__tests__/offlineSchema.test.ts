import { migrateOfflineSchema } from '../offlineSchema';

it('rolls back a failed migration and succeeds on retry', async () => {
  let version = 0;
  let failCreate = true;
  const db = {
    getFirstAsync: async <T,>() => ({ user_version: version } as T),
    execAsync: async () => {},
    withExclusiveTransactionAsync: async (task: (tx: { execAsync: (sql: string) => Promise<void> }) => Promise<void>) => {
      let pendingVersion = version;
      await task({
        execAsync: async (sql) => {
          if (sql.includes('CREATE TABLE account_meta') && failCreate) throw new Error('disk full');
          if (sql.includes('PRAGMA user_version = 1')) pendingVersion = 1;
          if (sql.includes('PRAGMA user_version = 2')) pendingVersion = 2;
          if (sql.includes('PRAGMA user_version = 3')) pendingVersion = 3;
        },
      });
      version = pendingVersion;
    },
  };
  await expect(migrateOfflineSchema(db)).rejects.toThrow('disk full');
  expect(version).toBe(0);
  failCreate = false;
  await migrateOfflineSchema(db);
  expect(version).toBe(3);
});

it('upgrades an existing v1 store without recreating its account or outbox tables', async () => {
  let version = 1;
  let failUpgrade = true;
  const statements: string[] = [];
  const db = {
    getFirstAsync: async <T,>() => ({ user_version: version } as T),
    execAsync: async () => {},
    withExclusiveTransactionAsync: async (task: (tx: { execAsync: (sql: string) => Promise<void> }) => Promise<void>) => {
      let pendingVersion = version;
      await task({ execAsync: async (sql) => {
        statements.push(sql);
        if (sql.includes('CREATE TABLE account_read_snapshots') && failUpgrade) {
          throw new Error('disk full');
        }
        if (sql.includes('PRAGMA user_version = 2')) pendingVersion = 2;
        if (sql.includes('PRAGMA user_version = 3')) pendingVersion = 3;
      } });
      version = pendingVersion;
    },
  };
  await expect(migrateOfflineSchema(db)).rejects.toThrow('disk full');
  expect(version).toBe(1);
  failUpgrade = false;
  await migrateOfflineSchema(db);
  expect(version).toBe(3);
  expect(statements.join('\n')).not.toContain('CREATE TABLE outbox');
});
