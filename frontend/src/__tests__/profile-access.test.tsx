/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { Platform } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockNavigate = jest.fn();
const mockPush = jest.fn();
const mockToggle = jest.fn();
const mockConfirmAndSignOut = jest.fn();
const mockSelectionAsync = jest.fn().mockResolvedValue(undefined);
const originalPlatformOS = Platform.OS;

jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mockNavigate, push: mockPush }),
}));
jest.mock('expo-haptics', () => ({ __esModule: true, selectionAsync: mockSelectionAsync }));
jest.mock('../AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Ada Traveller', email: 'ada@example.com' } }),
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
  return { Screen: stub('Screen'), Card: stub('Card'), Icon: stub('Icon') };
});

import Profile from '../../app/(tabs)/profile';
import ProfileAvatarButton from '../ProfileAvatarButton';

function render(element: React.ReactElement) {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(element); });
  return renderer!.root;
}

describe('Profile access after removing its visible tab', () => {
  afterEach(() => {
    jest.clearAllMocks();
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

    act(() => { root.findByProps({ testID: 'toggle-dark-mode' }).props.onValueChange(true); });
    act(() => { root.findByProps({ testID: 'profile-change-password' }).props.onPress(); });
    act(() => { root.findByProps({ testID: 'profile-logout' }).props.onPress(); });

    expect(mockToggle).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/change-password');
    expect(mockConfirmAndSignOut).toHaveBeenCalledTimes(1);
  });
});
