import { Platform } from 'react-native';
import { ApiError, api } from './api';
import { offlineStore } from './offlineStore';
import type { Snapshot, TripReadBundle } from './offlineStore.shared';
import { resolveUserTripBalance, type TripBalancePayload } from './tripBalance';

export type ReadResult<T> = {
  data: T | null;
  source: 'live' | 'cache' | 'unavailable';
  fetchedAt: number | null;
  error?: string;
  cacheError?: boolean;
  authoritativeError?: boolean;
};

export type DashboardOverview<TTrip> = {
  trips: TTrip[];
  balances: Record<string, { currency: string; balance: number }> | null;
};

export type CompleteTrip<TTrip, TExpense, TBalances, TSpend, TPayment> = {
  trip: TTrip;
  expenses: TExpense[];
  balances: TBalances;
  spend: TSpend;
  payments: TPayment[];
};

const cacheAvailable = () => Platform.OS === 'android';
const request = <T,>(path: string) => api<T>(path, { timeoutMs: 10_000 });

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) throw new Error('Invalid server read response');
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

const tripFields = [
  'id', 'name', 'code', 'start_date', 'end_date', 'travel_date', 'budget', 'currency',
  'last_activity_at', 'owner_id', 'admin_ids', 'user_ids',
] as const;
const memberFields = [
  'id', 'name', 'kind', 'family_members', 'family_member_ids',
  'family_member_user_ids', 'user_id',
] as const;
const expenseFields = [
  'id', 'amount', 'currency', 'original_amount', 'original_currency', 'category',
  'description', 'date', 'time', 'created_at', 'paid_by_member_id', 'split_member_ids',
  'created_by', 'has_receipt', 'receipt_id', 'shares', 'split_mode',
] as const;
const paymentFields = [
  'id', 'from_member_id', 'to_member_id', 'amount', 'currency', 'created_at',
  'recorded_by', 'note', 'settlement_policy_version', 'settlement_increment', 'source',
] as const;

function sanitizeTrip(value: unknown): Record<string, unknown> {
  const trip = pick(value, tripFields);
  if (typeof trip.id !== 'string' || typeof trip.name !== 'string'
    || typeof trip.currency !== 'string' || !Array.isArray((value as Record<string, unknown>).members)) {
    throw new Error('Invalid trip response');
  }
  trip.members = ((value as Record<string, unknown>).members as unknown[])
    .map((member) => pick(member, memberFields));
  return trip;
}

function sanitizeArray(value: unknown, fields: readonly string[]): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Invalid list response');
  return value.map((row) => pick(row, fields));
}

function sanitizeBalances(value: unknown): Record<string, unknown> {
  const balance = pick(value, ['net', 'transfers', 'currency', 'per_person', 'settlement_projection']);
  if (!isObject(value) || !Array.isArray(value.members) || !isObject(balance.net)
    || !Array.isArray(balance.transfers)) throw new Error('Invalid balances response');
  balance.members = value.members.map((member) => pick(member, memberFields));
  return balance;
}

function sanitizeSpend(value: unknown): Record<string, unknown> {
  const spend = pick(value, ['total', 'count', 'currency']);
  if (!isObject(value) || !Array.isArray(value.entities)) throw new Error('Invalid spend response');
  spend.entities = sanitizeArray(value.entities, [
    'entity_id', 'entity_type', 'name', 'paid', 'expense_count',
  ]);
  return spend;
}

function transient(error: unknown): boolean {
  if (!isApiError(error)) return true;
  return error.code === 'network' || error.code === 'timeout'
    || (error.code === 'http' && (error.status === 429 || (error.status ?? 0) >= 500));
}

function authoritativeError(error: unknown): boolean {
  return isApiError(error) && error.code === 'http'
    && (error.status === 401 || error.status === 403 || error.status === 404);
}

function failureMessage(error: unknown): string {
  if (isApiError(error) && error.status === 403) return 'Access to this trip is unavailable.';
  if (isApiError(error) && error.status === 404) return 'This trip is no longer available.';
  if (isApiError(error) && error.status === 401) return 'Sign in again to open this trip.';
  return 'No saved copy is available. Open this view while connected, then try again.';
}

function isApiError(error: unknown): error is ApiError {
  return isObject(error) && typeof error.code === 'string';
}

