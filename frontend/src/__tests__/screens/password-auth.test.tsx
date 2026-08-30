/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockSignIn = jest.fn();
const mockRegister = jest.fn();
const mockRefresh = jest.fn();
const mockSignOut = jest.fn();
const mockForgetSavedEmail = jest.fn();
const mockToastShow = jest.fn();
const mockApi = jest.fn();
const mockAuthState: any = {
  savedEmail: null,
  emailFeaturesEnabled: true,
  signIn: mockSignIn,
  register: mockRegister,
  refresh: mockRefresh,
  signOut: mockSignOut,
  forgetSavedEmail: mockForgetSavedEmail,
};

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush, back: jest.fn() }),
}));
jest.mock('../../AuthContext', () => ({ useAuth: () => mockAuthState }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: { primary: '#153', border: '#ccc' } }),
}));
jest.mock('../../api', () => ({ api: (...args: any[]) => mockApi(...args) }));
jest.mock('../../GoogleSignInButton', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: () => R.createElement('GoogleSignInButton'),
    googleAuthAvailable: false,
  };
});
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  return {
    __esModule: true,
    AuthShell: (props: any) => R.createElement('AuthShell', props, props.children),
    Card: (props: any) => R.createElement('Card', props, props.children),
    Input: (props: any) => R.createElement('Input', props),
    Button: (props: any) => R.createElement('Button', props),
    Icon: (props: any) => R.createElement('Icon', props),
    useToast: () => ({ show: mockToastShow }),
  };
});

import Login from '../../../app/(auth)/login';
import Register from '../../../app/(auth)/register';
import SetCredentials from '../../../app/set-credentials';

const findByTestId = (renderer: any, testID: string) => renderer.root.find(
  (node: any) => typeof node.type === 'string' && node.props.testID === testID,
);
const hasTestId = (renderer: any, testID: string) => (
  renderer.root.findAll((node: any) => node.props?.testID === testID).length > 0
);

function mount(component: React.ReactElement) {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(component); });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthState.savedEmail = null;
  mockAuthState.emailFeaturesEnabled = true;
  mockSignIn.mockResolvedValue(undefined);
  mockRegister.mockResolvedValue(undefined);
  mockRefresh.mockResolvedValue(undefined);
  mockSignOut.mockResolvedValue(undefined);
  mockApi.mockResolvedValue({ ok: true });
});

describe('password-only authentication screens', () => {
  it('logs in with email and password and exposes recovery when email is enabled', async () => {
    const renderer = mount(<Login />);
    expect(hasTestId(renderer, 'login-pin')).toBe(false);
    expect(hasTestId(renderer, 'login-forgot-password-link')).toBe(true);

    act(() => findByTestId(renderer, 'login-email').props.onChangeText('person@gmail.com'));
    act(() => findByTestId(renderer, 'login-password').props.onChangeText('password123'));
    await act(async () => findByTestId(renderer, 'login-submit').props.onPress());

    expect(mockSignIn).toHaveBeenCalledWith('person@gmail.com', 'password123');
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('hides password recovery when outbound email is disabled', () => {
    mockAuthState.emailFeaturesEnabled = false;
    const renderer = mount(<Login />);
    expect(hasTestId(renderer, 'login-forgot-password-link')).toBe(false);
  });

  it('registers with name, email, and password without a PIN field', async () => {
    const renderer = mount(<Register />);
    expect(hasTestId(renderer, 'reg-pin')).toBe(false);

    act(() => findByTestId(renderer, 'reg-name').props.onChangeText('New User'));
    act(() => findByTestId(renderer, 'reg-email').props.onChangeText('new@gmail.com'));
    act(() => findByTestId(renderer, 'reg-password').props.onChangeText('password123'));
    act(() => findByTestId(renderer, 'reg-confirm-password').props.onChangeText('password123'));
    await act(async () => findByTestId(renderer, 'reg-submit').props.onPress());

    expect(mockRegister).toHaveBeenCalledWith('new@gmail.com', 'New User', 'password123');
  });

  it('requires Google users to create a password and offers account switching instead of skip', async () => {
    const renderer = mount(<SetCredentials />);
    expect(hasTestId(renderer, 'setcred-pin')).toBe(false);
    expect(hasTestId(renderer, 'setcred-skip')).toBe(false);
    expect(hasTestId(renderer, 'setcred-use-another')).toBe(true);

    act(() => findByTestId(renderer, 'setcred-password').props.onChangeText('password123'));
    act(() => findByTestId(renderer, 'setcred-confirm').props.onChangeText('password123'));
    await act(async () => findByTestId(renderer, 'setcred-submit').props.onPress());

    expect(mockApi).toHaveBeenCalledWith('/auth/set-credentials', {
      method: 'POST', body: { password: 'password123' },
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('clears the unfinished Google session when using another account', async () => {
    const renderer = mount(<SetCredentials />);
    await act(async () => findByTestId(renderer, 'setcred-use-another').props.onPress());
    expect(mockSignOut).toHaveBeenCalledWith(true);
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
  });
});
