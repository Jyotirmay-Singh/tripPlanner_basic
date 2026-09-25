import { ApiError } from '../api';
import { SyncCoordinator } from '../syncWorker';
import type { OfflineStore, StoredOutboxItem } from '../offlineStore.shared';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));

const now = Date.now();
const expenseId = '8f40feef-60ae-458d-bcba-308934ff1111';
const paymentId = '8f40feef-60ae-458d-bcba-308934ff2222';

function token(accountId: string): string {
  return `x.${Buffer.from(JSON.stringify({ sub: accountId,
    exp: Math.ceil((now + 60_000) / 1000) })).toString('base64url')}.x`;
}

function expense(id = expenseId, tripId = 'trip-a', queuedAt = now): StoredOutboxItem {
  return {
    clientMutationId: id, accountId: 'account-a', tripId, operation: 'expense_create',
    payload: { client_mutation_id: id, amount: 12, currency: 'INR',
      split_member_ids: ['member-a'], expected_roster: { currency: 'INR', members: [] } },
    precondition: {}, queuedAt, state: 'queued', attemptCount: 0,
    nextRetryAt: null, lastSafeErrorCode: null, canonicalResourceId: null,
    acknowledgedResponse: null,
  };
}

function payment(id = paymentId, tripId = 'trip-a', queuedAt = now + 1): StoredOutboxItem {
  return {
    ...expense(id, tripId, queuedAt), operation: 'manual_payment_create',
    payload: { client_mutation_id: id, from_member_id: 'member-a',
      to_member_id: 'member-b', amount: 5, expected_payable: 10, expected_currency: 'INR' },
  };
}

function fixture(items: StoredOutboxItem[] = [expense()]) {
  const rows = new Map(items.map((item) => [item.clientMutationId, item]));
  const syncMeta = new Map<string, number>();
  const store = {
    listOutbox: jest.fn(async (accountId: string) => [...rows.values()]
      .filter((item) => item.accountId === accountId)
      .sort((a, b) => a.queuedAt - b.queuedAt || a.clientMutationId.localeCompare(b.clientMutationId))),
    updateOutbox: jest.fn(async (accountId: string, id: string, from: string[], patch: Partial<StoredOutboxItem>) => {
      const item = rows.get(id);
      if (!item || item.accountId !== accountId || !from.includes(item.state)) return false;
      rows.set(id, { ...item, ...patch });
      return true;
    }),
    putSyncMeta: jest.fn(async (accountId: string, tripId: string,
      meta: { lastSuccessfulRefreshAt: number | null }) => {
      syncMeta.set(`${accountId}:${tripId}`, meta.lastSuccessfulRefreshAt ?? 0);
    }),
  } as unknown as jest.Mocked<OfflineStore>;
  const serverExpenses = new Map<string, { id: string; tripId: string }>();
  const serverPayments = new Map<string, { id: string; tripId: string }>();
  let activeToken = token('account-a');
  let config = { expense_create_protocol_version: 1, payment_create_protocol_version: 1 };
  const post = jest.fn(async (path: string, opts: { body?: { client_mutation_id: string } }): Promise<unknown> => {
    const mutationId = opts.body!.client_mutation_id;
    const tripId = path.split('/')[2];
    if (path.includes('/expenses')) {
      if (!serverExpenses.has(mutationId)) serverExpenses.set(mutationId, { id: `server-${mutationId}`, tripId });
      return { expense: serverExpenses.get(mutationId) };
    }
    if (!serverPayments.has(mutationId)) serverPayments.set(mutationId, { id: `server-${mutationId}`, tripId });
    return serverPayments.get(mutationId);
  });
  const request = jest.fn(async (path: string, opts: unknown) =>
    path === '/meta/config' ? config : post(path, opts as Parameters<typeof post>[1]));
  const refresh = jest.fn(async (_accountId: string, tripId: string): Promise<{
    source: 'live' | 'cache' | 'unavailable'; fetchedAt: number;
    data: { expenses: { id: string }[]; payments: { id: string }[] };
  }> => ({
    source: 'live' as const, fetchedAt: now,
    data: {
      expenses: [...serverExpenses.values()].filter((row) => row.tripId === tripId),
      payments: [...serverPayments.values()].filter((row) => row.tripId === tripId),
    },
  }));
  const coordinator = new SyncCoordinator({ store, request: request as unknown as typeof import('../api').api,
    token: async () => activeToken, refresh, enabled: () => true, now: () => now, random: () => 0.5 });
  return { rows, store, serverExpenses, serverPayments, post, request, refresh, coordinator,
    setConfig: (next: typeof config) => { config = next; },
    setToken: (next: string) => { activeToken = next; }, syncMeta };
}

