import NetInfo from '@react-native-community/netinfo';
import { api } from './api';

export type CorrectionOperation = 'replace_expense' | 'void_expense' | 'replace_cash' | 'void_cash'
  | 'reverse_allocation' | 'reverse_correction' | 'update_member' | 'remove_member'
  | 'reassign_family' | 'reallocate_history' | 'add_member' | 'link_person' | 'grant_admin' | 'revoke_admin' | 'transfer_owner' | 'archive_trip' | 'leave_group';
export type ReviewRequest = { operation: CorrectionOperation; target_id: string; changes: Record<string, unknown>;
  renewal?: { id: string; version: number; plan_hash: string }; reason?: string };
export type ReviewEffects = {
  before_balances?: Record<string, string>; after_balances?: Record<string, string>;
  expense_names?: Record<string, string>;
  shares?: { expense_id?: string; person_name?: string; wallet_id?: string; share_id?: string;
    person_id?: string | null; original_share?: string; remaining_amount?: string; amount?: string }[];
  before_shares?: { share_id: string; expense_id: string; person_id?: string | null; person_name?: string;
    wallet_id: string; original_share: string; remaining_amount: string; reserved_amount: string }[];
  affected_bundles?: { event_id: string; approval_count: number; required_person_ids: string[];
    allocation_lines: { share_id: string; amount: string; kind: string }[]; cash_uses: { source_id: string; amount: string }[] }[];
  cash_sources?: { source_id: string; amount: string; payer_wallet_id: string; receiver_wallet_id: string }[];
  recorded_cash_changes?: { before_amount: string; after_amount: string; payer_wallet_id: string; receiver_wallet_id: string }[];
  affected_reports?: { id: string; status: string }[];
  unapplied_credit?: { source_id: string; amount: string }[]; reversed_event_ids?: string[];
  review_cases?: { code: string }[]; allocated?: string; residual_credit?: string; cash_posted?: string;
};
export type ReviewPreview = { id: string; preview_hash: string; expires_at: string; effects: ReviewEffects;
  requires_admin?: boolean; required_person_ids?: string[] };
export type Correction = { id: string; operation: CorrectionOperation; target_id: string; reason: string;
  status: string; version: number; plan_hash: string; created_by: string; created_at: string;
  required_person_ids: string[]; requires_admin: boolean; effects: ReviewEffects;
  approvals: { actor_user_id: string; person_id?: string; created_at: string; reason?: string }[];
  renewal_request?: ReviewRequest;
  action_history?: { actor_name_snapshot?: string; operation: string; reason: string; created_at: string }[] };
export type CoverageSource = 'wallet_funding' | 'direct' | 'group' | 'approved_offset' | 'historical_inferred';
export type CoverageLine = { bundle_id?: string; amount: string; kind: string; share_id?: string;
  revision_id?: string; source_id?: string; explanation?: string; reversed?: boolean;
  cash_legs?: { id?: string; from_member_id: string; to_member_id: string; amount: string;
    actual_payer_person_id?: string | null; actual_receiver_person_id?: string | null }[] };
export type CoveragePerson = { id: string; expense_id?: string; person_id: string | null; person_name: string | null;
  wallet_id: string; debtor_wallet_id: string; creditor_wallet_id: string; participating: boolean | null;
  original_share: string; known_uncovered_amount: string; remaining_amount: string | null; reserved_amount: string;
  actionable_amount: string | null; coverage_explanations: CoverageLine[];
  funding_wallet_id?: string; funding_person_id?: string | null; review_required?: boolean;
  eligible_remaining_amount?: string | null; coverage?: Partial<Record<CoverageSource, string>> };
export type CoverageSummary = { expense_id: string; revision_id: string; remaining_amount: string | null;
  review_required: boolean; participant_count?: number | null; settled_count?: number | null;
  known_settled_count?: number; evidenced_settled_count?: number; inferred_settled_count?: number;
  viewer_status?: 'not_participating' | 'review_required' | 'covered' | 'pending' | 'unpaid';
  pending?: boolean; pending_work_count?: number; reserved_amount?: string; review_reasons?: string[];
  coverage_quality?: string };
export type Coverage = { snapshot_id: string | null; complete: boolean; currency: string;
  protocol_version?: number; policy_version?: string; history_policy_version?: string; money_policy_version?: string;
  generated_at?: string; ledger_version?: number; freshness?: { consistent: boolean; online_review_required: boolean };
  uncertainty?: { present: boolean; reasons: unknown[] };
  availability: { new_starts_available: boolean; status: string };
  expenses: CoverageSummary[] | null;
  details: Record<string, Partial<CoverageSummary> & { participants: CoveragePerson[] }> | null;
  balances?: Record<string, string> | null;
  pending_reports?: { id: string; kind: string; status: string; share_ids: string[]; attributed?: boolean; review_reason?: string }[] | null;
  unapplied_credit?: { source_id: string; amount: string; payer_wallet_id: string; receiver_wallet_id: string }[] };
