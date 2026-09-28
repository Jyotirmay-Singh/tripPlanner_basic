/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';

const mockGetDetails = jest.fn();
const mockPreview = jest.fn();
const mockCreateAttempt = jest.fn();
const mockUpdateSender = jest.fn();
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
};
const phonePe = {
  id: 'phonepe' as const,
  label: 'PhonePe',
  packageName: 'com.phonepe.app',
};

jest.mock('../api', () => ({
  ApiError: MockApiError,
  getPaymentRecipientDetails: (...args: unknown[]) => mockGetDetails(...args),
  previewPaymentHandoff: (...args: unknown[]) => mockPreview(...args),
  createPaymentAttempt: (...args: unknown[]) => mockCreateAttempt(...args),
  updatePaymentAttemptSender: (...args: unknown[]) => mockUpdateSender(...args),
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
import type {
  PaymentAttempt,
  PaymentHandoffPreview,
  PaymentRecipientCandidate,
} from '../payments';

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

const paymentAttempt = (overrides: Partial<PaymentAttempt> = {}): PaymentAttempt => ({
  id: 'attempt-1',
  quote_id: 'quote-1',
  trip_id: 'trip-1',
  from_member_id: 'payer',
  to_member_id: 'recipient',
  initiating_payer_user_id: 'payer-user',
  selected_recipient_person_id: 'person',
  selected_recipient_user_id: 'recipient-user',
  trip_name_snapshot: 'Goa Weekend',
  from_name_snapshot: 'Payer Person',
  to_name_snapshot: 'Recipient Family',
  initiating_payer_name_snapshot: 'Payer Person',
  selected_recipient_name_snapshot: 'Recipient Person',
  selected_recipient_family_name_snapshot: null,
  upi_id_snapshot: 'person@upi',
  upi_updated_at_snapshot: '2026-09-11T10:00:00+00:00',
  source_amount: '50.00',
  source_currency: 'USD',
  amount_paise: 417284,
  inr_amount: '4172.84',
  currency: 'INR',
  quote_rate_snapshot: '83.4567',
  quote_effective_rate_date_snapshot: '2026-09-10',
  quote_provider_snapshot: 'frankfurter_v2_blended',
  quote_stale_snapshot: false,
  quote_expires_at_snapshot: '2026-09-11T10:30:00+00:00',
  handoff_method: 'copy',
  transaction_reference: null,
  linked_payment_id: null,
  posted_amount: null,
  posted_currency: 'USD',
  status: 'initiated',
  reason: null,
  initiated_at: '2026-09-11T10:00:00+00:00',
  updated_at: '2026-09-11T10:00:00+00:00',
  expires_at: '2026-09-12T10:00:00+00:00',
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
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockDiscover.mockResolvedValue({
    status: 'available', platform: 'android', apps: [googlePay, phonePe],
  });
  mockCopy.mockResolvedValue({ ok: true, status: 'copied' });
  mockCopyAndLaunch.mockResolvedValue({
    ok: true, status: 'launched', copied: true, app: googlePay,
  });
  mockCreateAttempt.mockResolvedValue(paymentAttempt());
  mockUpdateSender.mockImplementation((_tripId, _attemptId, action) => Promise.resolve(
    paymentAttempt({
      status: action === 'cancel' ? 'canceled' : 'awaiting_confirmation',
      reason: action === 'cancel' ? 'payer_reported_not_paid' : 'payer_reported_paid',
    }),
  ));
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
  expect(mockCreateAttempt.mock.invocationCallOrder[0]).toBeLessThan(
    mockCopy.mock.invocationCallOrder[0],
  );
  expect(nodes(renderer, 'upi-sender-decision')).toHaveLength(1);
});

it('waits for app background and foreground before showing sender decisions', async () => {
  let stateListener: ((state: string) => void) | null = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event, listener) => {
    stateListener = listener as (state: string) => void;
    return { remove: jest.fn() };
  }) as typeof AppState.addEventListener);
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
  expect(nodes(renderer, 'upi-awaiting-app-return')).toHaveLength(1);
  expect(nodes(renderer, 'upi-sender-decision')).toHaveLength(0);
  act(() => { stateListener?.('background'); });
  act(() => { stateListener?.('active'); });
  expect(nodes(renderer, 'upi-sender-decision')).toHaveLength(1);
  expect(node(renderer, 'upi-action-notice').props.children).toBeTruthy();
  expect(mockPreview).toHaveBeenCalledTimes(2);
});

it('offers a no-background escape when a successful launch never backgrounds the app', async () => {
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

  expect(nodes(renderer, 'upi-awaiting-app-return')).toHaveLength(1);
  expect(nodes(renderer, 'upi-sender-decision')).toHaveLength(0);
  act(() => { interactive(renderer, 'upi-app-did-not-open').props.onPress(); });
  expect(nodes(renderer, 'upi-awaiting-app-return')).toHaveLength(0);
  expect(nodes(renderer, 'upi-sender-decision')).toHaveLength(1);
  expect(node(renderer, 'upi-report-paid').props.disabled).toBe(false);
  expect(renderer.root.findAllByType('T').map((item: any) => item.props.children)).toContain(
    'Continue manually, then report whether you paid. No balance has changed.',
  );
});

