/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockReplace = jest.fn();
const mockUpdateMobileNumber = jest.fn();
const mockCompleteMobileOnboarding = jest.fn();
const mockToastShow = jest.fn();
let mockParams: any = {};
let mockAuthState: any = {};

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../AuthContext', () => ({ useAuth: () => mockAuthState }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('../../mobileNumber', () => {
  const actual = jest.requireActual('../../mobileNumber');
  return { ...actual, countryFromLocale: () => 'IN' };
});
jest.mock('../../MobileNumberInput', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (props: any) => R.createElement(
      'MobileNumberInput',
      { ...props, testID: 'mobile-input' },
    ),
  };
});
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    AuthShell: stub('AuthShell'),
    Button: stub('Button'),
    Card: stub('Card'),
    Icon: stub('Icon'),
    useToast: () => ({ show: mockToastShow }),
  };
});
jest.mock('../../ConfirmModal', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (props: any) => props.visible ? R.createElement('ConfirmModal', props) : null,
  };
});

import SetMobile from '../../../app/set-mobile';
import { MOBILE_INVALID_MESSAGE } from '../../mobileNumber';

const node = (renderer: any, testID: string) => renderer.root.find(
  (candidate: any) => typeof candidate.type === 'string' && candidate.props.testID === testID,
);
const has = (renderer: any, testID: string) => renderer.root.findAll(
  (candidate: any) => typeof candidate.type === 'string' && candidate.props?.testID === testID,
).length > 0;

function mount() {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(<SetMobile />); });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockAuthState = {
    user: {
      id: 'u1', email: 'ravi@gmail.com', name: 'Ravi', role: 'user',
      mobile_number: null, mobile_country_code: null,
    },
    pendingInvitePath: null,
    upiOnboardingPending: false,
    updateMobileNumber: mockUpdateMobileNumber,
    completeMobileOnboarding: mockCompleteMobileOnboarding,
  };
  mockUpdateMobileNumber.mockImplementation(async (mobileNumber: string | null, country: string | null) => ({
    ...mockAuthState.user,
    mobile_number: mobileNumber,
    mobile_country_code: country,
    mobile_verified_at: null,
  }));
});

