/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Linking, Share, StyleSheet } from 'react-native';
import { COMPONENT_SIZE, FONTS, RADIUS, SPACING } from '../../theme';

const mockRouterPush = jest.fn();
const mockGetTripInviteLink = jest.fn();
const mockRefreshRuntimeConfig = jest.fn();
const mockToastShow = jest.fn();
const mockSetStringAsync = jest.fn().mockResolvedValue(true);
const mockListPendingExpenses = jest.fn().mockResolvedValue([]);
let mockInviteLinksEnabled = false;
let mockRole: 'owner' | 'admin' | 'member' | null = null;
let mockUser: any = { id: 'u1', email: 'member@gmail.com', is_super_admin: false };
let mockSearchParams = { id: 't1' };

jest.mock('../../api', () => ({
  api: jest.fn(),
  getTripInviteLink: (...args: any[]) => mockGetTripInviteLink(...args),
  getToken: jest.fn(),
  receiptUrl: jest.fn(() => 'receipt://x'),
  spendSummary: jest.fn(),
}));
jest.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => mockSetStringAsync(value),
}));
jest.mock('../../offlineExpenses', () => ({
  listPendingExpenses: (...args: any[]) => mockListPendingExpenses(...args),
  pendingStatusLabel: (item: { state: string }) => item.state === 'needs_review'
    ? 'Needs review · Pending sync' : 'Pending sync',
}));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({
  user: mockUser,
  inviteLinksEnabled: mockInviteLinksEnabled,
  refreshRuntimeConfig: mockRefreshRuntimeConfig,
}) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({
    mode: 'dark',
    colors: {
      background: '#0a0d0c', surface: '#121715', surfaceMuted: '#1a221f',
      primary: '#87c0b2', primaryText: '#0a0d0c', overlayOnPrimary: 'rgba(0,0,0,0.12)',
      textMain: '#f7f5f0', textMuted: '#8ea39d', border: '#24302c',
      danger: '#ff8a66', success: '#8fc98f', warning: '#f5c28f',
    },
  }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useLocalSearchParams: () => mockSearchParams,
    useRouter: () => ({ push: mockRouterPush, back: jest.fn() }),
    useFocusEffect: (callback: any) => R.useEffect(() => { callback(); }, []),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const R = require('react');
  return { SafeAreaView: (props: any) => R.createElement('SafeAreaView', props, props.children) };
});
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../DonutChart', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (props: any) => R.createElement('DonutChart', props),
    paletteForMode: () => ['#123456'],
  };
});
jest.mock('../../SpendBarChart', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ReceiptViewer', () => ({ __esModule: true, default: () => null }));
jest.mock('../../MembershipCard', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('MembershipCard', {
    ...props, testID: 'trip-membership-card-stub',
  }) };
});
jest.mock('../../ConfirmModal', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('ConfirmModal', props) };
});
jest.mock('../../TripChat', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TripChat', props) };
});
jest.mock('../../useTripChat', () => ({
  useTripChat: () => ({
    messages: [], unreadCount: 0, loading: false, loadingOlder: false,
    hasMoreBefore: false, connected: true, refreshUnread: jest.fn(), loadLatest: jest.fn(),
    loadOlder: jest.fn(), send: jest.fn(), retry: jest.fn(), edit: jest.fn(), remove: jest.fn(),
    clear: jest.fn(), markThrough: jest.fn(),
  }),
}));
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    __esModule: true,
    Card: stub('Card'),
    Button: stub('Button'),
    IconButton: stub('IconButton'),
    Icon: stub('Icon'),
    SegmentedControl: stub('SegmentedControl'),
    StatCard: stub('StatCard'),
    ProgressBar: stub('ProgressBar'),
    EmptyState: stub('EmptyState'),
    ResponsiveAmountText: stub('ResponsiveAmountText'),
    SkeletonCard: stub('SkeletonCard'),
    ActionSheet: stub('ActionSheet'),
    useToast: () => ({ show: mockToastShow }),
  };
});
jest.mock('../../permissions', () => ({
  canModifyExpense: () => false,
  roleOf: () => mockRole,
  canEditTripSettings: () => true,
  canManageMembers: () => false,
  canDeleteTrip: (_trip: any, _userId: any, isSuperAdmin: boolean) => isSuperAdmin,
}));
jest.mock('../../displayNames', () => jest.requireActual('../../displayNames'));
jest.mock('../../bill', () => ({ billLabel: () => 'Bill not attached' }));

import TripDetail from '../../../app/trip/[id]/index';
import { api, getToken, spendSummary } from '../../api';

const apiMock = api as unknown as jest.Mock;
const getTokenMock = getToken as unknown as jest.Mock;
const spendSummaryMock = spendSummary as unknown as jest.Mock;

