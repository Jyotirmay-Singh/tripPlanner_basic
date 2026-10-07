import { currencyDefinition } from './currencies';
import type { Coverage, CoveragePerson, CoverageSummary, ReviewedIntent } from './financialReview';

export type SettlementWallet = { id: string; name: string; kind: string; user_id?: string | null;
  family_members?: string[]; family_member_ids?: string[] | null; family_member_user_ids?: (string | null)[] | null };
export type SettlementTrip = { id: string; currency: string; owner_id: string; admin_ids: string[];
  members: SettlementWallet[] };
export type SettlementPerson = { id: string; name: string; walletId: string; userId?: string | null };
export type SettlementTransfer = { from_member_id: string; to_member_id: string; amount: number | string };

export function walletPeople(wallet: SettlementWallet | undefined): SettlementPerson[] {
  if (!wallet) return [];
  return wallet.kind === 'family' ? (wallet.family_member_ids ?? []).map((id, index) => ({
    id, name: wallet.family_members?.[index] ?? 'Family member', walletId: wallet.id,
    userId: wallet.family_member_user_ids?.[index],
  })) : [{ id: wallet.id, name: wallet.name, walletId: wallet.id, userId: wallet.user_id }];
}

// Do not round legacy fractional evidence, coerce null to zero, or trust floating-point sums.
export function units(value: unknown): bigint | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
}
export function positive(value: unknown): boolean { return (units(value) ?? 0n) > 0n; }
export function sumAmounts(values: unknown[]): string | null {
  let result = 0n;
  for (const value of values) { const amount = units(value); if (amount === null) return null; result += amount; }
  return result.toString();
}
export function settlementMoney(value: string | null | undefined, currency: string, accessible = false): string {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return 'Unavailable';
  const negative = value.startsWith('-');
  const digits = BigInt(negative ? value.slice(1) : value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const definition = currencyDefinition(currency);
  return accessible ? `${definition.code} ${negative ? '-' : ''}${digits}`
    : `${negative ? '-' : ''}${definition.symbol}${digits}`;
}

export function sourceLabel(kind: string): string {
  return ({ wallet_funding: 'Covered by paying wallet', direct: 'Direct payment', group: 'Group payment',
    approved_offset: 'Approved offset', historical_inferred: 'Inferred from history' } as Record<string, string>)[kind]
    ?? 'Coverage source needs review';
}
export function confirmedCoverage(row: CoveragePerson): string | null {
  return row.coverage ? sumAmounts(Object.values(row.coverage)) : null;
}
export function relevantIntents(rows: ReviewedIntent[], shareIds: string[]): ReviewedIntent[] {
  const ids = new Set(shareIds);
  return rows.filter(row => row.plan.allocation_lines?.some(line => line.share_id && ids.has(line.share_id)));
}
export function uncertainSendingShares(rows: ReviewedIntent[]): Set<string> {
  return new Set(rows.filter(row => row.method === 'upi' && ['expired', 'canceled'].includes(row.status)
    && !row.unsent_resolved).flatMap(row => row.plan.allocation_lines?.flatMap(line => line.share_id ? [line.share_id] : []) ?? []));
}
export function participantState(row: CoveragePerson, intents: ReviewedIntent[]): string {
  const related = relevantIntents(intents, [row.id]);
  if (row.review_required || row.participating == null || units(row.remaining_amount) === null || !row.person_id
    || related.some(intent => intent.mode !== 'offset' && intent.status === 'needs_review')) return 'Needs review';
  if (units(row.remaining_amount) === 0n) return 'Settled';
  if (related.some(intent => intent.mode !== 'offset' && intent.allocation_status !== 'applied'
    && !['rejected', 'canceled', 'expired', 'reversed'].includes(intent.status)
    && intent.cash_legs.some(leg => ['awaiting_review', 'approved', 'disputed', 'rejected'].includes(leg.receipt_status))))
    return 'Awaiting approval';
  return positive(confirmedCoverage(row)) ? 'Partial' : 'Unpaid';
}
export function eligibleFamilyShares(rows: CoveragePerson[], wallets: SettlementWallet[], accountId: string): CoveragePerson[] {
  const mine = new Set(wallets.filter(wallet => walletPeople(wallet).some(person => person.userId === accountId)).map(wallet => wallet.id));
  return rows.filter(row => row.participating === true && row.person_id && !row.review_required
    && mine.has(row.debtor_wallet_id) && positive(row.actionable_amount) && row.remaining_amount !== null);
}
export function footerProgress(summary: CoverageSummary | undefined): string {
  if (!summary) return 'Settlement progress unavailable';
  if (summary.review_required || summary.settled_count == null || summary.participant_count == null
    || !Number.isInteger(summary.settled_count) || !Number.isInteger(summary.participant_count)
    || summary.settled_count < 0 || summary.participant_count < summary.settled_count)
    return 'Settlement needs review';
  return `${summary.settled_count}/${summary.participant_count} shares settled`;
}
export function validCoverage(value: Coverage | null | undefined): value is Coverage & { complete: true; snapshot_id: string } {
  return !!value && [1, 2].includes(value.protocol_version ?? 0) && typeof value.generated_at === 'string'
    && Number.isFinite(Date.parse(value.generated_at)) && value.complete === true && !!value.snapshot_id
    && value.freshness?.consistent === true && Array.isArray(value.expenses) && !!value.details
    && !!value.availability && Object.values(value.details).every(detail => Array.isArray(detail.participants)
      && detail.participants.every(row => typeof row.original_share === 'string' && Array.isArray(row.coverage_explanations)));
}

function pick<T>(value: T, keys: readonly string[]): T {
  return Object.fromEntries(keys.filter(key => key in (value as object))
    .map(key => [key, (value as Record<string, unknown>)[key]])) as T;
}
const SUMMARY_KEYS = ['expense_id', 'revision_id', 'participant_count', 'settled_count', 'known_settled_count',
  'evidenced_settled_count', 'inferred_settled_count', 'viewer_status', 'remaining_amount', 'pending',
  'pending_work_count', 'reserved_amount', 'review_reasons', 'review_required', 'coverage_quality'];

/** Explicit public allowlist. Sending authority, UPI addresses and private reports never enter this cache. */
export function savedCoverage(value: Coverage): Coverage | null {
  if (!validCoverage(value)) return null;
  const details: NonNullable<Coverage['details']> = {};
  for (const [id, detail] of Object.entries(value.details ?? {})) {
    details[id] = { ...pick(detail, SUMMARY_KEYS), participants: detail.participants.map(row => ({
      ...pick(row, ['id', 'person_id', 'person_name', 'wallet_id', 'debtor_wallet_id', 'creditor_wallet_id',
        'participating', 'original_share', 'remaining_amount', 'known_uncovered_amount', 'reserved_amount',
        'funding_wallet_id', 'funding_person_id', 'review_required']),
      actionable_amount: null, eligible_remaining_amount: null,
      coverage: row.coverage ? pick(row.coverage, ['wallet_funding', 'direct', 'group', 'approved_offset', 'historical_inferred']) : undefined,
      coverage_explanations: row.coverage_explanations.map(line => ({
        ...pick(line, ['bundle_id', 'amount', 'kind', 'share_id', 'revision_id', 'source_id', 'explanation', 'reversed']),
        cash_legs: line.cash_legs?.map(leg => pick(leg, ['id', 'from_member_id', 'to_member_id', 'amount',
          'actual_payer_person_id', 'actual_receiver_person_id'])),
      })),
    })) };
  }
  return { ...pick(value, ['protocol_version', 'policy_version', 'history_policy_version', 'money_policy_version',
    'snapshot_id', 'generated_at', 'currency', 'ledger_version', 'complete']),
    freshness: { consistent: true, online_review_required: true },
    availability: { status: value.availability.status, new_starts_available: false },
    expenses: value.expenses!.map(row => pick(row, SUMMARY_KEYS)), details,
    pending_reports: value.pending_reports?.map(row => pick(row, ['id', 'kind', 'status', 'share_ids', 'attributed', 'review_reason'])),
  };
}

export function settlementError(error: unknown): string {
  const code = (error as { detailCode?: string })?.detailCode;
  if (['coverage_snapshot_changed', 'quote_expired', 'recipient_changed', 'person_changed',
    'sending_review_required', 'intent_changed', 'share_already_covered', 'share_reserved'].includes(code ?? ''))
    return 'Settlement changed. Refresh and review the current shares, recipient and amount before continuing.';
  if (['recipient_unavailable', 'recipient_upi_unavailable'].includes(code ?? ''))
    return 'This person cannot receive UPI here. Choose another person in the receiving wallet, or report cash or bank payment already made.';
  if (code === 'insufficient_authority' || code === 'wrong_payer') return 'Your current account cannot perform this action. Refresh to check your access.';
  if (code === 'cash_party_binding_required') return 'Choose the actual paying and receiving people for every payment.';
  if (code === 'conversion_unavailable') return 'UPI conversion is unavailable. Try again, or report cash or bank payment already made.';
  return error instanceof Error ? error.message : 'Settlement is unavailable. Connect and refresh to try again.';
}
