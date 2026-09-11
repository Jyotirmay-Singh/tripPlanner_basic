/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetDetails = jest.fn();
const mockPreview = jest.fn();
const mockDiscover = jest.fn();
const mockCopy = jest.fn();
const mockCopyAndLaunch = jest.fn();

class MockApiError extends Error {
  detailCode?: string;
  data?: unknown;
}

const googlePay = {
  id: 'google-pay' as const,
  label: 'Google Pay',
  packageName: 'com.google.android.apps.nbu.paisa.user',
  launchUri: 'intent://#Intent;package=com.google.android.apps.nbu.paisa.user;end',
};
const phonePe = {
  id: 'phonepe' as const,
  label: 'PhonePe',
  packageName: 'com.phonepe.app',
  launchUri: 'intent://#Intent;package=com.phonepe.app;end',
};

jest.mock('../api', () => ({
  ApiError: MockApiError,
  getPaymentRecipientDetails: (...args: unknown[]) => mockGetDetails(...args),
  previewPaymentHandoff: (...args: unknown[]) => mockPreview(...args),
}));

jest.mock('../upiLauncher', () => ({
  discoverUpiApps: (...args: unknown[]) => mockDiscover(...args),
  copyUpiId: (...args: unknown[]) => mockCopy(...args),
  copyAndLaunchUpiApp: (...args: unknown[]) => mockCopyAndLaunch(...args),
}));

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});

jest.mock('../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    __esModule: true,
    AmountText: stub('AmountText'),
    Button: stub('Button'),
    Card: stub('Card'),
    Icon: stub('Icon'),
    Input: stub('Input'),
    Sheet: (props: any) => R.createElement('Sheet', props, props.visible ? props.children : null),
  };
});

import UpiPaymentSheet from '../UpiPaymentSheet';
import type { PaymentHandoffPreview, PaymentRecipientCandidate } from '../payments';

const candidate = (
  personId: string,
  name: string,
  overrides: Partial<PaymentRecipientCandidate> = {},
): PaymentRecipientCandidate => ({
  person_id: personId,
  name,
  family_id: null,
  family_name: null,
  account_linked: true,
  upi_id: `${personId}@upi`,
  upi_updated_at: '2026-09-11T10:00:00+00:00',
  ...overrides,
});

const details = (recipients: PaymentRecipientCandidate[]) => ({
  trip_id: 'trip-1',
  from_member_id: 'payer',
  to_member_id: 'recipient',
  recipients,
});

const preview = (
  recipients: PaymentRecipientCandidate[],
  overrides: Partial<PaymentHandoffPreview> = {},
): PaymentHandoffPreview => ({
  trip_id: 'trip-1',
  trip_name: 'Goa Weekend',
  from_member_id: 'payer',
  from_name: 'Payer Person',
  to_member_id: 'recipient',
  to_name: 'Recipient Family',
  source_amount: '50.00',
  source_currency: 'USD',
  current_payable: '50.00',
  inr_amount: '4172.84',
  quote: {
    quote_id: 'quote-1',
    rate: '83.4567',
    effective_rate_date: '2026-09-10',
    provider: 'frankfurter_v2_blended',
    stale: false,
    expires_at: '2026-09-11T10:30:00+00:00',
  },
  recipients,
  ...overrides,
});

const props = {
  visible: true,
  tripId: 'trip-1',
  tripName: 'Goa Weekend',
  fromMemberId: 'payer',
  fromName: 'Payer Person',
  toMemberId: 'recipient',
  toName: 'Recipient Family',
  initialAmount: 50,
  currency: 'USD',
  wholeUnit: false,
  onClose: jest.fn(),
};

const nodes = (renderer: any, testID: string) => (
  renderer.root.findAll((item: any) => typeof item.type === 'string' && item.props?.testID === testID)
);
const node = (renderer: any, testID: string) => nodes(renderer, testID)[0];
const interactive = (renderer: any, testID: string) => (
  renderer.root.find((item: any) => item.props?.testID === testID && typeof item.props.onPress === 'function')
);
const buttons = (renderer: any) => (
  renderer.root.findAll((item: any) => item.type === 'Button')
);
const button = (renderer: any, label: string) => (
  buttons(renderer).find((item: any) => item.props.label === label)!
);

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<UpiPaymentSheet {...props} />);
  });
  await flush();
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDiscover.mockResolvedValue({
    status: 'available', platform: 'android', apps: [googlePay, phonePe],
  });
  mockCopy.mockResolvedValue({ ok: true, status: 'copied' });
  mockCopyAndLaunch.mockResolvedValue({
    ok: true, status: 'launched', copied: true, app: googlePay,
  });
});

it('lists only UPI-enabled family people and requires an explicit multi-person choice', async () => {
  const one = candidate('one', 'One', { family_id: 'recipient', family_name: 'Family' });
  const two = candidate('two', 'Two', { family_id: 'recipient', family_name: 'Family' });
  const unavailable = candidate('three', 'Three', {
    family_id: 'recipient', family_name: 'Family', account_linked: false, upi_id: null,
  });
  mockGetDetails.mockResolvedValue(details([one, unavailable, two]));
  mockPreview.mockResolvedValue(preview([one, unavailable, two]));
  const renderer = await mount();

  expect(nodes(renderer, 'upi-recipient-one')).toHaveLength(1);
  expect(nodes(renderer, 'upi-recipient-two')).toHaveLength(1);
  expect(nodes(renderer, 'upi-recipient-three')).toHaveLength(0);
  expect(node(renderer, 'upi-review-payment').props.disabled).toBe(true);

  act(() => { interactive(renderer, 'upi-recipient-two').props.onPress(); });
  expect(node(renderer, 'upi-review-payment').props.disabled).toBe(false);
  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();

  expect(node(renderer, 'upi-reviewed-recipient').props.children).toBe('Two');
  expect(node(renderer, 'upi-reviewed-id').props.children).toBe('two@upi');
  expect(nodes(renderer, 'upi-approved-actions')).toHaveLength(0);
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  expect(nodes(renderer, 'upi-approved-actions')).toHaveLength(1);
  expect(button(renderer, 'Copy UPI ID and open Google Pay').props.variant).toBe('primary');
  expect(button(renderer, 'Copy UPI ID and open PhonePe').props.variant).toBe('secondary');
  expect(button(renderer, 'Copy UPI ID')).toBeTruthy();
});

