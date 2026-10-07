/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import Renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import Flow, { type SettlementSelection } from '../ReviewedSettlementFlow';
import Panel from '../ReviewedIntentPanel';
import { api } from '../api';
import { completeCoverage, coverage, requireFinancialConnection } from '../financialReview';
import { coverageFixture, intentFixture, settlementTrip } from './expenseSettlement.fixtures';
import type { SettlementQuote } from '../reviewedSettlement';
import type { ReviewedIntent } from '../financialReview';
jest.mock('../api', () => ({ api: jest.fn(), getToken: async () => 'fixture-token' }));
jest.mock('../financialReview', () => ({ coverage: jest.fn(), completeCoverage: jest.fn(), requireFinancialConnection: jest.fn(async () => {}) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-mutation' }));
jest.mock('../upiLauncher', () => ({ discoverUpiApps: async () => ({ apps: [] }), copyUpiId: jest.fn(async () => ({ ok: true })) }));
jest.mock('../T', () => ({ __esModule: true, default: (p: any) => require('react').createElement('T', p, p.children) }));
jest.mock('../ui/Button', () => ({ __esModule: true, default: (p: any) => require('react').createElement('Button', p) }));
jest.mock('../ui/Input', () => ({ __esModule: true, default: (p: any) => require('react').createElement('Input', p) }));
const mockApi = api as jest.Mock;
const host = (tree: ReactTestRenderer, id: string) => tree.root.find(node => typeof node.type === 'string' && node.props.testID === id);
const selection: SettlementSelection = { mode: 'direct', shares: [{ share_id: 'share-you', amount: '100' }], fromWallet: 'family', toWallet: 'a', recipientPerson: 'a' };
const quote: SettlementQuote = { id: 'quote-1', intent_id: 'intent-1', quote_hash: 'quote-hash', expires_at: '2099-01-01T00:00:00Z', snapshot_id: 'snapshot-1', currency: 'INR', mode: 'direct', method: 'upi',
  cash_legs: [{ id: 'selected', from_member_id: 'family', to_member_id: 'a', amount: '100', actual_payer_person_id: 'you', actual_receiver_person_id: 'a', inr_amount: '100', upi_id_snapshot: 'fixture@bank' }],
  plan: { plan_hash: 'plan-1', required_person_ids: [], allocation_lines: [{ share_id: 'share-you', amount: '100', kind: 'direct' }] } };
let serial = 0;
const base = () => ({ trip: settlementTrip, accountId: 'u-you', sessionMode: 'online', scope: `review-test-${++serial}`, live: true, isAdmin: false,
  expenseNames: { dinner: 'Dinner' }, onComplete: jest.fn(), onAdminReview: jest.fn() });
async function mountFlow(extra: Partial<React.ComponentProps<typeof Flow>> = {}) {
  const props = { ...base(), selection, snapshotId: 'snapshot-1', shareDescriptions: { 'share-you': 'Dinner · You' }, onBack: jest.fn(), ...extra };
  let tree!: ReactTestRenderer;
  await act(async () => { tree = Renderer.create(<Flow {...props} />); });
  return { tree, props };
}
async function mountPanel(row = intentFixture(), extra: Partial<React.ComponentProps<typeof Panel>> = {}) {
  const props = { ...base(), row, ...extra }; let tree!: ReactTestRenderer;
  await act(async () => { tree = Renderer.create(<Panel {...props} />); });
  return { tree, props };
}
beforeEach(() => { jest.clearAllMocks(); (coverage as jest.Mock).mockResolvedValue(coverageFixture());
  (completeCoverage as jest.Mock).mockResolvedValue(coverageFixture()); mockApi.mockImplementation(async (path: string) => path.endsWith('settlement-quotes') ? quote : intentFixture()); });

test('direct quote uses gross shares regardless of smaller group route; cash is explicitly reported after review', async () => {
  const { tree } = await mountFlow();
  await act(async () => host(tree, 'settlement-method-cash').props.onPress());
  await act(async () => host(tree, 'settlement-preview').props.onPress());
  expect(mockApi.mock.calls[0][1].body).toMatchObject({ mode: 'direct', method: 'cash', shares: selection.mode === 'direct' ? selection.shares : [],
    parties: [{ payer_person_id: 'you', recipient_person_id: 'a' }] });
  expect(mockApi.mock.calls.some(call => call[0].endsWith('/balances'))).toBe(false);
  expect(JSON.stringify(tree.toJSON())).toContain('Dinner · You');
  await act(async () => host(tree, 'settlement-submit').props.onPress());
  expect(mockApi.mock.calls[1][1].body).toMatchObject({ submission_action: 'report_paid', client_mutation_id: 'fixture-mutation' });
  await act(async () => tree.unmount());
});

test('a receiving family requires explicit person selection; changing recipient invalidates the quote', async () => {
  const { tree } = await mountFlow({ accountId: 'u-a', selection: { mode: 'direct', shares: [{ share_id: 'share-you', amount: '100' }], fromWallet: 'a', toWallet: 'family' } });
  expect(host(tree, 'settlement-preview').props.disabled).toBe(true);
  await act(async () => host(tree, 'settlement-recipient-selected-you').props.onPress());
  await act(async () => host(tree, 'settlement-preview').props.onPress());
  expect(host(tree, 'settlement-submit')).toBeDefined();
  await act(async () => host(tree, 'settlement-recipient-selected-riya').props.onPress());
  expect(tree.root.findAll(node => node.props.testID === 'settlement-submit')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('UPI payer remains the linked person even for an admin, and expired quotes cannot submit', async () => {
  mockApi.mockResolvedValueOnce({ ...quote, expires_at: '2000-01-01T00:00:00Z' });
  const { tree } = await mountFlow({ isAdmin: true });
  expect(host(tree, 'settlement-payer-selected-riya').props.disabled).toBe(true);
  await act(async () => host(tree, 'settlement-preview').props.onPress());
  expect(host(tree, 'settlement-submit').props.disabled).toBe(true);
  await act(async () => tree.unmount());
});

test('changed snapshot stops review; offline or account switch stops a deferred request before quoting', async () => {
  (coverage as jest.Mock).mockResolvedValueOnce(coverageFixture({ snapshot_id: 'changed' }));
  const first = await mountFlow();
  await act(async () => host(first.tree, 'settlement-preview').props.onPress());
  expect(first.props.onComplete).toHaveBeenCalled(); expect(mockApi).not.toHaveBeenCalled();
  await act(async () => first.tree.unmount());
  let resolve!: (value: unknown) => void;
  (coverage as jest.Mock).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { tree, props } = await mountFlow();
  await act(async () => host(tree, 'settlement-preview').props.onPress());
  await act(async () => tree.update(<Flow {...props} live={false} sessionMode="offline" />));
  await act(async () => resolve(coverageFixture()));
  expect(mockApi).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

test('group review discloses dependent payments and offsets with affected participant names', async () => {
  mockApi.mockRejectedValueOnce({ detailCode: 'cash_party_binding_required', data: { detail: { cash_legs: [
    { id: 'first', from_member_id: 'family', to_member_id: 'a', amount: '20' },
    { id: 'dependent', from_member_id: 'sam', to_member_id: 'family', amount: '80', dependency: true },
  ] } } });
  const { tree } = await mountFlow({ selection: { mode: 'group', transfer: { from_member_id: 'family', to_member_id: 'a', amount: '20' } } });
  await act(async () => host(tree, 'settlement-preview').props.onPress());
  expect(JSON.stringify(tree.toJSON())).toContain('Dependent payment');
  await act(async () => host(tree, 'settlement-recipient-dependent-you').props.onPress());
  mockApi.mockResolvedValueOnce({ ...quote, plan: { ...quote.plan, required_person_ids: ['you', 'riya'], allocation_lines: [{ share_id: 'share-riya', amount: '80', kind: 'approved_offset' }] } });
  await act(async () => host(tree, 'settlement-preview').props.onPress());
  const text = JSON.stringify(tree.toJSON()); expect(text).toContain('Dinner · Riya'); expect(text).toContain('Proposed offset (not approved)');
  expect(completeCoverage).toHaveBeenCalled();
  await act(async () => tree.unmount());
});

test('receiver reviews exact affected people before confirming; refreshed version prevents stale approval', async () => {
  const { tree, props } = await mountPanel(intentFixture(), { accountId: 'u-a', isAdmin: true });
  await act(async () => host(tree, 'settlement-confirm-leg-1').props.onPress());
  expect(JSON.stringify(tree.toJSON())).toContain('Dinner · You');
  expect(mockApi.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
  mockApi.mockResolvedValueOnce(intentFixture({ version: 2 }));
  await act(async () => host(tree, 'settlement-action-submit-intent-1').props.onPress());
  expect(props.onComplete).toHaveBeenCalled(); expect(mockApi.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
  await act(async () => tree.unmount());
});

test('ordinary payer cannot confirm own receipt; family consent is person-specific; admin override needs reason', async () => {
  const row: ReviewedIntent = intentFixture({ mode: 'offset', cash_legs: [], plan: { plan_hash: 'plan-1', required_person_ids: ['you', 'riya'], allocation_lines: [{ share_id: 'share-you', amount: '80', kind: 'approved_offset' }] } });
  const payer = await mountPanel();
  expect(payer.tree.root.findAll(node => node.props.testID === 'settlement-confirm-leg-1')).toHaveLength(0);
  await act(async () => payer.tree.unmount());
  mockApi.mockResolvedValue(row);
  const { tree } = await mountPanel(row);
  expect(tree.root.findAll(node => node.props.testID === 'settlement-consent-riya')).toHaveLength(0);
  await act(async () => host(tree, 'settlement-consent-you').props.onPress());
  await act(async () => host(tree, 'settlement-action-submit-intent-1').props.onPress());
  expect(mockApi.mock.calls.at(-1)?.[1].body).toMatchObject({ action: 'consent', person_id: 'you', expected_intent_version: 1, plan_hash: 'plan-1' });
  await act(async () => tree.unmount());
  const admin = await mountPanel(row, { accountId: 'u-a', isAdmin: true });
  await act(async () => host(admin.tree, 'settlement-admin-intent-1').props.onPress());
  expect(host(admin.tree, 'settlement-action-submit-intent-1').props.disabled).toBe(true);
  await act(async () => host(admin.tree, 'settlement-reason-intent-1').props.onChangeText('Reviewed with both participants'));
  expect(host(admin.tree, 'settlement-action-submit-intent-1').props.disabled).toBe(false);
  await act(async () => admin.tree.unmount());
});

test('receiving-family reviewer may confirm a receipt but cannot consent for another family person', async () => {
  const row = intentFixture({ cash_legs: [{ ...intentFixture().cash_legs[0], from_member_id: 'a', to_member_id: 'family', actual_payer_person_id: 'a', actual_receiver_person_id: 'riya' }],
    plan: { ...intentFixture().plan, required_person_ids: ['riya'] } });
  const { tree } = await mountPanel(row);
  expect(host(tree, 'settlement-confirm-leg-1')).toBeDefined();
  expect(tree.root.findAll(node => node.props.testID === 'settlement-consent-riya')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('offline panel exposes saved evidence without any report or approval action', async () => {
  const { tree } = await mountPanel(intentFixture(), { live: false, sessionMode: 'offline', isAdmin: true });
  expect(tree.root.findAll(node => node.props.testID === 'settlement-confirm-leg-1')).toHaveLength(0);
  expect(mockApi).not.toHaveBeenCalled(); expect(requireFinancialConnection).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

test('revoked receiver authority returns an error without locally applying coverage', async () => {
  const { tree, props } = await mountPanel(intentFixture(), {accountId:'u-a',isAdmin:true});
  await act(async () => host(tree,'settlement-confirm-leg-1').props.onPress());
  mockApi.mockResolvedValueOnce(intentFixture()).mockRejectedValueOnce({code:'http',status:403,detailCode:'insufficient_authority'});
  await act(async () => host(tree,'settlement-action-submit-intent-1').props.onPress());
  expect(props.onComplete).not.toHaveBeenCalled(); expect(JSON.stringify(tree.toJSON())).toContain('cannot perform this action');
  await act(async () => tree.unmount());
});

test('deferred review cannot quote after switching account and trip scope', async () => {
  let resolve!: (value: unknown) => void;
  (coverage as jest.Mock).mockImplementationOnce(() => new Promise(done => {resolve=done;}));
  const {tree,props} = await mountFlow();
  await act(async () => host(tree,'settlement-preview').props.onPress());
  await act(async () => tree.update(<Flow {...props} accountId="u-riya" scope="another-account-and-trip" />));
  await act(async () => resolve(coverageFixture()));
  expect(mockApi).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});
