export const OFFLINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type RetentionTransaction = {
  runAsync(sql: string, ...params: (string | number)[]): Promise<unknown>;
};

export async function pruneOfflineData(
  tx: RetentionTransaction, accountId: string, now: number,
): Promise<void> {
  if (!Number.isFinite(now) || now < OFFLINE_RETENTION_MS) {
    throw new Error('Invalid retention time');
  }
  const cutoff = now - OFFLINE_RETENTION_MS;
  await tx.runAsync(
    `DELETE FROM outbox WHERE account_id = ? AND state = 'synced'
       AND synced_at IS NOT NULL AND synced_at < ?`, accountId, cutoff,
  );
  // Expire a complete confirmed bundle only when that trip has no unresolved action.
  await tx.runAsync(
    `DELETE FROM read_snapshots WHERE account_id = ? AND trip_id IN (
      SELECT trip_id FROM trip_snapshots WHERE account_id = ? AND fetched_at < ?
        AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.account_id = trip_snapshots.account_id
          AND outbox.trip_id = trip_snapshots.trip_id AND outbox.state != 'synced')
    )`, accountId, accountId, cutoff,
  );
  await tx.runAsync(
    `DELETE FROM trip_snapshots WHERE account_id = ? AND fetched_at < ?
      AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.account_id = trip_snapshots.account_id
        AND outbox.trip_id = trip_snapshots.trip_id AND outbox.state != 'synced')`,
    accountId, cutoff,
  );
  await tx.runAsync(
    'DELETE FROM account_read_snapshots WHERE account_id = ? AND fetched_at < ?',
    accountId, cutoff,
  );
  await tx.runAsync(
    `DELETE FROM sync_meta WHERE account_id = ?
      AND NOT EXISTS (SELECT 1 FROM trip_snapshots WHERE trip_snapshots.account_id = sync_meta.account_id
        AND trip_snapshots.trip_id = sync_meta.trip_id)
      AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.account_id = sync_meta.account_id
        AND outbox.trip_id = sync_meta.trip_id AND outbox.state != 'synced')`, accountId,
  );
}