async function cached<T>(
  read: () => Promise<Snapshot | null>,
  error: unknown,
): Promise<ReadResult<T>> {
  if (!cacheAvailable() || !transient(error)) {
    return { data: null, source: 'unavailable', fetchedAt: null,
      error: failureMessage(error), authoritativeError: authoritativeError(error) };
  }
  try {
    const snapshot = await read();
    if (snapshot) return { data: snapshot.payload as T, source: 'cache', fetchedAt: snapshot.fetchedAt };
  } catch {
    return { data: null, source: 'unavailable', fetchedAt: null,
      error: 'Saved data could not be read on this device.', cacheError: true };
  }
  return { data: null, source: 'unavailable', fetchedAt: null, error: failureMessage(error) };
}

async function save(read: () => Promise<void>): Promise<boolean> {
  if (!cacheAvailable()) return true;
  try { await read(); return true; } catch { return false; }
}

export async function loadTripList<TTrip>(
  accountId: string, preferCache = false,
): Promise<ReadResult<TTrip[]>> {
  if (preferCache && cacheAvailable()) {
    return cached<TTrip[]>(
      () => offlineStore.getAccountReadSnapshot(accountId, 'trip_list'), { code: 'network' });
  }
  try {
    const response = await request<unknown>('/trips');
    if (!Array.isArray(response)) throw new Error('Invalid trip list response');
    const trips = response as TTrip[];
    const safeTrips = cacheAvailable() ? response.map(sanitizeTrip) : trips;
    const fetchedAt = Date.now();
    const saved = await save(async () => {
      const prior = await offlineStore.getAccountReadSnapshot(accountId, 'trip_list');
      if (prior && Array.isArray(prior.payload)) {
        const currentIds = new Set(safeTrips.map((item) => (item as { id: string }).id));
        for (const old of prior.payload) {
          if (isObject(old) && typeof old.id === 'string' && !currentIds.has(old.id)) {
            await forgetTrip(accountId, old.id);
          }
        }
      }
      await offlineStore.putAccountReadSnapshot(accountId, 'trip_list', {
        payload: safeTrips, fetchedAt,
      });
    });
    return { data: trips, source: 'live', fetchedAt, cacheError: !saved };
  } catch (error) {
    return cached<TTrip[]>(
      () => offlineStore.getAccountReadSnapshot(accountId, 'trip_list'), error);
  }
}

export async function loadDashboardOverview<TTrip>(
  accountId: string,
  preferCache = false,
): Promise<ReadResult<DashboardOverview<TTrip>>> {
  let list: ReadResult<TTrip[]>;
  try {
    list = await loadTripList<TTrip>(accountId, preferCache);
  } catch (error) {
    return cached(
      () => offlineStore.getAccountReadSnapshot(accountId, 'dashboard_overview'), error);
  }
  if (list.source !== 'live' || !list.data) {
    if (list.authoritativeError) {
      return { data: null, source: 'unavailable', fetchedAt: null,
        error: list.error, authoritativeError: true };
    }
    const previous = await cached<DashboardOverview<TTrip>>(
      () => offlineStore.getAccountReadSnapshot(accountId, 'dashboard_overview'),
      { code: 'network' });
    if (previous.data) return previous;
    return { data: list.data ? { trips: list.data, balances: null } : null,
      source: list.source, fetchedAt: list.fetchedAt, error: list.error,
      cacheError: list.cacheError };
  }
  const trips = list.data;
  const results = await Promise.allSettled(trips.map((trip) => {
    const id = (trip as { id: string }).id;
    return request<TripBalancePayload>(`/trips/${id}/balances`);
  }));
  const balances: DashboardOverview<TTrip>['balances'] = {};
  const failures: unknown[] = [];
  const inaccessibleTripIds: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(result.reason);
      if (isApiError(result.reason) && (result.reason.status === 403 || result.reason.status === 404)) {
        inaccessibleTripIds.push((trips[index] as { id: string }).id);
      }
      return;
    }
    try {
      const balance = resolveUserTripBalance(result.value, accountId);
      if (balance === null) throw new Error('Personal balance unavailable');
      balances[(trips[index] as { id: string }).id] = {
        currency: result.value.currency || (trips[index] as { currency: string }).currency,
        balance,
      };
    } catch (error) { failures.push(error); }
  });
  if (failures.length) {
    for (const tripId of inaccessibleTripIds) await forgetTrip(accountId, tripId);
    const failed = failures.find(authoritativeError) ?? failures[0];
    if (authoritativeError(failed)) {
      if (isApiError(failed) && failed.status === 401) {
        return { data: null, source: 'unavailable', fetchedAt: null,
          error: failureMessage(failed), authoritativeError: true };
      }
      const visibleTrips = trips.filter((trip) =>
        !inaccessibleTripIds.includes((trip as { id: string }).id));
      return { data: { trips: visibleTrips, balances: null }, source: 'live',
        fetchedAt: list.fetchedAt, error: failureMessage(failed), cacheError: list.cacheError };
    }
    const previous = await cached<DashboardOverview<TTrip>>(
      () => offlineStore.getAccountReadSnapshot(accountId, 'dashboard_overview'), failed);
    if (previous.data) return previous;
    return { data: { trips, balances: null }, source: 'live', fetchedAt: list.fetchedAt,
      error: 'Balance unavailable until a complete refresh succeeds.', cacheError: list.cacheError };
  }
  const fetchedAt = Date.now();
  const overview = { trips, balances };
  const saved = await save(() => offlineStore.putAccountReadSnapshot(accountId,
    'dashboard_overview', { payload: { trips: cacheAvailable() ? trips.map(sanitizeTrip) : trips,
      balances }, fetchedAt }));
  return { data: overview, source: 'live', fetchedAt, cacheError: list.cacheError || !saved };
}

