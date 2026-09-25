import { ApiError, api, getToken } from './api';
import { offlineWritesActive } from './offlineActivation';
import { loadTripReadBundle } from './offlineReads';
import { offlineStore } from './offlineStore';
import type { OfflineStore, StoredOutboxItem, OutboxState } from './offlineStore.shared';
import { sessionClaims } from './sessionClaims';

type TripResponse = {
  expenses: { id: string }[];
  payments: { id: string }[];
};
type RefreshedTrip = {
  data: TripResponse | null;
  source: 'live' | 'cache' | 'unavailable';
  fetchedAt: number | null;
  cacheError?: boolean;
};
type Request = typeof api;
type Dependencies = {
  store: OfflineStore;
  request: Request;
  token: () => Promise<string | null>;
  refresh: (accountId: string, tripId: string) => Promise<RefreshedTrip>;
  enabled: () => boolean;
  now: () => number;
  random: () => number;
};
type SyncEvent = { accountId: string; tripId: string | null; mutationId: string | null };

const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 5 * 60_000;
const RETRY_AFTER_CAP_MS = 60 * 60_000;
const CAPABILITY_RETRY_MS = 60_000;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEPS: Dependencies = {
  store: offlineStore,
  request: api,
  token: getToken,
  refresh: (accountId, tripId) => loadTripReadBundle(accountId, tripId),
  enabled: offlineWritesActive,
  now: Date.now,
  random: Math.random,
};

function backoff(attempt: number, random: number, retryAfterMs?: number): number {
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** Math.min(12, Math.max(0, attempt - 1))));
  const jittered = Math.round(exponential * (0.8 + 0.4 * random));
  return Math.max(jittered, Math.min(RETRY_AFTER_CAP_MS, retryAfterMs ?? 0));
}

function safeCode(error: ApiError): string {
  if (error.status === 403) return 'permission_lost';
  if (error.status === 404) return 'trip_unavailable';
  if (error.status === 400 || error.status === 422) return 'invalid_write';
  if (error.status === 409) {
    const known = new Set([
      'expense_roster_changed', 'payment_recommendation_changed', 'client_mutation_conflict',
      'eligibility_changed', 'multi_currency_disabled',
    ]);
    return error.detailCode && known.has(error.detailCode) ? error.detailCode : 'business_conflict';
  }
  return 'invalid_write';
}

function reviewContext(value: unknown): unknown | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as Record<string, unknown>;
  return {
    warning: typeof response.warning === 'string' ? response.warning.slice(0, 240) : null,
    budget_overage: typeof response.budget_overage === 'number' ? response.budget_overage : null,
    currency: typeof response.currency === 'string' ? response.currency.slice(0, 8) : null,
  };
}

function validPayload(item: StoredOutboxItem): item is StoredOutboxItem & { payload: Record<string, unknown> } {
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) return false;
  const payload = item.payload as Record<string, unknown>;
  if (payload.client_mutation_id !== item.clientMutationId) return false;
  if (item.operation === 'expense_create') {
    return Array.isArray(payload.split_member_ids) && payload.split_member_ids.length > 0
      && !!payload.expected_roster;
  }
  return item.operation === 'manual_payment_create' && typeof payload.from_member_id === 'string'
    && typeof payload.to_member_id === 'string' && payload.expected_payable != null
    && typeof payload.expected_currency === 'string';
}