const INDIVIDUAL = {
  id: 'm1', name: 'Aditi', kind: 'individual', family_members: [], user_id: 'u1',
};
const BASE_TRIP = {
  id: 't1',
  name: 'Lakshadweep',
  code: 'UCK3RZ',
  start_date: '2026-11-12',
  end_date: '2026-11-19',
  budget: 100_000,
  currency: 'INR',
  owner_id: 'u1',
  admin_ids: ['u1'],
  user_ids: ['u1'],
  members: [INDIVIDUAL],
};
const APK_DOWNLOAD_URL = 'https://tripsplitter-web.vercel.app/download/android';
const CODE_FALLBACK_MESSAGE = 'You have been invited to join the trip "Lakshadweep" on Trip Splitter.\n\n'
  + 'Trip code: UCK3RZ\n'
  + 'Enter this code in Trip Splitter to join the trip.\n\n'
  + 'Download Trip Splitter for Android:\n'
  + APK_DOWNLOAD_URL;

type Fixture = {
  trip?: Record<string, unknown>;
  budget?: number | null;
  expenses?: Record<string, unknown>[];
  balances?: Record<string, unknown>;
};

const expense = (amount: number, id = `e-${amount}`) => ({
  id,
  amount,
  category: 'Food',
  date: '12-11-26',
  paid_by_member_id: 'm1',
  split_member_ids: ['m1'],
});

async function mountTrip(fixture: Fixture = {}) {
  const {
    trip: tripOverrides, expenses = [expense(50_000)], balances: balanceOverrides,
  } = fixture;
  const budget = Object.prototype.hasOwnProperty.call(fixture, 'budget')
    ? fixture.budget
    : 100_000;
  const trip = { ...BASE_TRIP, ...tripOverrides, budget };
  const balances = {
    net: { m1: 0 }, transfers: [], members: trip.members, currency: trip.currency, per_person: [],
    ...balanceOverrides,
  };
  apiMock.mockImplementation((path: string) => {
    if (path === '/trips/t1') return Promise.resolve(trip);
    if (path === '/trips/t1/expenses') return Promise.resolve(expenses);
    if (path === '/trips/t1/balances') return Promise.resolve(balances);
    if (path === '/trips/t1/spend-summary') return Promise.resolve({ total: 0, count: 0, entities: [] });
    if (path === '/trips/t1/payments') return Promise.resolve([]);
    return Promise.resolve({});
  });
  spendSummaryMock.mockResolvedValue({ total: 0, count: 0, entities: [] });

  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<TripDetail />);
  });
  return renderer;
}

function hostByTestID(root: any, type: string, testID: string) {
  return root.findAllByType(type as any).find((node: any) => node.props.testID === testID);
}

