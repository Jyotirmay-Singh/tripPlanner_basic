import { confirmedCoverage, eligibleFamilyShares, footerProgress, participantState, savedCoverage, settlementMoney,
  sumAmounts, units, validCoverage } from '../expenseSettlement';
import { coverageFixture, coveragePerson, intentFixture, settlementTrip } from './expenseSettlement.fixtures';

test('whole text amounts stay exact and unknown/fractional evidence is never rounded to zero', () => {
  expect(sumAmounts(['9007199254740993', '7'])).toBe('9007199254741000');
  expect(settlementMoney('9007199254740993', 'INR')).toBe('₹9,007,199,254,740,993');
  expect(settlementMoney(null, 'INR')).toBe('Unavailable');
  expect(settlementMoney('1.5', 'INR')).toBe('Unavailable');
  expect(units(null)).toBeNull(); expect(sumAmounts(['100', null])).toBeNull();
  expect(settlementMoney('-100', 'INR')).toBe('-₹100');
});
test('counts use only the authoritative summary, including participant exclusions and zero shares', () => {
  expect(footerProgress({ expense_id: 'dinner', revision_id: 'r', remaining_amount: '200', review_required: false, settled_count: 1, participant_count: 3 })).toBe('1/3 shares settled');
  expect(footerProgress({ expense_id: 'dinner', revision_id: 'r', remaining_amount: null, review_required: true, settled_count: null, participant_count: 3 })).toBe('Settlement needs review');
  expect(footerProgress(undefined)).toBe('Settlement progress unavailable');
  expect(participantState(coveragePerson('zero', 'family', { original_share: '0', remaining_amount: '0', actionable_amount: '0' }), [])).toBe('Settled');
});
test('pending payment does not create coverage; partial and awaiting are separate', () => {
  const row = coveragePerson();
  expect(confirmedCoverage(row)).toBe('0');
  expect(participantState(row, [intentFixture()])).toBe('Awaiting approval');
  expect(participantState({ ...row, remaining_amount: '60', coverage: { direct: '40' } }, [])).toBe('Partial');
  expect(participantState({ ...row, remaining_amount: '0', coverage: { group: '20', approved_offset: '80' } }, [])).toBe('Settled');
});
test('zero-money proposals do not block or relabel direct unpaid shares', () => {
  expect(participantState(coveragePerson(), [intentFixture({ mode: 'offset', status: 'needs_review', cash_legs: [] })])).toBe('Unpaid');
});
test('disputed receipt evidence needs review until explicit unsent resolution releases the claim', () => {
  const rejectedLeg = { ...intentFixture().cash_legs[0], receipt_status: 'rejected' };
  expect(participantState(coveragePerson(), [intentFixture({ status: 'needs_review', cash_legs: [rejectedLeg] })]))
    .toBe('Needs review');
  expect(participantState(coveragePerson(), [intentFixture({ status: 'rejected', allocation_status: 'pending', cash_legs: [rejectedLeg] })]))
    .toBe('Unpaid');
});
test('all eligible family shares are selected, excluding covered, blocked, excluded and other-wallet shares', () => {
  const rows = coverageFixture().details!.dinner.participants;
  expect(eligibleFamilyShares(rows, settlementTrip.members, 'u-you').map(row => row.person_id)).toEqual(['you', 'riya']);
  const filtered = [coveragePerson(), coveragePerson('riya', 'family', { actionable_amount: null, reserved_amount: '100' }),
    coveragePerson('excluded', 'family', { participating: false }), coveragePerson('unknown', 'family', { person_id: null })];
  expect(eligibleFamilyShares(filtered, settlementTrip.members, 'u-you').map(row => row.person_id)).toEqual(['you']);
});
test('refund eligibility follows the reversed debtor wallet, not the participant wallet', () => {
  const refund = coveragePerson('you', 'family', { original_share: '-100', debtor_wallet_id: 'a', creditor_wallet_id: 'family' });
  expect(eligibleFamilyShares([refund], settlementTrip.members, 'u-you')).toEqual([]);
  expect(eligibleFamilyShares([refund], settlementTrip.members, 'u-a')).toEqual([refund]);
});
test('cache allowlist excludes private evidence and action authority, including unexpected nested fields', () => {
  const data = coverageFixture();
  const row = data.details!.dinner.participants[1];
  Object.assign(data, { authToken: 'private-token', quote: { upi_id: 'secret@bank' } });
  Object.assign(row, { transaction_reference: 'private-reference', upi_id: 'secret@bank' });
  row.coverage_explanations = [{ amount: '40', kind: 'direct', cash_legs: [Object.assign({ from_member_id: 'family', to_member_id: 'a', amount: '40' }, { upi_id: 'private-upi' })] }];
  Object.assign(row.coverage!, { private_reference: 'private-reference' });
  const saved = savedCoverage(data)!;
  expect(saved.availability.new_starts_available).toBe(false);
  expect(saved.details!.dinner.participants[1].actionable_amount).toBeNull();
  expect(JSON.stringify(saved)).not.toMatch(/private|secret|authToken|quote/);
  expect(saved.generated_at).toBe(data.generated_at); expect(saved.snapshot_id).toBe('snapshot-1');
});
test('missing old cache metadata and inconsistent projections remain unavailable', () => {
  expect(savedCoverage(coverageFixture({ generated_at: undefined }))).toBeNull();
  expect(validCoverage(coverageFixture({ protocol_version: 9 }))).toBe(false);
  expect(validCoverage(coverageFixture({ freshness: { consistent: false, online_review_required: true } }))).toBe(false);
});

test('unknown participation remains needs-review and never enters eligible family selection', () => {
  const row = coveragePerson('you', 'family', { participating: null });
  expect(participantState(row, [])).toBe('Needs review');
  expect(eligibleFamilyShares([row], settlementTrip.members, 'u-you')).toEqual([]);
});
