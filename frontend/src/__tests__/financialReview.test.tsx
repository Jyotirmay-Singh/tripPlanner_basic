/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

let mockUser = { id: 'first' };
let mockMode = 'online';
const mockApi = jest.fn();
const mockNetwork = jest.fn();
const mockComplete = jest.fn();
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: mockUser, sessionMode: mockMode }) }));
jest.mock('../api', () => ({ api: (...args: any[]) => mockApi(...args), getToken: async () => `token-${mockUser.id}` }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: () => mockNetwork() } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'fixed-mutation-uuid' }));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../ui', () => {
  const R = require('react');
  const stub = (type: string) => (props: any) => R.createElement(type, props, props.children);
  return { Button: stub('Button'), Input: stub('Input'), Sheet: stub('Sheet') };
});
import FinancialReviewSheet, { ReviewEffectsView } from '../FinancialReviewSheet';
import { completeCoverage, requireFinancialConnection } from '../financialReview';

const request = { operation: 'replace_expense' as const, target_id: 'expense', changes: { amount: '120' } };
const props = { tripId: 'trip', currency: 'INR', request, onClose: jest.fn(), onComplete: mockComplete };
const coverage = { complete: true, snapshot_id: 'current', expenses: [], details: {} };
const preview = { id: 'preview', preview_hash: 'hash', expires_at: '2099-01-01T00:00:00Z', effects: { after_balances: { payer: '20' }, unapplied_credit: [{ source_id: 'cash', amount: '100' }] }, requires_admin: true };
const host = (tree: ReactTestRenderer, id: string) => tree.root.find(node => typeof node.type === 'string' && node.props.testID === id);

beforeEach(() => {
  jest.clearAllMocks(); mockUser = { id: 'first' }; mockMode = 'online';
  mockNetwork.mockResolvedValue({ isConnected: true, isInternetReachable: true });
  mockApi.mockImplementation(async (path: string) => path.endsWith('correction-previews') ? preview : coverage);
});

async function mount() {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<FinancialReviewSheet {...props} />); });
  await act(async () => { tree.root.findByType('Input' as any).props.onChangeText('Correct receipt amount'); });
  return tree;
}

test('preview is accessible and cannot apply coverage until an explicit submission', async () => {
  const tree = await mount();
  expect(tree.root.findByType('Sheet' as any).props.trapFocus).toBe(true);
  expect(mockApi).not.toHaveBeenCalled();
  await act(async () => { await host(tree, 'financial-review-preview').props.onPress(); });
  expect(mockApi.mock.calls.map(call => call[0])).toEqual(['/trips/trip/expense-settlement', '/trips/trip/correction-previews']);
  expect(mockComplete).not.toHaveBeenCalled();
  await act(async () => { await host(tree, 'financial-review-submit').props.onPress(); });
  expect(mockApi.mock.calls[2][1]).toMatchObject({ authToken: 'token-first', body: { preview_id: 'preview', preview_hash: 'hash', client_mutation_id: 'fixed-mutation-uuid' } });
  expect(mockComplete).toHaveBeenCalledTimes(1);
  await act(async () => { tree.unmount(); });
});

test('a lost response retries the same mutation and an altered reason requires a new preview', async () => {
  const tree = await mount();
  await act(async () => { host(tree, 'financial-review-preview').props.onPress(); });
  mockApi.mockRejectedValueOnce(new Error('Response lost'));
  await act(async () => { host(tree, 'financial-review-submit').props.onPress(); });
  await act(async () => { host(tree, 'financial-review-submit').props.onPress(); });
  const submitted = mockApi.mock.calls.filter(call => call[0].endsWith('/corrections'));
  expect(submitted[0][1].body).toEqual(submitted[1][1].body);
  await act(async () => { tree.root.findByType('Input' as any).props.onChangeText('Different change reason'); });
  expect(tree.root.findAll(node => node.props.testID === 'financial-review-submit')).toHaveLength(0);
  await act(async () => { tree.unmount(); });
});

test('account switching aborts an old preview and suppresses its response', async () => {
  const tree = await mount();
  let resolve!: (value: unknown) => void;
  mockApi.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  await act(async () => { host(tree, 'financial-review-preview').props.onPress(); });
  const signal = mockApi.mock.calls[0][1].signal;
  mockUser = { id: 'second' };
  await act(async () => { tree.update(<FinancialReviewSheet {...props} />); });
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(coverage); });
  expect(mockApi).toHaveBeenCalledTimes(1);
  expect(mockComplete).not.toHaveBeenCalled();
  await act(async () => { tree.unmount(); });
});

test('offline review preserves the form and makes no request', async () => {
  const tree = await mount(); mockMode = 'offline';
  await act(async () => { tree.update(<FinancialReviewSheet {...props} />); });
  await act(async () => { host(tree, 'financial-review-preview').props.onPress(); });
  expect(mockApi).not.toHaveBeenCalled();
  expect(tree.root.findByType('Input' as any).props.value).toBe('Correct receipt amount');
  await expect(requireFinancialConnection('offline')).rejects.toThrow('draft is preserved');
  await act(async () => { tree.unmount(); });
});