async function forgetTrip(accountId: string, tripId: string): Promise<void> {
  if (!cacheAvailable()) return;
  try {
    await offlineStore.removeTripReadData(accountId, tripId);
    for (const kind of ['trip_list', 'dashboard_overview'] as const) {
      const snapshot = await offlineStore.getAccountReadSnapshot(accountId, kind);
      if (!snapshot) continue;
      if (kind === 'trip_list' && Array.isArray(snapshot.payload)) {
        await offlineStore.putAccountReadSnapshot(accountId, kind, {
          ...snapshot,
          payload: snapshot.payload.filter((trip) => isObject(trip) && trip.id !== tripId),
        });
      } else if (kind === 'dashboard_overview' && isObject(snapshot.payload)
        && Array.isArray(snapshot.payload.trips)) {
        const balances = isObject(snapshot.payload.balances)
          ? { ...snapshot.payload.balances } : null;
        if (balances) delete balances[tripId];
        await offlineStore.putAccountReadSnapshot(accountId, kind, {
          ...snapshot,
          payload: { trips: snapshot.payload.trips.filter((trip) => isObject(trip)
            && trip.id !== tripId), balances },
        });
      }
    }
  } catch { /* Keep the confirmed access error authoritative for this screen. */ }
}

export async function loadTripReadBundle<TTrip, TExpense, TBalances, TSpend, TPayment>(
  accountId: string,
  tripId: string,
  preferCache = false,
): Promise<ReadResult<CompleteTrip<TTrip, TExpense, TBalances, TSpend, TPayment>>> {
  if (preferCache && cacheAvailable()) {
    return cached(() => offlineStore.getTripReadBundle(accountId, tripId), { code: 'network' });
  }
  const paths = [
    `/trips/${tripId}`,
    `/trips/${tripId}/expenses`,
    `/trips/${tripId}/balances`,
    `/trips/${tripId}/spend-summary`,
    `/trips/${tripId}/payments`,
  ];
  const results = await Promise.allSettled(paths.map((path) => request<unknown>(path)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  const accessFailure = failures.find((error) => isApiError(error) && error.status === 401)
    ?? failures.find((error) => authoritativeError(error));
  if (accessFailure) {
    if (isApiError(accessFailure) && (accessFailure.status === 403 || accessFailure.status === 404)) {
      await forgetTrip(accountId, tripId);
    }
    return { data: null, source: 'unavailable', fetchedAt: null,
      error: failureMessage(accessFailure), authoritativeError: true };
  }
  if (failures.length) {
    return cached(() => offlineStore.getTripReadBundle(accountId, tripId), failures[0]);
  }
  try {
    const values = results.map((result) => (result as PromiseFulfilledResult<unknown>).value);
    const rawBundle: TripReadBundle = {
      trip: values[0], expenses: values[1], balances: values[2],
      spend: values[3], payments: values[4],
    };
    const fetchedAt = Date.now();
    const saved = await save(() => offlineStore.putTripReadBundle(accountId, tripId, {
      payload: {
        trip: sanitizeTrip(values[0]),
        expenses: sanitizeArray(values[1], expenseFields),
        balances: sanitizeBalances(values[2]),
        spend: sanitizeSpend(values[3]),
        payments: sanitizeArray(values[4], paymentFields),
      } satisfies TripReadBundle,
      fetchedAt,
    }));
    return { data: rawBundle as CompleteTrip<TTrip, TExpense, TBalances, TSpend, TPayment>,
      source: 'live', fetchedAt, cacheError: !saved };
  } catch (error) {
    return cached(() => offlineStore.getTripReadBundle(accountId, tripId), error);
  }
}