it('replays a committed expense after a lost response and reconciles exactly one canonical expense', async () => {
  const f = fixture();
  let loseResponse = true;
  f.post.mockImplementationOnce(async (path, opts) => {
    const id = opts.body!.client_mutation_id;
    f.serverExpenses.set(id, { id: `server-${id}`, tripId: path.split('/')[2] });
    if (loseResponse) {
      loseResponse = false;
      throw new ApiError('Lost response', { code: 'timeout' });
    }
    return { expense: f.serverExpenses.get(id) };
  });
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.rows.get(expenseId)).toMatchObject({ state: 'queued', attemptCount: 1,
    clientMutationId: expenseId });
  expect(f.serverExpenses.size).toBe(1);
  await f.coordinator.retry('account-a', expenseId);
  await f.coordinator.waitForIdle();
  expect(f.post).toHaveBeenCalledTimes(2);
  expect(f.post.mock.calls[0][1].body!.client_mutation_id)
    .toBe(f.post.mock.calls[1][1].body!.client_mutation_id);
  expect(f.serverExpenses.size).toBe(1);
  expect(f.rows.get(expenseId)).toMatchObject({ state: 'synced',
    canonicalResourceId: `server-${expenseId}` });
  expect(f.syncMeta.get('account-a:trip-a')).toBe(now);
  f.coordinator.setAccount(null);
});

it('recovers a sending row after a crash with its original receipt ID', async () => {
  const interrupted = { ...expense(), state: 'sending' as const, attemptCount: 1 };
  const f = fixture([interrupted]);
  f.serverExpenses.set(expenseId, { id: `server-${expenseId}`, tripId: 'trip-a' });
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.post).toHaveBeenCalledTimes(1);
  expect(f.serverExpenses.size).toBe(1);
  expect(f.rows.get(expenseId)).toMatchObject({ state: 'synced',
    canonicalResourceId: `server-${expenseId}` });
  f.coordinator.setAccount(null);
});

it('does not repost after the acknowledgement was committed but its local write reported failure', async () => {
  const f = fixture();
  const update = f.store.updateOutbox as jest.Mock;
  const original = update.getMockImplementation()!;
  let failAfterCommit = true;
  update.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (failAfterCommit && args[3]?.state === 'awaiting_reconcile') {
      failAfterCommit = false;
      throw new Error('uncertain local commit');
    }
    return result;
  });
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.rows.get(expenseId)?.state).toBe('awaiting_reconcile');
  f.coordinator.wake('account-a');
  await f.coordinator.waitForIdle();
  expect(f.post).toHaveBeenCalledTimes(1);
  expect(f.rows.get(expenseId)?.state).toBe('synced');
  f.coordinator.setAccount(null);
});

it('coalesces reconnects and delivers an expense before its payment while another trip progresses', async () => {
  const other = expense('8f40feef-60ae-458d-bcba-308934ff3333', 'trip-b', now + 2);
  const f = fixture([expense(), payment(), other]);
  let concurrent = 0;
  let maximum = 0;
  const original = f.post.getMockImplementation()!;
  f.post.mockImplementation(async (...args) => {
    concurrent += 1;
    maximum = Math.max(maximum, concurrent);
    try { return await original(...args); } finally { concurrent -= 1; }
  });
  f.coordinator.setAccount('account-a');
  f.coordinator.wake('account-a');
  f.coordinator.wake('account-a');
  await f.coordinator.waitForIdle();
  const paths = f.post.mock.calls.map(([path]) => path);
  expect(paths.indexOf('/trips/trip-a/expenses'))
    .toBeLessThan(paths.indexOf('/trips/trip-a/payments'));
  expect(paths).toContain('/trips/trip-b/expenses');
  expect(maximum).toBe(1);
  expect([...f.rows.values()].every((row) => row.state === 'synced')).toBe(true);
  f.coordinator.setAccount(null);
});

it('keeps the acknowledgement through a failed refresh and retries only reconciliation', async () => {
  const f = fixture();
  f.refresh.mockResolvedValueOnce({ source: 'cache', fetchedAt: now,
    data: { expenses: [], payments: [] } });
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.rows.get(expenseId)).toMatchObject({ state: 'awaiting_reconcile',
    canonicalResourceId: `server-${expenseId}` });
  f.coordinator.wake('account-a', expenseId);
  await f.coordinator.waitForIdle();
  expect(f.post).toHaveBeenCalledTimes(1);
  expect(f.rows.get(expenseId)?.state).toBe('synced');
  f.coordinator.setAccount(null);
});

it.each([
  [503, 0, 'server_unavailable'], [429, 17_000, 'rate_limited'],
])('backs off after HTTP %i without losing the row', async (status, retryAfterMs, code) => {
  const f = fixture();
  f.post.mockRejectedValueOnce(new ApiError('Server unavailable', {
    code: 'http', status, retryAfterMs,
  }));
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.rows.get(expenseId)).toMatchObject({ state: 'queued',
    lastSafeErrorCode: code, attemptCount: 1 });
  expect((f.rows.get(expenseId)?.nextRetryAt ?? 0) - now)
    .toBeGreaterThanOrEqual(status === 429 ? 17_000 : 4_000);
  expect(f.post).toHaveBeenCalledTimes(1);
  f.coordinator.setAccount(null);
});

