/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockApi = jest.fn();
const mockToast = jest.fn();
const mockAuth: any = { user: null, emailFeaturesEnabled: true, sessionMode: 'online' };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
}));
jest.mock('../../api', () => ({ api: (...args: any[]) => mockApi(...args) }));
jest.mock('../../AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    AuthShell: stub('AuthShell'), FormScreen: stub('FormScreen'), Card: stub('Card'),
    Input: stub('Input'), Button: stub('Button'), useToast: () => ({ show: mockToast }),
  };
});

import ChangePassword from '../../../app/change-password';
import ForgotPassword from '../../../app/(auth)/forgot-password';

const account = { id: 'u1', email: 'google.user@gmail.com', credentials_set: true };
function mount(element: React.ReactElement) {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(element); });
  return renderer;
}
const node = (renderer: any, testID: string) => renderer.root.find(
  (item: any) => typeof item.type === 'string' && item.props.testID === testID,
);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.user = account;
  mockAuth.emailFeaturesEnabled = true;
  mockAuth.sessionMode = 'online';
  mockApi.mockResolvedValue({ ok: true, message: 'If this email exists, a reset link has been sent.' });
});

it('offers email recovery without requiring the previous password', () => {
  const renderer = mount(<ChangePassword />);
  expect(node(renderer, 'cp-submit').props.disabled).toBe(true);
  act(() => node(renderer, 'cp-forgot-password').props.onPress());
  expect(mockPush).toHaveBeenCalledWith('/(auth)/forgot-password');
  expect(mockApi).not.toHaveBeenCalled();
});

it('disables the email recovery entry point during an offline account session', () => {
  mockAuth.sessionMode = 'offline';
  const renderer = mount(<ChangePassword />);
  expect(node(renderer, 'cp-forgot-password').props.disabled).toBe(true);
});

it('prefills the signed-in email and requests a link without a password or sign-out', async () => {
  const renderer = mount(<ForgotPassword />);
  expect(node(renderer, 'forgot-pw-email').props.value).toBe(account.email);
  expect(mockApi).not.toHaveBeenCalled();
  await act(async () => { await node(renderer, 'forgot-pw-submit').props.onPress(); });
  expect(mockApi).toHaveBeenCalledWith('/auth/request-password-reset', {
    method: 'POST', body: { email: account.email }, auth: false,
  });
  expect(mockReplace).not.toHaveBeenCalled();
  expect(node(renderer, 'forgot-pw-back').props.label).toBe('Back to password settings');
  act(() => node(renderer, 'forgot-pw-back').props.onPress());
  expect(mockReplace).toHaveBeenCalledWith('/change-password');
});

it('prefills an asynchronously restored account without overwriting an edited email', () => {
  mockAuth.user = undefined;
  const renderer = mount(<ForgotPassword />);
  expect(node(renderer, 'forgot-pw-email').props.value).toBe('');
  mockAuth.user = account;
  act(() => renderer.update(<ForgotPassword />));
  expect(node(renderer, 'forgot-pw-email').props.value).toBe(account.email);
  act(() => node(renderer, 'forgot-pw-email').props.onChangeText('another@gmail.com'));
  mockAuth.user = { ...account, email: 'restored@gmail.com' };
  act(() => renderer.update(<ForgotPassword />));
  expect(node(renderer, 'forgot-pw-email').props.value).toBe('another@gmail.com');
});

it.each(['', 'person@example.com'])('validates %p before sending a recovery email', async (email) => {
  mockAuth.user = null;
  const renderer = mount(<ForgotPassword />);
  act(() => node(renderer, 'forgot-pw-email').props.onChangeText(email));
  await act(async () => { await node(renderer, 'forgot-pw-submit').props.onPress(); });
  expect(mockApi).not.toHaveBeenCalled();
  expect(node(renderer, 'forgot-pw-email').props.error).toBeTruthy();
});

it('does not refill a deliberately cleared account email', async () => {
  const renderer = mount(<ForgotPassword />);
  act(() => node(renderer, 'forgot-pw-email').props.onChangeText(''));
  await act(async () => { await node(renderer, 'forgot-pw-submit').props.onPress(); });
  expect(node(renderer, 'forgot-pw-email').props.value).toBe('');
  expect(mockApi).not.toHaveBeenCalled();
});

it('keeps request failures retryable without showing a false email confirmation', async () => {
  mockApi.mockRejectedValueOnce(new Error('Please wait before requesting another email.'));
  const renderer = mount(<ForgotPassword />);
  await act(async () => { await node(renderer, 'forgot-pw-submit').props.onPress(); });
  expect(mockToast).toHaveBeenCalledWith('Please wait before requesting another email.', 'error');
  expect(node(renderer, 'forgot-pw-submit').props.loading).toBe(false);
  expect(renderer.root.findAllByProps({ testID: 'forgot-pw-back' })).toHaveLength(0);
  await act(async () => { await node(renderer, 'forgot-pw-submit').props.onPress(); });
  expect(node(renderer, 'forgot-pw-back').props.label).toBe('Back to password settings');
});

it('explains disabled delivery and prevents a misleading reset request', async () => {
  mockAuth.emailFeaturesEnabled = false;
  const renderer = mount(<ForgotPassword />);
  expect(node(renderer, 'forgot-pw-unavailable')).toBeDefined();
  expect(node(renderer, 'forgot-pw-submit').props.disabled).toBe(true);
  await act(async () => { await node(renderer, 'forgot-pw-submit').props.onPress(); });
  expect(mockApi).not.toHaveBeenCalled();
});

it('preserves the existing signed-out recovery return path', async () => {
  mockAuth.user = null;
  const renderer = mount(<ForgotPassword />);
  act(() => node(renderer, 'forgot-pw-email').props.onChangeText('signed.out@gmail.com'));
  await act(async () => { await node(renderer, 'forgot-pw-submit').props.onPress(); });
  act(() => node(renderer, 'forgot-pw-back').props.onPress());
  expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
});
