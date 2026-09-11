/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { Platform } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockNavigate = jest.fn();
const mockPush = jest.fn();
const mockToggle = jest.fn();
const mockConfirmAndSignOut = jest.fn();
const mockSelectionAsync = jest.fn().mockResolvedValue(undefined);
const mockRefreshUserProfile = jest.fn().mockResolvedValue(undefined);
const mockSetStringAsync = jest.fn().mockResolvedValue(true);
const mockToastShow = jest.fn();
const originalPlatformOS = Platform.OS;
let mockUser: any = {
  id: 'u1', name: 'Ada Traveller', email: 'ada@example.com', upi_id: 'ada@okbank',
};

jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mockNavigate, push: mockPush }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(callback, [callback]);
  },
}));
jest.mock('expo-haptics', () => ({ __esModule: true, selectionAsync: mockSelectionAsync }));
jest.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => mockSetStringAsync(value),
}));
jest.mock('../AuthContext', () => ({
  useAuth: () => ({ user: mockUser, refreshUserProfile: mockRefreshUserProfile }),
}));
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    mode: 'light',
    toggle: mockToggle,
    colors: new Proxy({}, { get: () => '#123456' }),
  }),
}));
jest.mock('../useLogout', () => ({
  useLogout: () => ({ confirmAndSignOut: mockConfirmAndSignOut }),
}));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../TabPageHeader', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TabPageHeader', props) };
});
jest.mock('../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    Screen: stub('Screen'),
    TabScreen: stub('Screen'),
    Card: stub('Card'),
    Icon: stub('Icon'),
    IconButton: stub('IconButton'),
    useToast: () => ({ show: mockToastShow }),
  };
});

import Profile from '../../app/(tabs)/profile';
import ProfileAvatarButton from '../ProfileAvatarButton';

function render(element: React.ReactElement) {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(element); });
  return renderer!.root;
}

describe('Profile access after removing its visible tab', () => {
  beforeEach(() => {
    mockRefreshUserProfile.mockResolvedValue(undefined);
    mockSetStringAsync.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
    mockUser = {
      id: 'u1', name: 'Ada Traveller', email: 'ada@example.com', upi_id: 'ada@okbank',
    };
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
  });

  it('opens the hidden Profile route from the header avatar', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const button = render(<ProfileAvatarButton />).findByProps({ testID: 'header-profile-avatar' });

    act(() => { button.props.onPress(); });

    expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/profile');
    expect(button.props.accessibilityLabel).toBe('Open profile for Ada Traveller');
  });

  it('shows initials without a redundant person icon when a name is available', () => {
    const root = render(<ProfileAvatarButton />);
    expect(root.findAllByType('T' as any).map((node: any) => node.props.children)).toContain('AT');
    expect(root.findAllByType('Icon' as any)).toHaveLength(0);
  });

  it('preserves theme, password, and sign-out controls on Profile', () => {
    const root = render(<Profile />);

    expect(root.findByProps({ testID: 'profile-notification-settings' })).toBeDefined();

    act(() => { root.findByProps({ testID: 'toggle-dark-mode' }).props.onValueChange(true); });
    act(() => { root.findByProps({ testID: 'profile-change-password' }).props.onPress(); });
    act(() => { root.findByProps({ testID: 'profile-payment-details' }).props.onPress(); });
    act(() => { root.findByProps({ testID: 'profile-logout' }).props.onPress(); });

    expect(mockToggle).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/change-password');
    expect(mockPush).toHaveBeenCalledWith('/set-upi?mode=profile');
    expect(root.findByProps({ testID: 'profile-upi-value' }).props.children).toBe('ada@okbank');
    expect(mockConfirmAndSignOut).toHaveBeenCalledTimes(1);
  });

  it('shows the payment-details empty state without prompting automatically', () => {
    mockUser = { ...mockUser, upi_id: null };
    const root = render(<Profile />);

    expect(root.findByProps({ testID: 'profile-upi-value' }).props.children)
      .toBe('UPI ID not set');
    expect(root.findByProps({ testID: 'profile-payment-details' }).props.accessibilityLabel)
      .toBe('Payment details, UPI ID not set');
    expect(root.findAllByProps({ testID: 'profile-copy-upi' })).toHaveLength(0);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('refreshes the authenticated profile when Profile gains focus', () => {
    render(<Profile />);

    expect(mockRefreshUserProfile).toHaveBeenCalledTimes(1);
  });

  it('copies the UPI ID without navigating and confirms only after clipboard success', async () => {
    const root = render(<Profile />);
    const copy = root.findByProps({ testID: 'profile-copy-upi' });

    expect(copy.props.accessibilityLabel).toBe('Copy UPI ID');
    expect(copy.props.touchSize).toBe(44);
    await act(async () => { await copy.props.onPress(); });

    expect(mockSetStringAsync).toHaveBeenCalledWith('ada@okbank');
    expect(mockToastShow).toHaveBeenCalledWith('UPI ID copied', 'success');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows a retryable error without a false success when clipboard copying fails', async () => {
    mockSetStringAsync.mockRejectedValueOnce(new Error('clipboard unavailable'));
    const root = render(<Profile />);

    await act(async () => {
      await root.findByProps({ testID: 'profile-copy-upi' }).props.onPress();
    });

    expect(mockToastShow).toHaveBeenCalledWith('Could not copy UPI ID. Try again.', 'error');
    expect(mockToastShow).not.toHaveBeenCalledWith('UPI ID copied', 'success');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('treats a resolved false clipboard result as a retryable failure', async () => {
    mockSetStringAsync.mockResolvedValueOnce(false);
    const root = render(<Profile />);

    await act(async () => {
      await root.findByProps({ testID: 'profile-copy-upi' }).props.onPress();
    });

    expect(mockToastShow).toHaveBeenCalledWith('Could not copy UPI ID. Try again.', 'error');
    expect(mockToastShow).not.toHaveBeenCalledWith('UPI ID copied', 'success');
  });
});