it('holds a stale manual-payment recommendation for review after an earlier expense', async () => {
  const f = fixture([expense(), payment()]);
  f.post.mockImplementationOnce(async (path, opts) => {
    const id = opts.body!.client_mutation_id;
    f.serverExpenses.set(id, { id: `server-${id}`, tripId: path.split('/')[2] });
    return { expense: f.serverExpenses.get(id) };
  }).mockRejectedValueOnce(new ApiError('Recommendation changed', {
    code: 'http', status: 409, detailCode: 'payment_recommendation_changed',
  }));
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.rows.get(expenseId)?.state).toBe('synced');
  expect(f.rows.get(paymentId)).toMatchObject({ state: 'needs_review',
    lastSafeErrorCode: 'payment_recommendation_changed' });
  expect(f.serverPayments.size).toBe(0);
  f.coordinator.setAccount(null);
});

it('holds a budget warning for explicit online approval and preserves the UUID with force', async () => {
  const f = fixture();
  f.post.mockResolvedValueOnce({ requires_confirmation: true, warning: '12 INR over budget',
    budget_overage: 12, currency: 'INR' });
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.rows.get(expenseId)).toMatchObject({ state: 'needs_review',
    lastSafeErrorCode: 'budget_confirmation_required',
    reviewContext: { warning: '12 INR over budget' } });
  expect(f.serverExpenses.size).toBe(0);
  await f.coordinator.approveBudget('account-a', expenseId);
  await f.coordinator.waitForIdle();
  expect(f.post.mock.calls[1][0]).toBe('/trips/trip-a/expenses?force=true');
  expect(f.post.mock.calls[1][1].body!.client_mutation_id).toBe(expenseId);
  expect(f.rows.get(expenseId)?.state).toBe('synced');
  f.coordinator.setAccount(null);
});

it.each([
  [403, 'permission_lost'], [404, 'trip_unavailable'],
  [409, 'expense_roster_changed'], [422, 'invalid_write'],
])('preserves a %i rejected expense for review as %s', async (status, code) => {
  const f = fixture();
  f.post.mockRejectedValueOnce(new ApiError('Rejected', { code: 'http', status,
    detailCode: status === 409 ? 'expense_roster_changed' : undefined }));
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.rows.get(expenseId)).toMatchObject({ state: 'needs_review',
    lastSafeErrorCode: code, clientMutationId: expenseId });
  expect(f.serverExpenses.size).toBe(0);
  f.coordinator.setAccount(null);
});

it('pauses on 401 and resumes only after the same account signs in again', async () => {
  const f = fixture();
  const authRequired = jest.fn();
  f.post.mockRejectedValueOnce(new ApiError('Unauthorized', { code: 'http', status: 401 }));
  f.coordinator.setAccount('account-a', authRequired);
  await f.coordinator.waitForIdle();
  expect(authRequired).toHaveBeenCalledTimes(1);
  expect(f.rows.get(expenseId)?.state).toBe('paused_auth');
  expect(f.post).toHaveBeenCalledTimes(1);
  f.coordinator.setAccount(null);
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.rows.get(expenseId)?.state).toBe('synced');
  f.coordinator.setAccount(null);
});

it('preserves a queued row on protocol rollback and retries after capability returns', async () => {
  const f = fixture();
  f.setConfig({ expense_create_protocol_version: 0, payment_create_protocol_version: 1 });
  f.coordinator.setAccount('account-a');
  await f.coordinator.waitForIdle();
  expect(f.post).not.toHaveBeenCalled();
  expect(f.rows.get(expenseId)).toMatchObject({ state: 'queued',
    lastSafeErrorCode: 'expense_create_protocol_unavailable' });
  f.setConfig({ expense_create_protocol_version: 1, payment_create_protocol_version: 1 });
  await f.coordinator.retry('account-a', expenseId);
  await f.coordinator.waitForIdle();
  expect(f.rows.get(expenseId)?.state).toBe('synced');
  f.coordinator.setAccount(null);
});

it('never sends one account’s row with another account’s token', async () => {
  const other = { ...expense('8f40feef-60ae-458d-bcba-308934ff4444', 'trip-b'),
    accountId: 'account-b' };
  const f = fixture([expense(), other]);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const original = f.post.getMockImplementation()!;
  f.post.mockImplementationOnce(async (...args) => { await waiting; return original(...args); });
  f.coordinator.setAccount('account-a');
  await Promise.resolve();
  await Promise.resolve();
  f.coordinator.setAccount(null);
  f.setToken(token('account-b'));
  f.coordinator.setAccount('account-b');
  release();
  await f.coordinator.waitForIdle();
  const calls = f.request.mock.calls.filter(([path]) => path !== '/meta/config');
  for (const [path, opts] of calls) {
    const account = path.includes('trip-a') ? 'account-a' : 'account-b';
    expect((opts as { authToken: string }).authToken).toBe(token(account));
  }
  expect(f.rows.get(expenseId)?.state).not.toBe('synced');
  f.coordinator.setAccount(null);
});
