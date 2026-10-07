import * as Crypto from 'expo-crypto';
import { api } from './api';
import type { CoverageLine, ReviewedIntent } from './financialReview';
import { readRecovery, writeRecovery, removeRecovery } from './financialRecoveryStorage';
import { publishFinancialScope } from './financialRefresh';

export type SettlementMethod = 'upi' | 'cash' | 'bank' | 'offset';
export type QuoteLeg = { id: string; from_member_id: string; to_member_id: string; amount: string; dependency?: boolean;
  payer?: { person_id: string; name: string }; recipient?: { person_id: string; name: string };
  actual_payer_person_id?: string; actual_receiver_person_id?: string; upi_id_snapshot?: string; inr_amount?: string;
  conversion_snapshot?: { rate?: string; effective_date?: string; expires_at?: string } };
export type SettlementQuote = { id: string; intent_id: string; quote_hash: string; expires_at: string;
  snapshot_id: string; currency: string; mode: string; method: SettlementMethod;
  review_context?: ReviewedIntent['review_context'];
  plan: { plan_hash: string; allocation_lines: CoverageLine[]; required_person_ids: string[] };
  cash_legs: QuoteLeg[] };
export type QuoteRequest = { mode: 'direct' | 'group' | 'offset'; method: SettlementMethod; expected_snapshot_id: string;
  shares?: { share_id: string; amount: string }[];
  cash_legs?: { from_member_id: string; to_member_id: string; amount: string }[];
  parties?: { from_member_id: string; to_member_id: string; payer_person_id: string; recipient_person_id: string }[] };

export function createReviewedQuote(tripId: string, body: QuoteRequest, authToken: string, signal?: AbortSignal) {
  return api<SettlementQuote>(`/trips/${tripId}/settlement-quotes`, { method: 'POST', body, authToken, signal, timeoutMs: 15000 });
}

type PendingMutation = { path: string; body: Record<string, unknown>; identity: string; intentId?: string };
const pending = new Map<string, PendingMutation>();
const flights = new Map<string, Promise<ReviewedIntent>>();
const flightIdentities = new Map<string, string>();
const hydrations = new Map<string, Promise<void>>();
export function hasUnresolvedSubmission(scope: string) { return pending.has(scope); }
export async function hydrateReviewedMutation(scope: string) {
  const existing = hydrations.get(scope);
  if (existing) return existing;
  const hydration = (async () => {
    const raw = await readRecovery(scope);
    if (!raw || pending.has(scope)) return;
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || saved.scope !== scope || typeof saved.request?.path !== 'string'
      || typeof saved.request?.body?.client_mutation_id !== 'string' || typeof saved.request?.identity !== 'string')
      throw new Error('Payment recovery is unreadable. Check pending payments before continuing.');
    pending.set(scope, saved.request);
  })();
  hydrations.set(scope, hydration);
  try { await hydration; } finally { hydrations.delete(scope); }
}
async function clear(scope: string) {
  // Keep a checkpoint if cleanup fails: replay is idempotent and safer than forgetting it.
  await removeRecovery(scope);
  pending.delete(scope);
}
export async function reviewedMutation(scope: string, path: string, body: Record<string, unknown>,
  authToken: string, valid: () => boolean, intentId?: string,
  options: { deferRefresh?: boolean } = {}): Promise<ReviewedIntent> {
  if (!valid()) throw new Error('This financial review is no longer open.');
  const identity = JSON.stringify([path, body]);
  const existing = flights.get(scope);
  if (existing) {
    if (flightIdentities.get(scope) !== identity)
      throw new Error('Check or retry the previous submission before starting another payment.');
    return existing;
  }
  const flight = (async () => {
    await hydrateReviewedMutation(scope);
    if (!valid()) throw new Error('This financial review is no longer open.');
    const prior = pending.get(scope);
    if (prior && prior.identity !== identity) throw new Error('Check or retry the previous submission before starting another payment.');
    const request = prior ?? { path, identity, intentId: intentId ?? path.match(/\/settlement-intents\/([^/]+)/)?.[1],
      body: { ...body, client_mutation_id: Crypto.randomUUID() } };
    pending.set(scope, request);
    await writeRecovery(scope, JSON.stringify({ version: 1, scope, request }));
    if (!valid()) throw new Error('This financial review is no longer open.');
    try {
      const result = await api<ReviewedIntent>(path, { method: 'POST', body: request.body, authToken, timeoutMs: 15000 });
      await clear(scope).catch(() => {});
      if (!options.deferRefresh) publishFinancialScope(scope, 'mutation');
      return result;
    } catch (failure) {
      const error = failure as { code?: string; status?: number };
      // start commits before its fresh handoff read; a 409 from that read is not proof of rollback.
      if (error.code === 'http' && (error.status ?? 500) < 500 && body.action !== 'start') await clear(scope);
      publishFinancialScope(scope, 'uncertain_outcome');
      throw failure;
    }
  })();
  flights.set(scope, flight);
  flightIdentities.set(scope, identity);
  try { return await flight; } finally { flights.delete(scope); flightIdentities.delete(scope); }
}
export async function retryReviewedMutation(scope: string, authToken: string, valid: () => boolean) {
  await hydrateReviewedMutation(scope);
  const request = pending.get(scope);
  if (!request) throw new Error('No unresolved submission remains. Refresh the shares.');
  if (!valid()) throw new Error('This financial review is no longer open.');
  if (request.intentId) {
    const tripId = request.path.match(/^\/trips\/([^/]+)/)?.[1];
    if (tripId) {
      try {
        const current = await api<ReviewedIntent>(`/trips/${tripId}/settlement-intents/${request.intentId}`, { authToken, timeoutMs: 15000 });
        if (!valid()) throw new Error('This financial review is no longer open.');
        if (current.action_history?.some(action => action.request?.client_mutation_id === request.body.client_mutation_id)) {
          await clear(scope); publishFinancialScope(scope, 'recovered'); return current;
        }
      } catch (failure) { if ((failure as { status?: number }).status !== 404) throw failure; }
    }
  }
  const { client_mutation_id: _mutation, ...body } = request.body;
  try {
    return await reviewedMutation(scope, request.path, body, authToken, valid, request.intentId);
  } catch (failure) {
    // A failed start may be a post-commit handoff read. Reconcile its own attributed action
    // after the response, rather than trapping a changed recipient in an endless retry loop.
    const status = (failure as { status?: number }).status;
    const tripId = request.path.match(/^\/trips\/([^/]+)/)?.[1];
    if (body.action === 'start' && request.intentId && tripId && status && status < 500 && valid()) {
      const current = await api<ReviewedIntent>(`/trips/${tripId}/settlement-intents/${request.intentId}`, { authToken, timeoutMs: 15000 });
      if (valid() && Array.isArray(current.action_history)) {
        await clear(scope); publishFinancialScope(scope, 'recovered');
        if (current.action_history.some(action => action.request?.client_mutation_id === request.body.client_mutation_id)) return current;
      }
    }
    throw failure;
  }
}
