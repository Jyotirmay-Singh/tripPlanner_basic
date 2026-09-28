/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockPush = jest.fn();
const mockToast = jest.fn();

jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    Stack: { Screen: (p: any) => R.createElement('StackScreen', p) },
    useLocalSearchParams: () => ({ id: 't1', mid: 'a' }),
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (cb: any) => R.useEffect(() => { cb(); }, []),
  };
});
jest.mock('../../T', () => {
  const R = require('react');
  const { Text: NativeText } = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(NativeText, p, p.children) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (p: any) => R.createElement(name, p, p.children);
  return {
    __esModule: true,
    Screen: stub('Screen'),
    Card: stub('Card'),
    Icon: stub('Icon'),
    ListRow: (p: any) => R.createElement('ListRow', p),
    EmptyState: stub('EmptyState'),
    AmountText: stub('AmountText'),
    SkeletonCard: stub('SkeletonCard'),
    useToast: () => ({ show: mockToast }),
  };
});

import MemberSpendDetail from '../../../app/trip/[id]/member/[mid]';
import { api } from '../../api';

const apiMock = api as unknown as jest.Mock;

beforeEach(() => {
  mockPush.mockReset();
  mockToast.mockReset();
  apiMock.mockReset();
  apiMock.mockImplementation((url: string) => {
    if (url === '/trips/t1') {
      return Promise.resolve({
        id: 't1', name: 'Trip', currency: 'INR',
        members: [{ id: 'a', name: 'Alex', kind: 'individual' }],
      });
    }
    if (url === '/trips/t1/expenses') {
      return Promise.resolve([{
        id: 'e1', amount: 455, category: 'Food', description: 'Dinner',
        date: '10-09-26', paid_by_member_id: 'a', split_mode: 'PER_CAPITA',
        shares: { entities: [{ id: 'a', share: 200 }] },
      }]);
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
});

describe('member spending detail screen', () => {
  it('uses a professional title and only shows payment history details', async () => {
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<MemberSpendDetail />); });

    expect(renderer.root.findByType('StackScreen' as any).props.options.title)
      .toBe('Spending details');
    expect(renderer.root.findByType('AmountText' as any).props).toMatchObject({
      value: 455,
      style: { marginTop: 4, textAlign: 'left' },
    });

    const row = renderer.root.findByType('ListRow' as any);
    expect(row.props.meta).toBeUndefined();
    expect(row.props.title).toBe('Dinner');

    const copy = renderer.root.findAllByType(Text)
      .flatMap((node: any) => node.props.children)
      .filter((value: unknown) => typeof value === 'string')
      .join(' ');
    expect(copy).toContain('1 transaction');
    expect(copy).not.toMatch(/fronted|their share/i);
  });
});