export type ReviewedIntent = { id: string; method: string; mode: string; version: number; status: string;
  can_withdraw?: boolean;
  unsent_resolved?: boolean;
  allocation_status: string; coverage_event_id?: string; currency?: string; review_reasons?: string[];
  created_at?: string; expires_at?: string;
  plan: { plan_hash: string; required_person_ids: string[]; allocation_lines?: CoverageLine[] };
  cash_legs: { id: string; from_member_id: string; to_member_id: string; amount: string; receipt_status: string;
    source_id?: string; payment_attempt_id?: string; dependency?: boolean; actual_payer_person_id: string; actual_receiver_person_id: string }[];
  approvals: { person_id?: string; action: string; scope?: string; leg_id?: string; created_at?: string; actor_role?: string }[];
  review_context?: { share_id: string; revision_id?: string; expense_id?: string; expense_description?: string;
    category?: string; date?: string; person_id?: string; person_name?: string; original_share?: string; amount: string; kind: string }[];
  reports?: { id?: string; settlement_leg_id?: string; initiating_payer_user_id?: string; reported_by?: string;
    reporting_actor_snapshot?: { name?: string; role?: string } | null;
    actual_payer_person_id?: string; actual_receiver_person_id?: string; payer_snapshot?: { name?: string };
    recipient_snapshot?: { name?: string }; source_amount?: string; source_currency?: string; amount_paise?: number;
    upi_id_snapshot?: string; conversion_snapshot?: { rate?: string; effective_date?: string; expires_at?: string };
    transaction_reference?: string | null; note?: string | null; awaiting_confirmation_at?: string; handoff_started_at?: string;
    initiated_at?: string; confirmed_at?: string }[];
  action_history?: { actor_user_id?: string; actor_name_snapshot?: string; actor_role?: string; operation?: string; created_at?: string;
    request?: { client_mutation_id?: string; reason?: string; leg_id?: string }; resource_binding?: { leg_id?: string } }[] };

export function guardedTrip(trip: { expense_settlement_activation_version?: number; financial_write_guard_version?: number } | null | undefined) {
  return !!(trip?.expense_settlement_activation_version || trip?.financial_write_guard_version);
}

export async function requireFinancialConnection(sessionMode: string) {
  if (sessionMode !== 'online') throw new Error('Connect and sign in to review this financial action. Your draft is preserved.');
  const network = await NetInfo.fetch();
  if (network.isConnected === false || network.isInternetReachable === false)
    throw new Error('Connect to review this financial action. Your draft is preserved.');
}

export async function coverage(tripId: string, expenseIds: string[] = [], options: { authToken?: string; signal?: AbortSignal; snapshot?: string } = {}) {
  const query = expenseIds.map(id => `detail_expense_id=${encodeURIComponent(id)}`).join('&');
  const params = [query, options.snapshot ? `expected_snapshot_id=${encodeURIComponent(options.snapshot)}` : ''].filter(Boolean).join('&');
  return api<Coverage>(`/trips/${tripId}/expense-settlement${params ? `?${params}` : ''}`, { timeoutMs: 15000, ...options });
}

export async function completeCoverage(tripId: string, options: { authToken?: string; signal?: AbortSignal } = {}) {
  const summary = await coverage(tripId, [], options);
  if (!summary.complete || !summary.snapshot_id) return summary;
  const ids = summary.expenses?.map(row => row.expense_id) ?? [];
  const details: NonNullable<Coverage['details']> = {};
  for (let start = 0; start < ids.length; start += 100) {
    const batch = await coverage(tripId, ids.slice(start, start + 100), { ...options, snapshot: summary.snapshot_id });
    if (!batch.complete || batch.snapshot_id !== summary.snapshot_id) throw new Error('Financial progress changed. Refresh and review again.');
    Object.assign(details, batch.details);
  }
  return { ...summary, details };
}

export function previewCorrection(tripId: string, snapshot: string, request: ReviewRequest, reason: string, options: { authToken?: string; signal?: AbortSignal } = {}) {
  return api<ReviewPreview>(`/trips/${tripId}/correction-previews`, { method: 'POST',
    body: { operation: request.operation, target_id: request.target_id, changes: request.changes, reason, expected_snapshot_id: snapshot }, timeoutMs: 15000, ...options });
}
