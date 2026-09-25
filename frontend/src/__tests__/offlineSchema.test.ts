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
        },
      });
      version = pendingVersion;
    },
  };
  await expect(migrateOfflineSchema(db)).rejects.toThrow('disk full');
  expect(version).toBe(0);
  failCreate = false;
  await migrateOfflineSchema(db);
  expect(version).toBe(1);
});
