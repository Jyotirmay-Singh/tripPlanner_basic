/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Component test for the soft-gate banner (src/UnverifiedBanner.tsx): it renders only for a
// genuinely-unverified user (email_verified === false) and the resend action hits the endpoint.
const mockToast = { show: jest.fn() };
let mockUser: any = null;
const mockRefresh = jest.fn().mockResolvedValue(undefined);
let mockEmailFeaturesEnabled = true;
let mockReminderDismissed = false;
let mockSessionMode = 'online';
const mockDismissReminder = jest.fn(() => { mockReminderDismissed = true; });

jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({
  user: mockUser, refresh: mockRefresh, emailFeaturesEnabled: mockEmailFeaturesEnabled,
  verificationReminderDismissed: mockReminderDismissed, dismissVerificationReminder: mockDismissReminder,
  sessionMode: mockSessionMode,
}) }));
jest.mock('../../ThemeContext', () => ({ useTheme: () => ({ colors: { surfaceMuted: '#eee', warning: '#fa0' } }) }));
jest.mock('../../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(Text, null, p.children) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  return {
    __esModule: true,
    Icon: (p: any) => R.createElement('Icon', p),
    IconButton: (p: any) => R.createElement('IconButton', p),
    Button: (p: any) => R.createElement('Button', p),
    useToast: () => mockToast,
  };
});

import UnverifiedBanner from '../../UnverifiedBanner';
import { api } from '../../api';

const apiMock = api as unknown as jest.Mock;
const node = (r: any, id: string) =>
  r.root.find((n: any) => typeof n.type === 'string' && n.props.testID === id);
const has = (r: any, id: string) =>
  r.root.findAll((n: any) => n.props && n.props.testID === id).length > 0;
const mounted: { unmount(): void }[] = [];

beforeEach(() => {
  mockToast.show.mockClear(); mockRefresh.mockClear(); apiMock.mockReset(); mockUser = null;
  mockEmailFeaturesEnabled = true; mockReminderDismissed = false; mockDismissReminder.mockClear();
  mockSessionMode = 'online';
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => { mounted.splice(0).forEach((renderer) => renderer.unmount()); });
  jest.useRealTimers();
});

function mount(props: { dismissible?: boolean } = {}) {
  let r: any;
  act(() => { r = TestRenderer.create(React.createElement(UnverifiedBanner, props)); });
  mounted.push(r);
  return r;
}

describe('UnverifiedBanner', () => {
  it('renders for an unverified user', () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    expect(has(mount(), 'unverified-banner')).toBe(true);
  });

  it.each([true, false])('renders nothing for a verified user (dismissible: %s)', (dismissible) => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: true };
    expect(has(mount({ dismissible }), 'unverified-banner')).toBe(false);
  });

  it('keeps the Profile action available after the Dashboard reminder is dismissed', () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    mockReminderDismissed = true;
    expect(has(mount(), 'unverified-banner')).toBe(false);
    const profile = mount({ dismissible: false });
    expect(has(profile, 'unverified-banner')).toBe(true);
    expect(has(profile, 'unverified-resend')).toBe(true);
    expect(has(profile, 'unverified-dismiss')).toBe(false);
  });

  it('closes the reminder without sending an email or changing verification', () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    const r = mount();
    const close = node(r, 'unverified-dismiss');
    expect(close.props.name).toBe('close');
    expect(close.props.accessibilityLabel).toBe('Dismiss email verification reminder');
    act(() => { close.props.onPress(); });
    act(() => { r.update(React.createElement(UnverifiedBanner)); });
    expect(has(r, 'unverified-banner')).toBe(false);
    expect(mockDismissReminder).toHaveBeenCalledTimes(1);
    expect(apiMock).not.toHaveBeenCalled();
    expect(mockUser.email_verified).toBe(false);
  });

  it('stays hidden while email sending is disabled', () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    mockEmailFeaturesEnabled = false;
    expect(has(mount(), 'unverified-banner')).toBe(false);
    expect(has(mount({ dismissible: false }), 'unverified-banner')).toBe(false);
  });

  it('renders nothing when email_verified is undefined (legacy / OAuth)', () => {
    mockUser = { id: 'u1', email: 'a@gmail.com' };
    expect(has(mount(), 'unverified-banner')).toBe(false);
  });

  it('sends an email, refreshes the account, and prevents resending during the cooldown', async () => {
    apiMock.mockResolvedValue({ message: 'Verification email sent' });
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    const r = mount();
    await act(async () => { await node(r, 'unverified-resend').props.onPress(); });
    expect(apiMock).toHaveBeenCalledWith('/auth/resend-verification', { method: 'POST' });
    expect(mockToast.show).toHaveBeenCalledWith('Verification email sent', 'success');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(node(r, 'unverified-resend').props.label).toBe('Resend in 60s');
    expect(node(r, 'unverified-resend').props.disabled).toBe(true);
    await act(async () => { await node(r, 'unverified-resend').props.onPress(); });
    expect(apiMock).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 60; i += 1) act(() => { jest.advanceTimersByTime(1000); });
    expect(node(r, 'unverified-resend').props.disabled).toBe(false);
    expect(node(r, 'unverified-resend').props.label).toBe('Send verification email');
    expect(mockUser.email_verified).toBe(false);
  });

  it('explains that a connection is required and never sends while offline', async () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    mockSessionMode = 'offline';
    const r = mount({ dismissible: false });
    expect(JSON.stringify(r.toJSON())).toContain('Connect to the internet');
    expect(node(r, 'unverified-resend').props.disabled).toBe(true);
    await act(async () => { await node(r, 'unverified-resend').props.onPress(); });
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('prevents duplicate requests while delivery is pending', async () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    let finish!: (value: object) => void;
    apiMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const r = mount();
    act(() => { void node(r, 'unverified-resend').props.onPress(); });
    expect(node(r, 'unverified-resend').props.loading).toBe(true);
    await act(async () => { await node(r, 'unverified-resend').props.onPress(); });
    expect(apiMock).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ message: 'Verification email sent' }); });
    expect(node(r, 'unverified-resend').props.loading).toBe(false);
  });

  it('honors server retry timing without reporting delivery or verifying the account', async () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    apiMock.mockRejectedValue(Object.assign(new Error('Please wait before requesting another email.'), { retryAfterMs: 9000 }));
    const r = mount();
    await act(async () => { await node(r, 'unverified-resend').props.onPress(); });
    expect(node(r, 'unverified-resend').props.label).toBe('Resend in 9s');
    expect(node(r, 'unverified-resend').props.disabled).toBe(true);
    expect(mockToast.show).toHaveBeenCalledWith('Please wait before requesting another email.', 'error');
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockUser.email_verified).toBe(false);
  });

  it('leaves a retry available when sending fails', async () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    apiMock.mockRejectedValue(new Error('Unable to connect.'));
    const r = mount();
    await act(async () => { await node(r, 'unverified-resend').props.onPress(); });
    expect(mockToast.show).toHaveBeenCalledWith('Unable to connect.', 'error');
    expect(node(r, 'unverified-resend').props.loading).toBe(false);
    expect(node(r, 'unverified-resend').props.disabled).toBe(false);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('removes both prompts when refreshed account data confirms verification', () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    const dashboard = mount();
    const profile = mount({ dismissible: false });
    mockUser = { ...mockUser, email_verified: true };
    act(() => {
      dashboard.update(<UnverifiedBanner />);
      profile.update(<UnverifiedBanner dismissible={false} />);
    });
    expect(has(dashboard, 'unverified-banner')).toBe(false);
    expect(has(profile, 'unverified-banner')).toBe(false);
  });
});