it.each([
  ['individual', candidate('person', 'Recipient Person')],
  ['one available family person', candidate('family-person', 'Only Person', {
    family_id: 'recipient', family_name: 'Recipient Family',
  })],
])('auto-selects and visibly reviews %s', async (_label, recipient) => {
  mockGetDetails.mockResolvedValue(details([recipient]));
  mockPreview.mockResolvedValue(preview([recipient]));
  const renderer = await mount();

  expect(node(renderer, `upi-recipient-${recipient.person_id}`).props.accessibilityState.checked)
    .toBe(true);
  expect(node(renderer, 'upi-review-payment').props.disabled).toBe(false);
});

it.each([
  [candidate('unlinked', 'Unlinked Person', { account_linked: false, upi_id: null })],
  [candidate('no-upi', 'No UPI Person', { upi_id: null })],
])('shows only Close when no recipient has a usable UPI ID', async (recipient) => {
  mockGetDetails.mockResolvedValue(details([recipient]));
  const renderer = await mount();

  expect(nodes(renderer, 'upi-no-recipient')).toHaveLength(1);
  expect(nodes(renderer, 'upi-handoff-amount')).toHaveLength(0);
  expect(nodes(renderer, 'upi-review-payment')).toHaveLength(0);
  expect(buttons(renderer).map((item: any) => item.props.label)).toEqual(['Close']);
});

it('requires both approval and an explicit stale-rate acknowledgement', async () => {
  const recipient = candidate('person', 'Recipient Person');
  mockGetDetails.mockResolvedValue(details([recipient]));
  mockPreview.mockResolvedValue(preview([recipient], {
    quote: { ...preview([recipient]).quote, stale: true },
  }));
  const renderer = await mount();

  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();
  expect(nodes(renderer, 'upi-stale-warning')).toHaveLength(1);
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  expect(nodes(renderer, 'upi-approved-actions')).toHaveLength(0);
  act(() => { interactive(renderer, 'upi-acknowledge-stale').props.onPress(); });
  expect(nodes(renderer, 'upi-approved-actions')).toHaveLength(1);
});

it('revalidates the recipient and forces review when the UPI ID or revision changed', async () => {
  const original = candidate('person', 'Recipient Person');
  const changed = candidate('person', 'Recipient Person', {
    upi_id: 'fresh@upi',
    upi_updated_at: '2026-09-11T11:00:00+00:00',
  });
  mockGetDetails.mockResolvedValue(details([original]));
  mockPreview
    .mockResolvedValueOnce(preview([original]))
    .mockResolvedValueOnce(preview([changed]));
  const renderer = await mount();

  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  await act(async () => { interactive(renderer, 'upi-copy-id').props.onPress(); });
  await flush();

  expect(mockPreview).toHaveBeenLastCalledWith('trip-1', expect.objectContaining({
    quote_id: 'quote-1', amount: '50.00',
  }));
  expect(mockCopy).not.toHaveBeenCalled();
  expect(node(renderer, 'upi-approve-details').props.accessibilityState.checked).toBe(false);
  expect(node(renderer, 'upi-reviewed-id').props.children).toBe('fresh@upi');
  expect(node(renderer, 'upi-action-notice').props.children).toBeTruthy();
  expect(nodes(renderer, 'upi-approved-actions')).toHaveLength(0);
});

it('uses reviewed copy-only behavior when discovery is unsupported', async () => {
  const recipient = candidate('person', 'Recipient Person');
  mockGetDetails.mockResolvedValue(details([recipient]));
  mockDiscover.mockResolvedValue({ status: 'unsupported', platform: 'web', apps: [] });
  mockPreview
    .mockResolvedValueOnce(preview([recipient]))
    .mockResolvedValueOnce(preview([recipient]));
  const renderer = await mount();

  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  expect(nodes(renderer, 'upi-copy-only-guidance')).toHaveLength(1);
  expect(nodes(renderer, 'upi-open-google-pay')).toHaveLength(0);

  await act(async () => { interactive(renderer, 'upi-copy-id').props.onPress(); });
  await flush();
  expect(mockCopy).toHaveBeenCalledWith('person@upi');
});

it('keeps the sheet open after app return and never records a payment', async () => {
  const recipient = candidate('person', 'Recipient Person');
  mockGetDetails.mockResolvedValue(details([recipient]));
  mockPreview
    .mockResolvedValueOnce(preview([recipient]))
    .mockResolvedValueOnce(preview([recipient]));
  const renderer = await mount();

  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  await act(async () => { interactive(renderer, 'upi-open-google-pay').props.onPress(); });
  await flush();

  expect(mockCopyAndLaunch).toHaveBeenCalledWith('person@upi', googlePay);
  expect(nodes(renderer, 'upi-payment-sheet')).toHaveLength(1);
  expect(nodes(renderer, 'upi-done')).toHaveLength(1);
  expect(node(renderer, 'upi-action-notice').props.children).toBeTruthy();
  expect(mockPreview).toHaveBeenCalledTimes(2);
});