export class SyncCoordinator {
  private readonly deps: Dependencies;
  private accountId: string | null = null;
  private generation = 0;
  private running: Promise<void> | null = null;
  private rerun = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private onAuthRequired: (() => void) | null = null;
  private authBlocked = false;
  private forced = new Set<string>();
  private lastMaintenanceAt = 0;
  private listeners = new Set<(event: SyncEvent) => void>();

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  subscribe(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async waitForIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private emit(accountId: string, tripId: string | null, mutationId: string | null): void {
    for (const listener of this.listeners) listener({ accountId, tripId, mutationId });
  }

  setAccount(accountId: string | null, onAuthRequired?: () => void): void {
    if (this.accountId !== accountId) {
      this.generation += 1;
      this.controller?.abort();
      this.forced.clear();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.accountId = accountId;
      this.authBlocked = false;
      this.lastMaintenanceAt = 0;
    }
    this.onAuthRequired = onAuthRequired ?? null;
    if (accountId) this.wake(accountId);
  }

  wake(accountId: string, forceMutationId?: string): void {
    if (!this.deps.enabled() || this.accountId !== accountId) return;
    if (forceMutationId) this.forced.add(forceMutationId);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) { this.rerun = true; return; }
    this.running = this.run(accountId, this.generation).finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        if (this.accountId) this.wake(this.accountId);
      }
    });
  }

  async retry(accountId: string, mutationId: string): Promise<boolean> {
    if (this.accountId !== accountId) return false;
    const rows = await this.deps.store.listOutbox(accountId);
    const item = rows.find((row) => row.clientMutationId === mutationId);
    if (!item || item.state === 'synced' || item.state === 'paused_auth'
      || item.lastSafeErrorCode === 'budget_confirmation_required'
      || item.canonicalResourceId) return false;
    const changed = await this.deps.store.updateOutbox(accountId, mutationId,
      ['queued', 'needs_review'], { state: 'queued', nextRetryAt: null, lastSafeErrorCode: null });
    if (changed) {
      this.emit(accountId, item.tripId, mutationId);
      this.wake(accountId, mutationId);
    }
    return changed;
  }

  async approveBudget(accountId: string, mutationId: string): Promise<boolean> {
    if (this.accountId !== accountId) return false;
    const rows = await this.deps.store.listOutbox(accountId);
    const item = rows.find((row) => row.clientMutationId === mutationId);
    if (!item || item.operation !== 'expense_create' || item.state !== 'needs_review'
      || item.lastSafeErrorCode !== 'budget_confirmation_required') return false;
    const changed = await this.deps.store.updateOutbox(accountId, mutationId,
      ['needs_review'], { state: 'queued', budgetApproved: true,
        nextRetryAt: null, lastSafeErrorCode: null });
    if (changed) {
      this.emit(accountId, item.tripId, mutationId);
      this.wake(accountId, mutationId);
    }
    return changed;
  }

  private stillActive(accountId: string, generation: number): boolean {
    return this.accountId === accountId && this.generation === generation;
  }

  private schedule(accountId: string, generation: number, delay: number): void {
    if (!this.stillActive(accountId, generation) || !this.deps.enabled()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.wake(accountId), Math.max(1_000, delay));
  }

  private async update(item: StoredOutboxItem, from: OutboxState[], patch: Parameters<OfflineStore['updateOutbox']>[3]): Promise<boolean> {
    const changed = await this.deps.store.updateOutbox(item.accountId, item.clientMutationId, from, patch);
    if (changed) this.emit(item.accountId, item.tripId, item.clientMutationId);
    return changed;
  }

  private async run(accountId: string, generation: number): Promise<void> {
    try {
      await this.runPass(accountId, generation);
    } catch {
      // A storage failure must leave the durable row untouched for a later run.
      this.schedule(accountId, generation, 30_000);
    }
  }

  private async runPass(accountId: string, generation: number): Promise<void> {
    const token = await this.deps.token();
    const claims = token ? sessionClaims(token) : null;
    if (!this.stillActive(accountId, generation) || !token || !claims
      || claims.userId !== accountId || claims.expiresAt <= this.deps.now()) return;

    const maintenanceAt = this.deps.now();
    if (maintenanceAt - this.lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
      this.lastMaintenanceAt = maintenanceAt;
      try { await this.deps.store.pruneRetainedData(accountId, maintenanceAt); } catch {
        // Maintenance must not block delivery. Retry at the next interval.
      }
      if (!this.stillActive(accountId, generation)) return;
    }

    const rows = await this.deps.store.listOutbox(accountId);
    for (const item of rows.filter((row) => row.state === 'sending')) {
      await this.update(item, ['sending'], { state: 'queued', nextRetryAt: null });
    }
    if (!rows.some((row) => row.state !== 'synced')) return;

    let protocols: { expense_create_protocol_version?: number; payment_create_protocol_version?: number };
    try {
      protocols = await this.deps.request('/meta/config', { auth: false, timeoutMs: 10_000 });
    } catch {
      this.schedule(accountId, generation, CAPABILITY_RETRY_MS);
      return;
    }
    if (!this.stillActive(accountId, generation)) return;

    for (let processed = 0; processed < 100; processed += 1) {
      const current = await this.deps.store.listOutbox(accountId);
      const headByTrip = new Map<string, StoredOutboxItem>();
      for (const item of current) {
        if (item.state !== 'synced' && !headByTrip.has(item.tripId)) headByTrip.set(item.tripId, item);
      }
      const heads = [...headByTrip.values()].sort((a, b) =>
        a.queuedAt - b.queuedAt || a.clientMutationId.localeCompare(b.clientMutationId));
      const now = this.deps.now();
      const next = heads.find((item) => item.state !== 'needs_review'
        && (item.state === 'paused_auth' || item.nextRetryAt === null
          || item.nextRetryAt <= now || this.forced.has(item.clientMutationId)));
      if (!next || !this.stillActive(accountId, generation) || this.authBlocked) {
        const due = heads.filter((item) => item.state === 'queued' || item.state === 'awaiting_reconcile')
          .map((item) => item.nextRetryAt).filter((value): value is number => value !== null);
        if (due.length) this.schedule(accountId, generation, Math.min(...due) - now);
        return;
      }
      this.forced.delete(next.clientMutationId);
      if (next.state === 'paused_auth') {
        await this.update(next, ['paused_auth'], { state: 'queued', nextRetryAt: null,
          lastSafeErrorCode: null });
        continue;
      }
      if (next.state === 'awaiting_reconcile') {
        await this.reconcile(next, generation);
        continue;
      }
      const protocol = next.operation === 'expense_create'
        ? protocols.expense_create_protocol_version : protocols.payment_create_protocol_version;
      if (protocol !== 1) {
        await this.update(next, ['queued'], { nextRetryAt: now + CAPABILITY_RETRY_MS,
          lastSafeErrorCode: `${next.operation}_protocol_unavailable` });
        continue;
      }
      await this.deliver(next, token, generation);
    }
    this.schedule(accountId, generation, 1_000);
  }

  private async deliver(item: StoredOutboxItem, token: string, generation: number): Promise<void> {
    if (!validPayload(item)) {
      await this.update(item, ['queued'], { state: 'needs_review',
        lastSafeErrorCode: 'invalid_local_payload' });
      return;
    }
    const currentToken = await this.deps.token();
    if (!this.stillActive(item.accountId, generation) || currentToken !== token) return;
    if (!await this.update(item, ['queued'], { state: 'sending',
      attemptCount: item.attemptCount + 1, nextRetryAt: null, lastSafeErrorCode: null })) return;
    this.controller = new AbortController();
    try {
      const encodedTrip = encodeURIComponent(item.tripId);
      const force = item.operation === 'expense_create' && item.budgetApproved === true;
      const path = item.operation === 'expense_create'
        ? `/trips/${encodedTrip}/expenses${force ? '?force=true' : ''}`
        : `/trips/${encodedTrip}/payments`;
      const response = await this.deps.request<unknown>(path, {
        method: 'POST', body: item.payload, timeoutMs: 12_000, signal: this.controller.signal,
        authToken: token, suppressUnauthorized: true,
      });
      if (!this.stillActive(item.accountId, generation)) return;
      if (item.operation === 'expense_create' && response && typeof response === 'object'
        && (response as { requires_confirmation?: boolean }).requires_confirmation) {
        await this.update(item, ['sending'], { state: 'needs_review',
          lastSafeErrorCode: 'budget_confirmation_required',
          reviewContext: reviewContext(response), budgetApproved: false, nextRetryAt: null });
        return;
      }
      const resource = item.operation === 'expense_create'
        ? (response as { expense?: { id?: unknown } } | null)?.expense : response as { id?: unknown } | null;
      if (!resource || typeof resource.id !== 'string' || !resource.id) {
        await this.retryLater(item, item.attemptCount + 1, 'invalid_server_response');
        return;
      }
      if (!await this.update(item, ['sending'], { state: 'awaiting_reconcile',
        canonicalResourceId: resource.id, acknowledgedResponse: response,
        nextRetryAt: null, lastSafeErrorCode: null })) return;
      await this.reconcile({ ...item, state: 'awaiting_reconcile', canonicalResourceId: resource.id,
        acknowledgedResponse: response, attemptCount: item.attemptCount + 1 }, generation);
    } catch (error) {
      if (!this.stillActive(item.accountId, generation)) return;
      if (error instanceof ApiError && error.code === 'http') {
        if (error.status === 401) {
          await this.update(item, ['sending'], { state: 'paused_auth',
            lastSafeErrorCode: 'authentication_required', nextRetryAt: null });
          this.authBlocked = true;
          this.onAuthRequired?.();
        } else if (error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500) {
          await this.retryLater(item, item.attemptCount + 1,
            error.status === 429 ? 'rate_limited' : 'server_unavailable', error.retryAfterMs);
        } else {
          await this.update(item, ['sending'], { state: 'needs_review',
            lastSafeErrorCode: safeCode(error), nextRetryAt: null });
        }
      } else if (error instanceof ApiError) {
        await this.retryLater(item, item.attemptCount + 1, 'network_unavailable');
      } else {
        // A local acknowledgement write may have committed before reporting an error.
        // Inspect the durable row on the next run; never overwrite it as a network failure.
        throw error;
      }
    } finally {
      this.controller = null;
    }
  }

  private async retryLater(item: StoredOutboxItem, attempt: number, code: string,
    retryAfterMs?: number): Promise<void> {
    await this.update(item, ['sending', 'awaiting_reconcile'], {
      state: item.canonicalResourceId ? 'awaiting_reconcile' : 'queued',
      attemptCount: attempt, nextRetryAt: this.deps.now() + backoff(attempt,
        this.deps.random(), retryAfterMs), lastSafeErrorCode: code,
    });
  }

  private async reconcile(item: StoredOutboxItem, generation: number): Promise<void> {
    if (!item.canonicalResourceId || !this.stillActive(item.accountId, generation)) return;
    try {
      const result = await this.deps.refresh(item.accountId, item.tripId);
      if (!this.stillActive(item.accountId, generation)) return;
      const list = item.operation === 'expense_create' ? result.data?.expenses : result.data?.payments;
      if (result.source !== 'live' || result.cacheError || !Array.isArray(list)
        || !list.some((row) => row.id === item.canonicalResourceId)) {
        await this.retryLater(item, item.attemptCount + 1, 'reconciliation_pending');
        return;
      }
      await this.deps.store.putSyncMeta(item.accountId, item.tripId, {
        lastSuccessfulRefreshAt: result.fetchedAt ?? this.deps.now(), lastErrorClass: null,
      });
      await this.update(item, ['awaiting_reconcile'], { state: 'synced',
        syncedAt: this.deps.now(), nextRetryAt: null, lastSafeErrorCode: null });
    } catch {
      if (this.stillActive(item.accountId, generation)) {
        await this.retryLater(item, item.attemptCount + 1, 'reconciliation_pending');
      }
    }
  }
}

export const syncCoordinator = new SyncCoordinator();