describe('mobile onboarding mode', () => {
  it('rejects incomplete input locally with an accessible retry state', async () => {
    const renderer = mount();
    act(() => node(renderer, 'mobile-input').props.onChange('123', 'IN'));
    await act(async () => node(renderer, 'mobile-save').props.onPress());

    expect(mockUpdateMobileNumber).not.toHaveBeenCalled();
    expect(node(renderer, 'mobile-input').props.error).toBe(MOBILE_INVALID_MESSAGE);
    expect(node(renderer, 'mobile-input').props.focusOnError).toBe(true);
    expect(node(renderer, 'mobile-save').props.label).toBe('Try again');
  });

  it('saves E.164 and hands an invite to UPI as the next setup step', async () => {
    const invite = `/invite/${'a'.repeat(43)}`;
    mockParams = { returnTo: invite };
    mockAuthState.upiOnboardingPending = true;
    const renderer = mount();

    act(() => node(renderer, 'mobile-input').props.onChange('(415) 555-2671', 'US'));
    await act(async () => node(renderer, 'mobile-save').props.onPress());

    expect(mockUpdateMobileNumber).toHaveBeenCalledWith('+14155552671', 'US');
    expect(mockToastShow).toHaveBeenCalledWith('Mobile number saved.', 'success');
    expect(mockCompleteMobileOnboarding).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/set-upi', params: { returnTo: invite },
    });
  });

  it('skips only this session, without a profile write, and preserves setup order', () => {
    const invite = `/invite/${'b'.repeat(43)}`;
    mockAuthState.pendingInvitePath = invite;
    mockAuthState.upiOnboardingPending = true;
    const renderer = mount();

    act(() => node(renderer, 'mobile-skip').props.onPress());

    expect(mockUpdateMobileNumber).not.toHaveBeenCalled();
    expect(mockCompleteMobileOnboarding).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/set-upi', params: { returnTo: invite },
    });
  });

  it('rejects an unsafe return destination when skipping', () => {
    mockParams = { returnTo: 'https://evil.example/invite/secret' };
    const renderer = mount();

    act(() => node(renderer, 'mobile-skip').props.onPress());

    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('preserves the draft and conflict detail for recovery', async () => {
    mockUpdateMobileNumber.mockRejectedValueOnce(
      new Error('This mobile number is already used by Mina in Kerala.'),
    );
    const renderer = mount();
    act(() => node(renderer, 'mobile-input').props.onChange('98765 43210', 'IN'));

    await act(async () => node(renderer, 'mobile-save').props.onPress());

    expect(node(renderer, 'mobile-input').props.value).toBe('98765 43210');
    expect(node(renderer, 'mobile-input').props.error)
      .toBe('This mobile number is already used by Mina in Kerala.');
    expect(node(renderer, 'mobile-save').props.label).toBe('Try again');
    expect(mockCompleteMobileOnboarding).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('prevents duplicate saves and disables skip while a request is running', async () => {
    let resolveSave: (value: any) => void = () => {};
    mockUpdateMobileNumber.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }));
    const renderer = mount();
    act(() => node(renderer, 'mobile-input').props.onChange('98765 43210', 'IN'));

    act(() => {
      void node(renderer, 'mobile-save').props.onPress();
      void node(renderer, 'mobile-save').props.onPress();
    });

    expect(mockUpdateMobileNumber).toHaveBeenCalledTimes(1);
    expect(node(renderer, 'mobile-save').props.loading).toBe(true);
    expect(node(renderer, 'mobile-save').props.disabled).toBe(true);
    expect(node(renderer, 'mobile-skip').props.disabled).toBe(true);
    expect(node(renderer, 'mobile-input').props.editable).toBe(false);

    await act(async () => {
      resolveSave({
        ...mockAuthState.user,
        mobile_number: '+919876543210',
        mobile_country_code: 'IN',
      });
      await Promise.resolve();
    });
  });
});

describe('mobile Profile mode', () => {
  beforeEach(() => {
    mockParams = { mode: 'profile' };
    mockAuthState.user = {
      ...mockAuthState.user,
      mobile_number: '+919876543210',
      mobile_country_code: 'IN',
    };
  });

  it('prefills, saves changes, and can cancel without writing', async () => {
    const renderer = mount();
    expect(node(renderer, 'mobile-input').props.value).toBe('98765 43210');
    expect(node(renderer, 'mobile-save').props.label).toBe('Save changes');

    act(() => node(renderer, 'mobile-input').props.onChange('(415) 555-2671', 'US'));
    await act(async () => node(renderer, 'mobile-save').props.onPress());
    expect(mockUpdateMobileNumber).toHaveBeenCalledWith('+14155552671', 'US');
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/profile');
    expect(mockCompleteMobileOnboarding).not.toHaveBeenCalled();

    jest.clearAllMocks();
    const cancelRenderer = mount();
    act(() => node(cancelRenderer, 'mobile-cancel').props.onPress());
    expect(mockUpdateMobileNumber).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/profile');
  });

  it('requires confirmation before removing the saved number', async () => {
    const renderer = mount();
    act(() => node(renderer, 'mobile-remove').props.onPress());
    let modal = node(renderer, 'mobile-remove-confirm-modal');

    act(() => modal.props.actions
      .find((item: any) => item.testID === 'mobile-remove-cancel').onPress());
    expect(has(renderer, 'mobile-remove-confirm-modal')).toBe(false);
    expect(mockUpdateMobileNumber).not.toHaveBeenCalled();

    act(() => node(renderer, 'mobile-remove').props.onPress());
    modal = node(renderer, 'mobile-remove-confirm-modal');
    await act(async () => modal.props.actions
      .find((item: any) => item.testID === 'mobile-remove-confirm').onPress());

    expect(mockUpdateMobileNumber).toHaveBeenCalledWith(null, null);
    expect(mockToastShow).toHaveBeenCalledWith('Mobile number removed.', 'success');
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/profile');
    expect(mockCompleteMobileOnboarding).not.toHaveBeenCalled();
  });
});
