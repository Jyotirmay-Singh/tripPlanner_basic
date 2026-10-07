import type { Coverage, CoveragePerson, ReviewedIntent } from '../financialReview';
import type { SettlementTrip } from '../expenseSettlement';

export const settlementTrip: SettlementTrip = { id: 'ui-trip', currency: 'INR', owner_id: 'u-a', admin_ids: [], members: [
  { id: 'a', name: 'A', kind: 'individual', user_id: 'u-a' },
  { id: 'family', name: 'Our family', kind: 'family', family_member_ids: ['you', 'riya'], family_members: ['You', 'Riya'], family_member_user_ids: ['u-you', 'u-riya'] },
  { id: 'sam', name: 'Sam', kind: 'individual', user_id: 'u-sam' },
] };
export function coveragePerson(person = 'you', wallet = 'family', changes: Partial<CoveragePerson> = {}): CoveragePerson {
  return { id: `share-${person}`, person_id: person, person_name: person === 'you' ? 'You' : person === 'riya' ? 'Riya' : person === 'a' ? 'A' : 'Sam',
    wallet_id: wallet, debtor_wallet_id: wallet, creditor_wallet_id: 'a', participating: true, original_share: '100',
    known_uncovered_amount: '100', remaining_amount: '100', reserved_amount: '0', actionable_amount: '100', eligible_remaining_amount: '100',
    funding_wallet_id: 'a', funding_person_id: 'a', review_required: false,
    coverage: { wallet_funding: '0', direct: '0', group: '0', approved_offset: '0', historical_inferred: '0' },
    coverage_explanations: [], ...changes };
}
export function coverageFixture(changes: Partial<Coverage> = {}): Coverage {
  return { protocol_version: 2, snapshot_id: 'snapshot-1', generated_at: '2026-10-07T09:00:00Z', complete: true, currency: 'INR',
    freshness: { consistent: true, online_review_required: true }, availability: { status: 'available', new_starts_available: true },
    expenses: [{ expense_id: 'dinner', revision_id: 'revision-1', participant_count: 4, settled_count: 1, viewer_status: 'unpaid',
      remaining_amount: '300', review_required: false, inferred_settled_count: 0 }],
    details: { dinner: { revision_id: 'revision-1', participants: [coveragePerson('a', 'a', { remaining_amount: '0', known_uncovered_amount: '0', actionable_amount: '0',
      coverage: { wallet_funding: '100' } }), coveragePerson(), coveragePerson('riya'), coveragePerson('sam', 'sam')] } },
    pending_reports: [], ...changes };
}
export function intentFixture(changes: Partial<ReviewedIntent> = {}): ReviewedIntent {
  return { id: 'intent-1', currency: 'INR', method: 'cash', mode: 'direct', version: 1, status: 'awaiting_confirmation', allocation_status: 'pending',
    plan: { plan_hash: 'plan-1', required_person_ids: [], allocation_lines: [{ share_id: 'share-you', amount: '100', kind: 'direct' }] },
    cash_legs: [{ id: 'leg-1', from_member_id: 'family', to_member_id: 'a', amount: '100', receipt_status: 'awaiting_review',
      actual_payer_person_id: 'you', actual_receiver_person_id: 'a' }], approvals: [], ...changes };
}
