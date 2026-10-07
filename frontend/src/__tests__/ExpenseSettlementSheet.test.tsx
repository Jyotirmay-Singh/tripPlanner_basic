/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import ExpenseSettlementSheet from '../ExpenseSettlementSheet';
import { coverageFixture, coveragePerson, intentFixture, settlementTrip } from './expenseSettlement.fixtures';
import { api } from '../api';
import { requireFinancialConnection } from '../financialReview';
import type { Coverage } from '../financialReview';
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('../api', () => ({ api: jest.fn(), getToken: async () => 'captured-token' }));
jest.mock('../financialReview', () => ({ requireFinancialConnection: jest.fn(async () => {}), coverage: jest.fn(async () => coverageFixture()) }));
jest.mock('../ThemeContext', () => ({ useTheme: () => ({ colors: { textMain: '#121A18', border: '#DCD9CE', primary: '#1C3F39' } }) }));
jest.mock('../upiLauncher', () => ({ discoverUpiApps: async () => ({ apps: [] }) }));
jest.mock('../ReviewedSettlementFlow', () => ({ __esModule: true, default: (props: any) => require('react').createElement('ReviewedFlow', props) }));
jest.mock('../T', () => ({ __esModule: true, default: (props: any) => require('react').createElement('T', props, props.children) }));
jest.mock('../ui', () => {
  const R = require('react'); const stub = (name: string) => (p: any) => R.createElement(name, p, p.children);
  return { Sheet: stub('Sheet'), Button: stub('Button'), Icon: stub('Icon'), Input: stub('Input') };
});
jest.mock('../ui/Button', () => ({ __esModule: true, default: (p: any) => require('react').createElement('Button', p) }));
jest.mock('../ui/Input', () => ({ __esModule: true, default: (p: any) => require('react').createElement('Input', p) }));
const mockApi = api as jest.Mock;
const expense = { id: 'dinner', description: 'Dinner', category: 'Food', amount: 400, paid_by_member_id: 'a' };
function byId(tree: ReactTestRenderer, id: string) { return tree.root.findAll(node => node.props.testID === id)[0]; }
async function mount(data = coverageFixture(), accountId = 'u-you', source: 'live' | 'cache' = 'live', exp = expense) {
  let tree!: ReactTestRenderer;
  const refresh = jest.fn(async () => data);
  await act(async () => { tree = TestRenderer.create(<ExpenseSettlementSheet expense={exp} trip={settlementTrip} accountId={accountId}
    sessionMode={source === 'cache' ? 'offline' : 'online'} isAdmin={accountId === 'u-a'} progress={{ data, source, loading: false, message: '', refresh }}
    expenseNames={{ dinner: 'Dinner' }} onClose={() => {}} onChanged={() => {}} />); });
  return { tree, refresh };
}
beforeEach(() => { jest.clearAllMocks(); mockApi.mockResolvedValue([]); });
test('opening reads only; all eligible family shares selected, actual payer named, and deselection changes exact direct quote selection', async () => {
  const { tree } = await mount();
  expect(mockApi.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
  expect(byId(tree, 'settlement-select-share-you').props.accessibilityState.checked).toBe(true);
  expect(byId(tree, 'settlement-select-share-riya').props.accessibilityState.checked).toBe(true);
  expect(byId(tree, 'settlement-paying-for').props.children.join('')).toContain('Paying as You, for You, Riya');
  await act(async () => byId(tree, 'settlement-select-share-riya').props.onPress());
  await act(async () => byId(tree, 'settlement-pay-a').props.onPress());
  const flow = tree.root.findByType('ReviewedFlow' as any);
  expect(flow.props.selection.shares).toEqual([{ share_id: 'share-you', amount: '100' }]);
  expect(flow.props.selection.recipientPerson).toBe('a');
  await act(async () => tree.unmount());
});
test('partial shares expose only remaining eligible money and already covered shares cannot be selected', async () => {
  const data = coverageFixture();
  data.details!.dinner.participants[1] = coveragePerson('you', 'family', { remaining_amount: '60', actionable_amount: '60', coverage: { direct: '40' } });
  data.details!.dinner.participants[2] = coveragePerson('riya', 'family', { remaining_amount: '0', actionable_amount: '0', coverage: { group: '20', approved_offset: '80' } });
  const { tree } = await mount(data);
  expect(byId(tree, 'settlement-share-status-share-you').props.children).toBe('Partial');
  expect(tree.root.findAll(node => node.props.testID === 'settlement-select-share-riya')).toHaveLength(0);
  await act(async () => byId(tree, 'settlement-pay-a').props.onPress());
  expect(tree.root.findByType('ReviewedFlow' as any).props.selection.shares).toEqual([{ share_id: 'share-you', amount: '60' }]);
  await act(async () => tree.unmount());
});
test('reported reservations disable duplicate payment and label awaiting approval without changing progress', async () => {
  mockApi.mockResolvedValue([intentFixture()]);
  const data = coverageFixture();
  data.details!.dinner.participants[1] = coveragePerson('you', 'family', { reserved_amount: '100', actionable_amount: '0' });
  const { tree } = await mount(data);
  expect(byId(tree, 'settlement-share-status-share-you').props.children).toBe('Awaiting approval');
  expect(tree.root.findAll(node => node.props.testID === 'settlement-select-share-you')).toHaveLength(0);
  expect(data.expenses![0].settled_count).toBe(1);
  await act(async () => tree.unmount());
});
test('expired UPI work offers recovery while other eligible family shares remain payable', async () => {
  mockApi.mockResolvedValue([intentFixture({ method: 'upi', status: 'expired',
    cash_legs: [{ ...intentFixture().cash_legs[0], receipt_status: 'expired' }] })]);
  const { tree } = await mount(coverageFixture());
  expect(tree.root.findAll(node => node.props.testID === 'settlement-select-share-you')).toHaveLength(0);
  expect(byId(tree, 'settlement-select-share-riya')).toBeDefined();
  expect(JSON.stringify(tree.toJSON())).toContain('Check the expired or canceled UPI payment');
  await act(async () => byId(tree, 'settlement-pay-a').props.onPress());
  expect(tree.root.findByType('ReviewedFlow' as any).props.selection.shares).toEqual([{ share_id: 'share-riya', amount: '100' }]);
  await act(async () => tree.unmount());
});
test('your settled share stays visible while another family member still owes; offset proposals leave direct payment available', async () => {
  mockApi.mockResolvedValue([intentFixture({ mode: 'offset', cash_legs: [] })]);
  const data = coverageFixture(); data.expenses![0].viewer_status = 'covered';
  data.details!.dinner.participants[1] = coveragePerson('you', 'family', { remaining_amount: '0', actionable_amount: '0', coverage: { direct: '100' } });
  const { tree } = await mount(data);
  expect(byId(tree, 'settlement-your-share-settled').props.children).toBe('Your share settled');
  expect(byId(tree, 'settlement-pay-a').props.disabled).toBe(false);
  await act(async () => tree.unmount());
});
test('offline cached shares are readable but no payment, report or approval can be submitted', async () => {
  const { tree } = await mount(coverageFixture(), 'u-you', 'cache');
  expect(byId(tree, 'settlement-saved-status')).toBeDefined();
  expect(tree.root.findAll(node => node.props.testID === 'settlement-pay-a')).toHaveLength(0);
  expect(byId(tree, 'settlement-group-option').props.disabled).toBe(true);
  expect(requireFinancialConnection).not.toHaveBeenCalled(); expect(mockApi).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});
test('refund receiving participant sees reversed direction and no outgoing pay action', async () => {
  const data: Coverage = coverageFixture();
  data.details!.dinner.participants = [coveragePerson('you', 'family', { original_share: '-100', debtor_wallet_id: 'a', creditor_wallet_id: 'family', actionable_amount: null })];
  const { tree } = await mount(data, 'u-you', 'live', { ...expense, amount: -100 });
  expect(tree.root.findAll(node => node.props.testID === 'settlement-pay-a')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('as a refund');
  await act(async () => tree.unmount());
});

test('a partial reservation keeps confirmed remaining and allows only the unreserved amount', async () => {
  const data = coverageFixture(); data.details!.dinner.participants[1] = coveragePerson('you','family', { reserved_amount: '40', actionable_amount: '60' });
  const { tree } = await mount(data);
  await act(async () => byId(tree, 'settlement-select-share-riya').props.onPress());
  await act(async () => byId(tree, 'settlement-pay-a').props.onPress());
  expect(tree.root.findByType('ReviewedFlow' as any).props.selection.shares).toEqual([{share_id:'share-you',amount:'60'}]);
  expect(data.details!.dinner.participants[1].remaining_amount).toBe('100');
  await act(async () => tree.unmount());
});

test('refund funding user gets separate recipient actions and a family recipient is never guessed', async () => {
  const data = coverageFixture();
  data.details!.dinner.participants = [coveragePerson('you','family',{original_share:'-100',debtor_wallet_id:'a',creditor_wallet_id:'family'}),
    coveragePerson('sam','sam',{original_share:'-100',debtor_wallet_id:'a',creditor_wallet_id:'sam'})];
  const { tree } = await mount(data,'u-a','live',{...expense,amount:-200});
  expect(byId(tree,'settlement-pay-family')).toBeDefined(); expect(byId(tree,'settlement-pay-sam')).toBeDefined();
  await act(async () => byId(tree,'settlement-pay-family').props.onPress());
  const flow = tree.root.findByType('ReviewedFlow' as any);
  expect(flow.props.selection.recipientPerson).toBeNull(); expect(flow.props.selection.shares).toEqual([{share_id:'share-you',amount:'100'}]);
  await act(async () => tree.unmount());
});
