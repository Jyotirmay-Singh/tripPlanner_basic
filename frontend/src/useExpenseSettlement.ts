import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { getToken } from './api';
import { coverage, requireFinancialConnection, type Coverage } from './financialReview';
import { savedCoverage, settlementError, validCoverage } from './expenseSettlement';
import { offlineStore } from './offlineStore';
import useFinancialRefresh from './useFinancialRefresh';

const memory = new Map<string, Coverage>();
type State = { scope: string; data: Coverage | null; source: 'live' | 'cache' | 'unavailable'; loading: boolean; message: string };

export default function useExpenseSettlement({ tripId, accountId, sessionMode, active, preferCache, refreshKey, detailOpen = false }: {
  tripId: string; accountId?: string; sessionMode: string; active: boolean; preferCache: boolean; refreshKey?: number | null;
  detailOpen?: boolean;
}) {
  const scope = JSON.stringify([accountId, tripId]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const dataRef = useRef<Coverage | null>(null);
  const dataScope = useRef(scope);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const [state, setState] = useState<State>({ scope, data: null, source: 'unavailable', loading: false, message: '' });

  const refresh = useCallback(async (expenseId?: string): Promise<Coverage | null> => {
    if (!accountId || !tripId || scopeRef.current !== scope) return null;
    const pass = ++generation.current;
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    const valid = () => scopeRef.current === scope && generation.current === pass && !controller.signal.aborted;
    setState(previous => ({ scope, data: previous.scope === scope ? previous.data : null,
      source: previous.scope === scope ? previous.source : 'unavailable', loading: true, message: '' }));
    const cache = async () => {
      const stored = Platform.OS === 'android'
        ? (await offlineStore.getReadSnapshot(accountId, tripId, 'expense_settlement'))?.payload as Coverage | undefined
        : memory.get(scope);
      // Re-sanitize on read as well: older/malformed envelopes never regain sending authority.
      return stored ? savedCoverage(stored) : null;
    };
    try {
      if (preferCache || sessionMode !== 'online') {
        const saved = await cache();
        if (valid()) { dataRef.current = saved; setState({ scope, data: saved, source: saved ? 'cache' : 'unavailable',
          loading: false, message: saved ? '' : 'Settlement progress unavailable. Open these shares while connected.' }); }
        return valid() ? saved : null;
      }
      await requireFinancialConnection(sessionMode);
      const token = await getToken();
      if (!valid()) return null;
      if (!token) throw new Error('Sign in again to review settlement.');
      const prior = dataScope.current === scope ? dataRef.current : null;
      let result: Coverage;
      try {
        result = await coverage(tripId, expenseId ? [expenseId] : [], { authToken: token, signal: controller.signal,
          snapshot: expenseId && validCoverage(prior) ? prior.snapshot_id! : undefined });
      } catch (failure) {
        if (!expenseId || (failure as { detailCode?: string }).detailCode !== 'coverage_snapshot_changed') throw failure;
        const fresh = await coverage(tripId, [], { authToken: token, signal: controller.signal });
        if (!valid()) return null;
        result = validCoverage(fresh) ? await coverage(tripId, [expenseId], {
          authToken: token, signal: controller.signal, snapshot: fresh.snapshot_id! }) : fresh;
      }
      if (!valid()) return null;
      if (validCoverage(result)) {
        result = { ...result, details: { ...(prior?.snapshot_id === result.snapshot_id ? prior.details : {}), ...result.details } };
        const safe = savedCoverage(result)!;
        memory.set(scope, safe);
        if (Platform.OS === 'android') {
          try { await offlineStore.putReadSnapshot(accountId, tripId, 'expense_settlement', { payload: safe, fetchedAt: Date.now() }); }
          catch { if (valid()) setState(previous => ({ ...previous, message: 'Progress is current, but could not be saved on this device.' })); }
        }
      } else {
        memory.delete(scope);
        // Tombstone coverage only; disabled/incomplete responses must not resurrect old progress.
        if (Platform.OS === 'android') await offlineStore.putReadSnapshot(accountId, tripId, 'expense_settlement',
          { payload: null, fetchedAt: Date.now() }).catch(() => {});
        // Missing legacy protocol/freshness metadata cannot substantiate financial values.
        result = { ...result, complete: false, snapshot_id: null, expenses: null, details: null,
          availability: { status: result.availability?.status ?? 'unavailable', new_starts_available: false } };
      }
      if (!valid()) return null;
      dataRef.current = result;
      dataScope.current = scope;
      setState(previous => ({ scope, data: result, source: 'live', loading: false, message: previous.message }));
      return result;
    } catch (failure) {
      if (!valid()) return null;
      const status = (failure as { status?: number }).status;
      const authoritative = [401, 403, 404].includes(status ?? 0);
      if (authoritative) {
        memory.delete(scope);
        if (Platform.OS === 'android') await offlineStore.removeTripReadData(accountId, tripId).catch(() => {});
      }
      const saved = authoritative ? null : await cache().catch(() => null);
      if (!valid()) return null;
      dataRef.current = saved;
      setState({ scope, data: saved, source: saved ? 'cache' : 'unavailable', loading: false, message: settlementError(failure) });
      return saved;
    }
  }, [accountId, tripId, scope, preferCache, sessionMode]);

  const autoRefreshKey = detailOpen ? null : refreshKey;
  useFinancialRefresh(accountId, tripId, () => refresh(), active && !detailOpen);
  useEffect(() => {
    if (active && !detailOpen) void refresh();
    return () => { generation.current += 1; abort.current?.abort(); };
  }, [scope, active, refresh, autoRefreshKey, detailOpen]);
  const current = state.scope === scope ? state : { data: null, source: 'unavailable' as const, loading: active, message: '' };
  return { ...current, source: preferCache && current.data ? 'cache' as const : current.source, refresh };
}