test('changing trips aborts a preview and clears its financial state', async () => {
  const tree = await mount();
  let resolve!: (value: unknown) => void;
  mockApi.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  await act(async () => { host(tree, 'financial-review-preview').props.onPress(); });
  const signal = mockApi.mock.calls[0][1].signal;
  await act(async () => { tree.update(<FinancialReviewSheet {...props} tripId="another-trip" />); });
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(coverage); });
  expect(mockApi).toHaveBeenCalledTimes(1);
  expect(tree.root.findAll(node => node.props.testID === 'financial-review-submit')).toHaveLength(0);
  await act(async () => { tree.unmount(); });
});

test('durable proposal renewal uses version and plan bindings without applying directly', async () => {
  const tree = await mount();
  await act(async () => { tree.update(<FinancialReviewSheet {...props} request={{ ...request, renewal: { id: 'proposal', version: 3, plan_hash: 'old-hash' }, reason: 'Renew reviewed proposal' }} />); });
  await act(async () => { host(tree, 'financial-review-preview').props.onPress(); });
  await act(async () => { host(tree, 'financial-review-submit').props.onPress(); });
  const last = mockApi.mock.calls[mockApi.mock.calls.length - 1];
  expect(last[0]).toBe('/trips/trip/corrections/proposal/actions');
  expect(last[1].body).toMatchObject({ action: 'renew', expected_version: 3, plan_hash: 'old-hash' });
  await act(async () => { tree.unmount(); });
});

test('complete coverage batches 201 details and rejects a changed snapshot', async () => {
  const summary = { ...coverage, expenses: Array.from({ length: 201 }, (_, index) => ({ expense_id: `expense-${index}` })) };
  mockApi.mockImplementation(async (path: string) => path.includes('?') ? { ...coverage, details: { [path]: { participants: [] } } } : summary);
  const result = await completeCoverage('trip', { authToken: 'captured-token' });
  expect(Object.keys(result.details ?? {})).toHaveLength(3);
  expect(mockApi).toHaveBeenCalledTimes(4);
  expect(mockApi.mock.calls.every(call => call[1].authToken === 'captured-token')).toBe(true);
  mockApi.mockReset().mockResolvedValueOnce(summary).mockResolvedValueOnce({ ...coverage, snapshot_id: 'changed' });
  await expect(completeCoverage('trip')).rejects.toThrow('changed');
});

test('correction effects explain dependent expenses, reservations, retained approvals and money', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<ReviewEffectsView currency="INR" names={{ a: 'Alex', b: 'Blair' }} effects={{
    expense_names: { dinner: 'Dinner', reverse: 'Return journey' },
    before_shares: [
      { share_id: 'old-dinner', expense_id: 'dinner', person_id: 'b', person_name: 'Blair', wallet_id: 'b', original_share: '100', remaining_amount: '0', reserved_amount: '20' },
      { share_id: 'old-reverse', expense_id: 'reverse', person_id: 'a', person_name: 'Alex', wallet_id: 'a', original_share: '80', remaining_amount: '0', reserved_amount: '0' },
    ],
    shares: [{ share_id: 'new-dinner', expense_id: 'dinner', person_id: 'b', person_name: 'Blair', original_share: '120', remaining_amount: '120' }],
    affected_bundles: [{ event_id: 'bundle', approval_count: 3, required_person_ids: ['a', 'b'],
      allocation_lines: [{ share_id: 'old-dinner', amount: '80', kind: 'approved_offset' }, { share_id: 'old-reverse', amount: '80', kind: 'approved_offset' }],
      cash_uses: [{ source_id: 'cash', amount: '20' }] }],
    cash_sources: [{ source_id: 'cash', amount: '20', payer_wallet_id: 'b', receiver_wallet_id: 'a' }],
    recorded_cash_changes: [{ before_amount: '100', after_amount: '60', payer_wallet_id: 'b', receiver_wallet_id: 'a' }],
    unapplied_credit: [{ source_id: 'cash', amount: '20' }], affected_reports: [{ id: 'report', status: 'needs_review' }],
  }} />); });
  const text = tree.root.findAll(node => node.type === 'T').map(node => React.Children.toArray(node.props.children).join('')).join('\n');
  expect(text).toContain('Share: 100 → 120 INR. Outstanding: 0 → 120 INR.');
  expect(text).toContain('Prior reservation: 20 INR');
  expect(text).toContain('Return journey · Alex: prior share 80 INR retired');
  expect(text).toContain('3 prior approval(s) retained');
  expect(text).toContain('80 INR of approved offset coverage');
  expect(text).toContain('Blair → Alex: release 20 INR');
  expect(text).toContain('Retained credit: 20 INR');
  expect(text).toContain('recorded money 100 → 60 INR');
  expect(text).toContain('this does not record a physical refund');
  expect(text).toContain('1 pending payment report(s)');
  await act(async () => { tree.unmount(); });
});