it('falls back to manual continuation when native launch fails after copying', async () => {
  const recipient = candidate('person', 'Recipient Person');
  mockGetDetails.mockResolvedValue(details([recipient]));
  mockPreview
    .mockResolvedValueOnce(preview([recipient]))
    .mockResolvedValueOnce(preview([recipient]));
  mockCopyAndLaunch.mockResolvedValueOnce({
    ok: false,
    status: 'launch_failed',
    copied: true,
    app: googlePay,
    message: 'Could not open Google Pay. The UPI ID was copied.',
  });
  const renderer = await mount();

  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  await act(async () => { interactive(renderer, 'upi-open-google-pay').props.onPress(); });
  await flush();

  expect(nodes(renderer, 'upi-awaiting-app-return')).toHaveLength(0);
  expect(nodes(renderer, 'upi-sender-decision')).toHaveLength(1);
  expect(node(renderer, 'upi-action-error').props.children).toContain('Could not open');
});

it('shows only a generic pending message for another payer-family account and never copies', async () => {
  const recipient = candidate('person', 'Recipient Person');
  mockGetDetails.mockResolvedValue(details([recipient]));
  mockPreview
    .mockResolvedValueOnce(preview([recipient]))
    .mockResolvedValueOnce(preview([recipient]));
  const conflict = new MockApiError('PRIVATE-REF must never reach the UI');
  conflict.detailCode = 'active_attempt_owned_by_another_payer';
  conflict.data = {
    detail: {
      code: 'active_attempt_owned_by_another_payer',
      message: 'A UPI payment is already pending for this payer and recipient',
      retryable: false,
    },
  };
  mockCreateAttempt.mockRejectedValueOnce(conflict);
  const renderer = await mount();

  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  await act(async () => { interactive(renderer, 'upi-open-google-pay').props.onPress(); });
  await flush();

  expect(mockCreateAttempt).toHaveBeenCalledTimes(1);
  expect(mockCopyAndLaunch).not.toHaveBeenCalled();
  expect(mockCopy).not.toHaveBeenCalled();
  expect(nodes(renderer, 'upi-attempt-attempt-1')).toHaveLength(0);
  expect(nodes(renderer, 'upi-action-error')).toHaveLength(0);
  expect(renderer.root.findAllByType('T').map((item: any) => item.props.children)).toContain(
    'A UPI payment is already pending. The initiating payer must resume it.',
  );
});

it('does not copy or launch when attempt persistence fails', async () => {
  const recipient = candidate('person', 'Recipient Person');
  mockGetDetails.mockResolvedValue(details([recipient]));
  mockPreview
    .mockResolvedValueOnce(preview([recipient]))
    .mockResolvedValueOnce(preview([recipient]));
  mockCreateAttempt.mockRejectedValueOnce(new Error('Could not save payment attempt'));
  const renderer = await mount();

  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  await act(async () => { interactive(renderer, 'upi-open-google-pay').props.onPress(); });
  await flush();

  expect(mockCreateAttempt).toHaveBeenCalledTimes(1);
  expect(mockCopyAndLaunch).not.toHaveBeenCalled();
  expect(nodes(renderer, 'upi-action-error')).toHaveLength(1);
});

it('keeps a copy-failed attempt resumable and lets the payer cancel it', async () => {
  const recipient = candidate('person', 'Recipient Person');
  mockGetDetails.mockResolvedValue(details([recipient]));
  mockPreview
    .mockResolvedValueOnce(preview([recipient]))
    .mockResolvedValueOnce(preview([recipient]));
  mockCopy.mockResolvedValueOnce({
    ok: false, status: 'clipboard_failed', message: 'Could not copy the UPI ID. Try again.',
  });
  const renderer = await mount();

  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  await act(async () => { interactive(renderer, 'upi-copy-id').props.onPress(); });
  await flush();

  expect(mockCreateAttempt).toHaveBeenCalledTimes(1);
  expect(mockCreateAttempt.mock.invocationCallOrder[0]).toBeLessThan(
    mockCopy.mock.invocationCallOrder[0],
  );
  expect(nodes(renderer, 'upi-attempt-attempt-1')).toHaveLength(1);
  expect(nodes(renderer, 'upi-copy-id')).toHaveLength(1);
  expect(nodes(renderer, 'upi-action-error')).toHaveLength(1);
  expect(nodes(renderer, 'upi-report-paid')).toHaveLength(0);
  expect(nodes(renderer, 'upi-not-paid')).toHaveLength(1);

  await act(async () => { interactive(renderer, 'upi-not-paid').props.onPress(); });
  await flush();
  expect(mockUpdateSender).toHaveBeenCalledWith(
    'trip-1', 'attempt-1', 'cancel',
  );
});

it('trims a payer reference and describes it as not bank verified', async () => {
  const recipient = candidate('person', 'Recipient Person');
  mockGetDetails.mockResolvedValue(details([recipient]));
  mockPreview
    .mockResolvedValueOnce(preview([recipient]))
    .mockResolvedValueOnce(preview([recipient]));
  const renderer = await mount();

  await act(async () => { interactive(renderer, 'upi-review-payment').props.onPress(); });
  await flush();
  act(() => { interactive(renderer, 'upi-approve-details').props.onPress(); });
  await act(async () => { interactive(renderer, 'upi-copy-id').props.onPress(); });
  await flush();
  const reference = node(renderer, 'upi-transaction-reference');
  expect(reference.props.helper).toContain('does not verify it with a bank');
  act(() => { reference.props.onChangeText('  UTR-123  '); });
  await act(async () => { interactive(renderer, 'upi-report-paid').props.onPress(); });
  await flush();

  expect(mockUpdateSender).toHaveBeenCalledWith(
    'trip-1', 'attempt-1', 'report_paid', 'UTR-123',
  );
  expect(nodes(renderer, 'upi-attempt-status')).toHaveLength(1);
});