function hostsByTestID(root: any, testID: string) {
  return root.findAll(
    (node: any) => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function interactiveByTestID(root: any, testID: string) {
  return root.findAll(
    (node: any) => node.props.testID === testID && typeof node.props.onPress === 'function',
  )[0];
}

function textContent(node: any): string {
  const children = node?.props?.children;
  if (children == null) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map((child) => (
    typeof child === 'object' && child?.props ? textContent(child) : String(child ?? '')
  )).join('');
  return typeof children === 'object' && children?.props ? textContent(children) : String(children);
}

beforeEach(() => {
  apiMock.mockReset();
  getTokenMock.mockReset();
  getTokenMock.mockResolvedValue('token');
  spendSummaryMock.mockReset();
  mockRouterPush.mockReset();
  mockGetTripInviteLink.mockReset();
  mockRefreshRuntimeConfig.mockReset();
  mockRefreshRuntimeConfig.mockResolvedValue({ inviteLinksEnabled: false });
  mockToastShow.mockReset();
  mockSetStringAsync.mockReset();
  mockSetStringAsync.mockResolvedValue(true);
  mockListPendingExpenses.mockReset();
  mockListPendingExpenses.mockResolvedValue([]);
  mockInviteLinksEnabled = false;
  mockRole = null;
  mockUser = { id: 'u1', email: 'member@gmail.com', is_super_admin: false };
  mockSearchParams = { id: 't1' };
});

it('shows a pending expense once across remounts without adding it to confirmed totals', async () => {
  const pending = {
    clientMutationId: 'uuid-pending', accountId: 'u1', tripId: 't1', operation: 'expense_create',
    state: 'queued', queuedAt: 100, canonicalResourceId: null,
    payload: { amount: -200, currency: 'INR', description: 'Refund pending', category: 'Food',
      date: '25-09-26', paid_by_member_id: 'm1', split_member_ids: ['m1'] },
  };
  mockListPendingExpenses.mockResolvedValue([pending]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const renderer = await mountTrip({ expenses: [expense(500)] });
    expect(textContent(hostByTestID(renderer.root, 'T', 'trip-budget-used-spent'))).toContain('500');
    expect(hostsByTestID(renderer.root, 'trip-pending-summary')).toHaveLength(1);
    await act(async () => {
      renderer.root.findByType('SegmentedControl' as any).props.onChange('expenses');
    });
    expect(hostsByTestID(renderer.root, 'pending-expense-item-uuid-pending')).toHaveLength(1);
    expect(hostByTestID(renderer.root, 'Card', 'pending-expense-item-uuid-pending')
      .props.accessibilityLabel).toContain('Pending sync. Saved on this device');
    expect(hostsByTestID(renderer.root, 'pending-expense-status-uuid-pending')).toHaveLength(1);
    expect(hostsByTestID(renderer.root, 'expense-item-e-500')).toHaveLength(1);
    await act(async () => { renderer.unmount(); });
  }
});

describe('Personal balance payment details', () => {
  const RAHUL_1 = {
    id: 'rahul-1', name: 'Rahul', kind: 'individual', family_members: [], user_id: 'u2',
  };
  const RAHUL_2 = {
    id: 'rahul-2', name: 'Rahul', kind: 'individual', family_members: [], user_id: 'u3',
  };
  const MIRACLE_FAMILY = {
    id: 'miracle-family', name: 'Miracle', kind: 'family',
    family_members: ['Mira', 'Cle'], family_member_user_ids: ['u4', null],
    user_id: null,
  };

  it('starts collapsed and reveals only the creditor transfers in server order', async () => {
    const members = [INDIVIDUAL, RAHUL_1, RAHUL_2, MIRACLE_FAMILY];
    const renderer = await mountTrip({
      trip: { members, user_ids: ['u1', 'u2', 'u3', 'u4'] },
      balances: {
        net: { m1: 1_750, 'rahul-1': -1_325, 'rahul-2': 75, 'miracle-family': -500 },
        members,
        transfers: [
          { from_member_id: 'rahul-1', to_member_id: 'm1', amount: 1_250 },
          { from_member_id: 'miracle-family', to_member_id: 'm1', amount: 500 },
          { from_member_id: 'rahul-1', to_member_id: 'rahul-2', amount: 75 },
        ],
      },
    });

    let toggle = interactiveByTestID(renderer.root, 'trip-payment-details-toggle');
    expect(toggle.props).toEqual(expect.objectContaining({
      accessibilityLabel: 'View payment details',
      accessibilityState: { expanded: false },
    }));
    expect(StyleSheet.flatten(toggle.props.style)).toEqual(expect.objectContaining({
      width: '100%', minHeight: COMPONENT_SIZE.minTouchTarget,
    }));
    expect(toggle.findAllByType('Icon' as any).at(-1).props.name).toBe('chevron-right');
    expect(hostByTestID(renderer.root, 'View', 'trip-payment-details')).toBeUndefined();

    act(() => toggle.props.onPress());

    toggle = interactiveByTestID(renderer.root, 'trip-payment-details-toggle');
    expect(toggle.props.accessibilityLabel).toBe('Hide payment details');
    expect(toggle.props.accessibilityState).toEqual({ expanded: true });
    const toggleIcon = toggle.findAllByType('Icon' as any).at(-1);
    expect(toggleIcon.props.name).toBe('chevron-down');

    const details = hostByTestID(renderer.root, 'View', 'trip-payment-details');
    const rows = [0, 1].map((index) => (
      hostByTestID(details, 'View', `trip-payment-details-transfer-${index}`)
    ));
    expect(details).toBeTruthy();
    expect(hostByTestID(details, 'View', 'trip-payment-details-transfer-2')).toBeUndefined();
    expect(textContent(rows[0])).toBe('Rahul_1 pays Aditi');
    expect(textContent(rows[1])).toBe('Miracle (Family) pays Aditi');
    expect(rows.map((row) => row.findByType('ResponsiveAmountText' as any).props.value))
      .toEqual([1_250, 500]);
    expect(rows[0].findByType('ResponsiveAmountText' as any).props.style)
      .toEqual(expect.objectContaining({ fontFamily: FONTS.number }));
    const sentence = rows[0].findAllByType('T' as any)
      .find((node: any) => textContent(node) === 'Rahul_1 pays Aditi');
    expect(sentence?.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(sentence?.props.style)).toEqual(expect.objectContaining({
      flex: 1, minWidth: 0,
    }));
    expect(rows[0].findAllByType('T' as any).find((node: any) => textContent(node) === 'Rahul_1')?.props.color)
      .toBe('#ff8a66');
    expect(rows[0].findAllByType('T' as any).find((node: any) => textContent(node) === 'Aditi')?.props.color)
      .toBe('#8fc98f');
    expect(rows[0].findAll((node: any) => typeof node.props.onPress === 'function'))
      .toHaveLength(0);

    act(() => toggle.props.onPress());
    expect(hostByTestID(renderer.root, 'View', 'trip-payment-details')).toBeUndefined();
    expect(interactiveByTestID(renderer.root, 'trip-payment-details-toggle').props.accessibilityState)
      .toEqual({ expanded: false });
  });

  it('shows one authoritative outgoing instruction for a debtor', async () => {
    const members = [INDIVIDUAL, RAHUL_1];
    const renderer = await mountTrip({
      trip: { members, user_ids: ['u1', 'u2'] },
      balances: {
        net: { m1: -320, 'rahul-1': 320 }, members,
        transfers: [{ from_member_id: 'm1', to_member_id: 'rahul-1', amount: 320 }],
      },
    });

    expect(hostByTestID(renderer.root, 'ResponsiveAmountText', 'trip-my-balance').props.value)
      .toBe(-320);
    act(() => interactiveByTestID(renderer.root, 'trip-payment-details-toggle').props.onPress());
    const row = hostByTestID(
      renderer.root, 'View', 'trip-payment-details-transfer-0',
    );
    expect(textContent(row)).toBe('Aditi pays Rahul');
    expect(row.findByType('ResponsiveAmountText' as any).props).toEqual(expect.objectContaining({
      value: 320, showCurrency: false,
    }));
  });

  it('uses the whole family entity for a family-linked user', async () => {
    mockUser = { id: 'family-user', email: 'family@gmail.com', is_super_admin: false };
    const family = {
      id: 'family', name: 'Shah', kind: 'family', user_id: null,
      family_members: ['Mina', 'Ravi'],
      family_member_ids: ['mina', 'ravi'],
      family_member_user_ids: ['family-user', null],
    };
    const receiver = {
      id: 'receiver', name: 'Miracle', kind: 'individual', family_members: [], user_id: 'u2',
    };
    const members = [family, receiver];
    const renderer = await mountTrip({
      trip: { members, user_ids: ['family-user', 'u2'] },
      balances: {
        net: { family: -900, receiver: 900 }, members,
        per_person: [{
          member_id: 'family', member_name: 'Shah', kind: 'family', people_count: 2,
          net_total: -900, net_per_person: -450, family_members: ['Mina', 'Ravi'],
          members: [{ id: 'mina', name: 'Mina', net: -100 }, { id: 'ravi', name: 'Ravi', net: -800 }],
        }],
        transfers: [{ from_member_id: 'family', to_member_id: 'receiver', amount: 900 }],
      },
    });

    const balance = hostByTestID(renderer.root, 'ResponsiveAmountText', 'trip-my-balance');
    expect(balance.props.value).toBe(-900);
    const personalCard = balance.parent.parent;
    expect(personalCard.findAllByType('T' as any).map(textContent).join(' '))
      .toContain('Shah (Family)');

    act(() => interactiveByTestID(renderer.root, 'trip-payment-details-toggle').props.onPress());
    const row = hostByTestID(renderer.root, 'View', 'trip-payment-details-transfer-0');
    expect(textContent(row)).toBe('Shah (Family) pays Miracle');
    expect(row.findByType('ResponsiveAmountText' as any).props.value).toBe(900);
  });

  it('hides the control when the signed-in entity is settled', async () => {
    const renderer = await mountTrip({
      balances: { net: { m1: 0 }, transfers: [] },
    });

    expect(hostByTestID(renderer.root, 'ResponsiveAmountText', 'trip-my-balance').props.value)
      .toBe(0);
    expect(interactiveByTestID(renderer.root, 'trip-payment-details-toggle')).toBeUndefined();
  });

  it('collapses the disclosure when the trip id changes', async () => {
    const members = [INDIVIDUAL, RAHUL_1];
    const renderer = await mountTrip({
      trip: { members, user_ids: ['u1', 'u2'] },
      balances: {
        net: { m1: -20, 'rahul-1': 20 }, members,
        transfers: [{ from_member_id: 'm1', to_member_id: 'rahul-1', amount: 20 }],
      },
    });
    act(() => interactiveByTestID(renderer.root, 'trip-payment-details-toggle').props.onPress());
    expect(hostByTestID(renderer.root, 'View', 'trip-payment-details')).toBeTruthy();

    await act(async () => {
      mockSearchParams = { id: 't2' };
      renderer.update(<TripDetail />);
    });

    expect(interactiveByTestID(renderer.root, 'trip-payment-details-toggle').props.accessibilityState)
      .toEqual({ expanded: false });
    expect(hostByTestID(renderer.root, 'View', 'trip-payment-details')).toBeUndefined();
  });
});

describe('Member mobile contacts', () => {
  const contactMembers = [
    {
      ...INDIVIDUAL,
      mobile_number: '+919876543210',
      email: 'aditi@gmail.com',
    },
    {
      id: 'manual', name: 'Manual guest', kind: 'individual', family_members: [],
      user_id: null, mobile_number: null,
    },
    {
      id: 'fam', name: 'Shah family', kind: 'family',
      family_members: ['Mina', 'Ravi'],
      family_member_ids: ['fm1', 'fm2'],
      family_member_emails: ['mina@gmail.com', null],
      family_member_user_ids: ['u2', null],
      family_member_mobile_numbers: ['+14155552671', null],
      user_id: null,
    },
  ];

  async function openMembers() {
    const renderer = await mountTrip({
      trip: { members: contactMembers, user_ids: ['u1', 'u2'] },
    });
    act(() => renderer.root.findByType('SegmentedControl' as any).props.onChange('members'));
    return renderer;
  }

  it('renders only populated linked individual and aligned family numbers', async () => {
    const renderer = await openMembers();

    expect(renderer.root.findByProps({ testID: 'trip-membership-card-stub' }).props.tripId)
      .toBe('t1');
    expect(hostsByTestID(renderer.root, 'member-mobile-m1')).toHaveLength(1);
    expect(hostsByTestID(renderer.root, 'member-mobile-manual')).toHaveLength(0);
    expect(hostsByTestID(renderer.root, 'member-mobile-fm1')).toHaveLength(1);
    expect(hostsByTestID(renderer.root, 'member-mobile-fm2')).toHaveLength(0);

    const familyPerson = renderer.root.findByProps({ testID: 'member-fam-sub-0' });
    const familyText = familyPerson.findAllByType('T' as any).map(textContent).join(' ');
    expect(familyText).toContain('mina@gmail.com');
    expect(familyText).toContain('+1 415 555 2671');
  });

  it('opens one action sheet and supports calling or copying the canonical number', async () => {
    const canOpen = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as any);
    const renderer = await openMembers();

    act(() => interactiveByTestID(renderer.root, 'member-mobile-m1').props.onPress());
    let sheet = renderer.root.findByProps({ testID: 'member-mobile-actions' });
    expect(sheet.props.visible).toBe(true);
    expect(sheet.props.title).toBe('Contact Aditi');
    expect(sheet.props.message).toBe('+91 98765 43210');

    await act(async () => {
      sheet.props.actions.find((action: any) => action.label === 'Call').onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(canOpen).toHaveBeenCalledWith('tel:+919876543210');
    expect(open).toHaveBeenCalledWith('tel:+919876543210');

    act(() => interactiveByTestID(renderer.root, 'member-mobile-fm1').props.onPress());
    sheet = renderer.root.findByProps({ testID: 'member-mobile-actions' });
    await act(async () => {
      sheet.props.actions.find((action: any) => action.label === 'Copy number').onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockSetStringAsync).toHaveBeenCalledWith('+14155552671');
    expect(mockToastShow).toHaveBeenCalledWith('Mobile number copied', 'success');

    canOpen.mockRestore();
    open.mockRestore();
  });

  it('gives specific feedback for unsupported calls and clipboard failures', async () => {
    const canOpen = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    mockSetStringAsync.mockRejectedValueOnce(new Error('clipboard unavailable'));
    const renderer = await openMembers();

    act(() => interactiveByTestID(renderer.root, 'member-mobile-m1').props.onPress());
    let sheet = renderer.root.findByProps({ testID: 'member-mobile-actions' });
    await act(async () => {
      sheet.props.actions.find((action: any) => action.label === 'Call').onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockToastShow)
      .toHaveBeenCalledWith('Calling is not supported on this device.', 'error');

    act(() => interactiveByTestID(renderer.root, 'member-mobile-m1').props.onPress());
    sheet = renderer.root.findByProps({ testID: 'member-mobile-actions' });
    await act(async () => {
      sheet.props.actions.find((action: any) => action.label === 'Copy number').onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockToastShow)
      .toHaveBeenCalledWith('Could not copy mobile number. Try again.', 'error');

    canOpen.mockRestore();
  });
});

describe('Trip identity header', () => {
  it('contains only identity information and reserves no financial row or fixed height', async () => {
    const longCode = 'UCK3RZ-LOCALIZED-SHARING-CODE-2026';
    const longName = 'Lakshadweep family reunion and island-hopping expedition';
    const family = {
      id: 'family', name: 'Extended Family', kind: 'family',
      family_members: Array.from({ length: 17 }, (_, index) => `Person ${index + 1}`),
    };
    const renderer = await mountTrip({
      trip: { name: longName, code: longCode, members: [family, INDIVIDUAL] },
    });
    const header = hostByTestID(renderer.root, 'Card', 'trip-identity-header');
    expect(header).toBeTruthy();
    expect(header.props).toEqual(expect.objectContaining({ padding: 'lg', radius: RADIUS.xl }));
    expect(header.props.style).toBeUndefined();
    expect(header.findAll((node: any) => (
      node.props.testID === 'trip-spent-amount' || node.props.testID === 'trip-budget-amount'
    ))).toHaveLength(0);

    const headerText = header.findAllByType('T' as any).map(textContent).join(' ');
    expect(headerText).toContain('12/11/2026');
    expect(headerText).toContain(longCode);
    expect(headerText).toContain(longName);
    expect(headerText).toContain('18 Individuals across 1 Family & 1 Single');
    expect(headerText).not.toMatch(/\bspent\b/i);
    expect(headerText).not.toMatch(/\bbudget\b/i);

    const share = hostByTestID(header, 'TouchableOpacity', 'trip-share')
      ?? header.findAll((node: any) => node.props.testID === 'trip-share').at(-1);
    expect(share.props.accessibilityLabel).toBe(`Share trip code ${longCode}`);
    expect(StyleSheet.flatten(share.props.style)).toEqual(expect.objectContaining({
      minHeight: COMPONENT_SIZE.minTouchTarget,
      maxWidth: '100%',
    }));

    for (const testID of ['trip-date-range', 'trip-name', 'trip-participant-summary']) {
      const text = hostByTestID(header, 'T', testID);
      expect(text).toBeTruthy();
      expect(text.props.numberOfLines).toBeUndefined();
    }
    const codeText = header.findAllByType('T' as any).find((node: any) => textContent(node) === longCode);
    expect(codeText?.props.numberOfLines).toBeUndefined();

    expect(hostByTestID(renderer.root, 'Card', 'trip-budget-used-card')).toBeTruthy();
  });

  it('refreshes rollout state and shares a secure URL for a regular trip member', async () => {
    mockInviteLinksEnabled = true;
    mockRole = 'member';
    mockRefreshRuntimeConfig.mockResolvedValue({ inviteLinksEnabled: true });
    const url = `https://tripsplitter-web.vercel.app/invite/${'a'.repeat(43)}`;
    mockGetTripInviteLink.mockResolvedValue({ url });
    const nativeShare = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const renderer = await mountTrip();
    const share = renderer.root.findAll((node: any) => (
      node.props.testID === 'trip-share' && typeof node.props.onPress === 'function'
    ))[0];

    await act(async () => { await share.props.onPress(); });

    expect(mockRefreshRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(mockGetTripInviteLink).toHaveBeenCalledWith('t1');
    expect(nativeShare).toHaveBeenCalledWith({
      message: 'You have been invited to join the trip "Lakshadweep" on Trip Splitter.\n\n'
        + `Open the invitation link:\n${url}\n\n`
        + 'Trip code: UCK3RZ\n'
        + 'You can also enter this code in Trip Splitter to join manually.\n\n'
        + 'Download Trip Splitter for Android:\n'
        + `${APK_DOWNLOAD_URL}\n\n`
        + 'A trip admin can reset this private invitation link at any time.',
    });
    nativeShare.mockRestore();
  });

  it('falls back to the trip code if the stable link cannot be loaded', async () => {
    mockInviteLinksEnabled = true;
    mockRole = 'member';
    mockRefreshRuntimeConfig.mockResolvedValue({ inviteLinksEnabled: true });
    mockGetTripInviteLink.mockRejectedValue(new Error('offline'));
    const nativeShare = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const renderer = await mountTrip();
    const share = renderer.root.findAll((node: any) => (
      node.props.testID === 'trip-share' && typeof node.props.onPress === 'function'
    ))[0];

    await act(async () => { await share.props.onPress(); });

    expect(mockGetTripInviteLink).toHaveBeenCalledTimes(1);
    expect(nativeShare).toHaveBeenCalledTimes(1);
    expect(nativeShare).toHaveBeenCalledWith({ message: CODE_FALLBACK_MESSAGE });
    expect(mockToastShow).toHaveBeenCalledWith(
      'Could not load the trip link: offline. Sharing the trip code instead.',
      'error',
    );
    nativeShare.mockRestore();
  });

  it('uses the code and Android APK fallback while secure links are disabled', async () => {
    mockRole = 'member';
    mockRefreshRuntimeConfig.mockResolvedValue({ inviteLinksEnabled: false });
    const nativeShare = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const renderer = await mountTrip();
    const share = renderer.root.findAll((node: any) => (
      node.props.testID === 'trip-share' && typeof node.props.onPress === 'function'
    ))[0];

    await act(async () => { await share.props.onPress(); });

    expect(mockGetTripInviteLink).not.toHaveBeenCalled();
    expect(nativeShare).toHaveBeenCalledWith({ message: CODE_FALLBACK_MESSAGE });
    expect(mockToastShow).toHaveBeenCalledWith(
      'Secure invite links are not live yet. Sharing the trip code instead.',
      'info',
    );
    nativeShare.mockRestore();
  });

  it('clearly falls back to the trip code if runtime config is offline', async () => {
    mockRole = 'member';
    mockRefreshRuntimeConfig.mockRejectedValue(new Error('offline'));
    const nativeShare = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const renderer = await mountTrip();
    const share = renderer.root.findAll((node: any) => (
      node.props.testID === 'trip-share' && typeof node.props.onPress === 'function'
    ))[0];

    await act(async () => { await share.props.onPress(); });

    expect(mockGetTripInviteLink).not.toHaveBeenCalled();
    expect(nativeShare).toHaveBeenCalledWith({
      message: CODE_FALLBACK_MESSAGE,
    });
    expect(mockToastShow).toHaveBeenCalledWith(
      'Could not check secure-link availability. Sharing the trip code instead.',
      'error',
    );
    nativeShare.mockRestore();
  });

  it('does not open a fallback share when the secure share sheet is cancelled', async () => {
    mockInviteLinksEnabled = true;
    mockRole = 'member';
    mockRefreshRuntimeConfig.mockResolvedValue({ inviteLinksEnabled: true });
    const url = `https://tripsplitter-web.vercel.app/invite/${'c'.repeat(43)}`;
    mockGetTripInviteLink.mockResolvedValue({ url });
    const nativeShare = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction });
    const renderer = await mountTrip();
    const share = renderer.root.findAll((node: any) => (
      node.props.testID === 'trip-share' && typeof node.props.onPress === 'function'
    ))[0];

    await act(async () => { await share.props.onPress(); });

    expect(nativeShare).toHaveBeenCalledTimes(1);
    expect(nativeShare.mock.calls[0][0].message).toContain(url);
    expect(mockToastShow).not.toHaveBeenCalled();
    nativeShare.mockRestore();
  });

  it('keeps action behavior, adaptive tabs, and 48 dp icon actions intact', async () => {
    const renderer = await mountTrip();
    const add = hostByTestID(renderer.root, 'Button', 'trip-add-expense');
    const settle = hostByTestID(renderer.root, 'Button', 'trip-settle-up');
    const edit = hostByTestID(renderer.root, 'IconButton', 'trip-edit');
    const tabs = renderer.root.findByType('SegmentedControl' as any);

    expect(StyleSheet.flatten(add.props.style).minHeight).toBe(COMPONENT_SIZE.minTouchTarget);
    expect(StyleSheet.flatten(settle.props.style).minHeight).toBe(COMPONENT_SIZE.minTouchTarget);
    expect(edit.props).toEqual(expect.objectContaining({
      accessibilityLabel: 'Edit trip',
      touchSize: COMPONENT_SIZE.minTouchTarget,
    }));
    expect(tabs.props).toEqual(expect.objectContaining({ layout: 'adaptive', testIDPrefix: 'trip-tab' }));

    act(() => add.props.onPress());
    act(() => settle.props.onPress());
    act(() => edit.props.onPress());
    expect(mockRouterPush.mock.calls.map(([path]) => path)).toEqual([
      '/trip/t1/add-expense',
      '/trip/t1/settle-up',
      '/trip/t1/edit',
    ]);

    const safeArea = renderer.root.findByType('SafeAreaView' as any);
    expect(safeArea.props.edges).toEqual(['bottom', 'left', 'right']);
  });

  it('labels admin maintenance and requires the trimmed lowercase trip name', async () => {
    mockUser = {
      id: 'application-admin',
      email: 'jyotirmaysingh03@gmail.com',
      is_super_admin: true,
    };
    const renderer = await mountTrip({
      trip: {
        owner_id: 'owner-2',
        admin_ids: ['owner-2'],
        user_ids: ['owner-2'],
        members: [{ ...INDIVIDUAL, user_id: 'owner-2' }],
      },
    });

    const strip = hostByTestID(renderer.root, 'Card', 'trip-privileged-mode');
    expect(strip).toBeTruthy();
    expect(strip.findAllByType('T' as any).map(textContent).join(' '))
      .toContain('expenses and balances do not affect your account');
    expect(renderer.root.findAll((node: any) => node.props.testID === 'trip-my-balance'))
      .toHaveLength(0);
    expect(renderer.root.findAll((node: any) => node.props.testID === 'trip-payment-details-toggle'))
      .toHaveLength(0);

    act(() => hostByTestID(renderer.root, 'IconButton', 'trip-delete').props.onPress());
    let modal = renderer.root.findByType('ConfirmModal' as any);
    expect(modal.props.textInput).toEqual(expect.objectContaining({
      value: '',
      label: 'Type “lakshadweep” to confirm',
      placeholder: 'lakshadweep',
      testID: 'trip-delete-name',
    }));
    expect(modal.props.actions[1].disabled).toBe(true);

    act(() => modal.props.textInput.onChangeText('Lakshadweep'));
    modal = renderer.root.findByType('ConfirmModal' as any);
    expect(modal.props.actions[1].disabled).toBe(true);

    act(() => modal.props.textInput.onChangeText('  lakshadweep  '));
    modal = renderer.root.findByType('ConfirmModal' as any);
    expect(modal.props.actions[1].disabled).toBe(false);
  });
});

describe('Budget Used card', () => {
  it('uses one exact representation below budget', async () => {
    const renderer = await mountTrip({ expenses: [expense(60_000), expense(-10_000, 'refund')] });
    const spent = hostByTestID(renderer.root, 'T', 'trip-budget-used-spent');
    const total = hostByTestID(renderer.root, 'T', 'trip-budget-used-total');
    const progress = hostByTestID(renderer.root, 'ProgressBar', 'trip-budget-progress');

    expect(textContent(spent)).toBe('₹50,000');
    expect(textContent(total)).toBe('₹100,000');
    expect(`${textContent(spent)} ${textContent(total)}`).not.toMatch(/[KMBT]\b/);
    expect(progress.props.progress).toBe(0.5);
    expect(progress.props.accessibilityValueText).toBe('INR 50,000 of INR 100,000');
    expect(hostByTestID(renderer.root, 'T', 'trip-budget-overage')).toBeUndefined();
  });

  it('distinguishes exactly-at-budget from over-budget without relying on colour alone', async () => {
    const exactRenderer = await mountTrip({ expenses: [expense(100_000)] });
    const exactProgress = hostByTestID(exactRenderer.root, 'ProgressBar', 'trip-budget-progress');
    expect(exactProgress.props.progress).toBe(1);
    expect(hostByTestID(exactRenderer.root, 'View', 'trip-budget-overage')).toBeUndefined();

    const overRenderer = await mountTrip({
      expenses: [expense(202_899), expense(-50_000, 'refund')],
    });
    const overSpent = hostByTestID(overRenderer.root, 'T', 'trip-budget-used-spent');
    const overTotal = hostByTestID(overRenderer.root, 'T', 'trip-budget-used-total');
    const overProgress = hostByTestID(overRenderer.root, 'ProgressBar', 'trip-budget-progress');
    const overage = overRenderer.root.findAll((node: any) => node.props.testID === 'trip-budget-overage').at(-1);

    expect(textContent(overSpent)).toBe('₹152,899');
    expect(textContent(overTotal)).toBe('₹100,000');
    expect(overProgress.props.progress).toBeCloseTo(1.52899);
    expect(overProgress.props.accessibilityValueText).toBe(
      'INR 152,899 of INR 100,000; INR 52,899 over budget',
    );
    expect(overage.findAllByType('T' as any).map(textContent).join(' ')).toContain(
      '₹52,899 over budget',
    );
    expect(overSpent.props.color).toBe('#ff8a66');
    expect(overTotal.props.color).toBe('#ff8a66');
  });

  it.each([
    [undefined, 'No budget set'],
    [null, 'No budget set'],
    [0, 'No budget set'],
    [-1, 'Budget usage unavailable'],
    [Number.NaN, 'Budget usage unavailable'],
  ])('handles budget %p without a misleading progress indicator', async (budget, state) => {
    const renderer = await mountTrip({ budget, expenses: [expense(50_000)] });
    const card = hostByTestID(renderer.root, 'Card', 'trip-budget-used-card');
    const spent = hostByTestID(card, 'T', 'trip-budget-used-spent');
    const stateText = hostByTestID(card, 'T', 'trip-budget-used-state');

    expect(textContent(spent)).toBe('₹50,000 spent');
    expect(textContent(stateText)).toBe(state);
    expect(card.findAllByType('ProgressBar' as any)).toHaveLength(0);
  });

  it('keeps very large exact amounts wrap-capable instead of compacting or truncating', async () => {
    const renderer = await mountTrip({
      budget: 9_876_543_210.98,
      expenses: [expense(123_456_789.12)],
    });
    const spent = hostByTestID(renderer.root, 'T', 'trip-budget-used-spent');
    const total = hostByTestID(renderer.root, 'T', 'trip-budget-used-total');

    expect(textContent(spent)).toBe('₹123,456,789');
    expect(textContent(total)).toBe('₹9,876,543,211');
    expect(spent.props.numberOfLines).toBeUndefined();
    expect(total.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(spent.props.style)).toEqual(expect.objectContaining({
      maxWidth: '100%', flexShrink: 1, minWidth: 0,
    }));
  });

  it('supports negative net spend and rejects a non-finite aggregate presentation', async () => {
    const negativeRenderer = await mountTrip({ budget: 100, expenses: [expense(-50)] });
    expect(textContent(hostByTestID(negativeRenderer.root, 'T', 'trip-budget-used-spent')))
      .toBe('-₹50');
    expect(hostByTestID(negativeRenderer.root, 'ProgressBar', 'trip-budget-progress').props.progress)
      .toBe(-0.5);

    const invalidRenderer = await mountTrip({ budget: 100, expenses: [expense(Number.POSITIVE_INFINITY)] });
    const invalidCard = hostByTestID(invalidRenderer.root, 'Card', 'trip-budget-used-card');
    expect(textContent(hostByTestID(invalidCard, 'T', 'trip-budget-used-state')))
      .toBe('Budget usage unavailable');
    expect(invalidCard.findAllByType('ProgressBar' as any)).toHaveLength(0);
  });

  it('keeps the Summary rhythm on shared spacing tokens', async () => {
    const renderer = await mountTrip();
    const card = hostByTestID(renderer.root, 'Card', 'trip-budget-used-card');
    const content = card.findAll((node: any) => (
      StyleSheet.flatten(node.props.style)?.gap === SPACING.sm
    ));
    expect(content.length).toBeGreaterThan(0);
  });
});
