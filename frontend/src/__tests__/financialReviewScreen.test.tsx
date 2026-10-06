/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

let mockTripId = 'trip';
let mockUser = { id: 'admin', is_super_admin: false };
const mockApi = jest.fn();
const mockToken = jest.fn();
const mockCoverage = jest.fn();
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: mockTripId }) }));
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: mockUser, sessionMode: 'online' }) }));
jest.mock('../ThemeContext', () => ({ useTheme: () => ({ colors: { danger: '#aa0000' } }) }));
jest.mock('../api', () => ({ api: (...args: any[]) => mockApi(...args), getToken: () => mockToken(), ApiError: class extends Error {} }));
jest.mock('../financialReview', () => ({ ...jest.requireActual('../financialReview'),
  coverage: (...args: any[]) => mockCoverage(...args), completeCoverage: (...args: any[]) => mockCoverage(...args),
  requireFinancialConnection: async () => {} }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'stable-review-mutation' }));
jest.mock('../upiLauncher', () => ({ discoverUpiApps: async () => ({ apps: [] }) }));
jest.mock('../FinancialReviewSheet', () => ({ __esModule: true, default: () => null, ReviewEffectsView: () => null }));
jest.mock('../T', () => ({ __esModule: true, default: (p: any) => require('react').createElement('T', p, p.children) }));
jest.mock('../ui', () => {
  const R = require('react');
  const stub = (name: string) => (p: any) => R.createElement(name, p, p.children);
  return { Screen: stub('Screen'), Card: stub('Card'), Button: stub('Button'), Input: stub('Input'),
    SegmentedControl: stub('SegmentedControl'), Sheet: (p: any) => p.visible ? R.createElement('Sheet', p, p.children) : null };
});
import FinancialReview from '../../app/trip/[id]/financial-review';

const correction = { id: 'correction', operation: 'replace_expense', target_id: 'expense', reason: 'Correct amount',
  status: 'awaiting_approval', version: 4, plan_hash: 'reviewed-plan', required_person_ids: [], approvals: [], created_by: 'creator', effects: {} };
beforeEach(() => {
  jest.clearAllMocks(); mockTripId = 'trip'; mockUser = { id: 'admin', is_super_admin: false };
  mockToken.mockResolvedValue('captured-test-token');
  mockCoverage.mockResolvedValue({ complete: true, snapshot_id: 'current', currency: 'INR', expenses: [], details: {}, unapplied_credit: [] });
  mockApi.mockImplementation(async (path: string, options: any) => {
    if (options?.method === 'POST') return { ...correction, status: 'applied' };
    if (path.endsWith('/corrections')) return [correction];
    if (path.endsWith('/settlement-intents')) return [];
    if (path.endsWith('/balances')) return { transfers: [], members: [] };
    return { currency: 'INR', owner_id: 'admin', admin_ids: [], members: [] };
  });
});
async function mount() {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<FinancialReview />); });
  await act(async () => { tree.root.find(node => node.type === 'Input' && node.props.label === 'Review or admin override reason').props.onChangeText('Reviewed original receipt'); });
  return tree;
}
function button(tree: ReactTestRenderer, label: string) {
  return tree.root.find(node => node.type === 'Button' && node.props.label === label);
}
test('viewing review posts nothing and approval submits the exact version, reason and mutation', async () => {
  const tree = await mount();
  expect(mockApi.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
  await act(async () => { button(tree, 'Approve correction').props.onPress(); });
  const submitted = mockApi.mock.calls.find(call => call[1]?.method === 'POST');
  expect(submitted).toEqual(['/trips/trip/corrections/correction/actions', expect.objectContaining({ authToken: 'captured-test-token', body: {
    expected_version: 4, plan_hash: 'reviewed-plan', action: 'approve', reason: 'Reviewed original receipt', client_mutation_id: 'stable-review-mutation',
  } })]);
  await act(async () => { tree.unmount(); });
});
test.each(['trip', 'account'])('%s switching while sign-in is pending suppresses the old financial action', async change => {
  const tree = await mount();
  let resolve!: (token: string) => void;
  mockToken.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  await act(async () => { button(tree, 'Approve correction').props.onPress(); });
  if (change === 'trip') mockTripId = 'another-trip'; else mockUser = { id: 'another-account', is_super_admin: false };
  await act(async () => { tree.update(<FinancialReview />); });
  await act(async () => { resolve('obsolete-test-token'); });
  expect(mockApi.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
  await act(async () => { tree.unmount(); });
});
test('switching away and back suppresses a historical report from the previous visit', async () => {
  const tree = await mount();
  let resolve!: (value: unknown) => void;
  mockApi.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  await act(async () => { button(tree, 'Review historical reconciliation report').props.onPress(); });
  mockTripId = 'another-trip';
  await act(async () => { tree.update(<FinancialReview />); });
  mockTripId = 'trip';
  await act(async () => { tree.update(<FinancialReview />); });
  await act(async () => { resolve({ counts: {}, review_cases: [], baseline_wallet_vector: {}, index_prerequisites: [], source_link_duplicates: [] }); });
  expect(tree.root.findAll(node => node.type === 'Sheet' && node.props.title === 'Historical reconciliation report')).toHaveLength(0);
  await act(async () => { tree.unmount(); });
});
