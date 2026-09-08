/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Linking, Platform } from 'react-native';


const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockGetInvite = jest.fn();
const mockRememberInvite = jest.fn().mockResolvedValue(undefined);
const mockClearPendingInvite = jest.fn().mockResolvedValue(undefined);
const token = 'a'.repeat(43);
let mockParams: { token?: string } = { token };
let mockUser: any = { id: 'user-1', credentials_set: true };

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../../src/api', () => {
  class ApiError extends Error {
    detailCode?: string;
  }
  return { ApiError, getPublicTripInvite: mockGetInvite };
});

jest.mock('../../src/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    rememberInvite: mockRememberInvite,
    clearPendingInvite: mockClearPendingInvite,
  }),
}));

jest.mock('../../src/ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      background: '#fff', surface: '#fff', surfaceMuted: '#eee', primary: '#123',
      textMain: '#111', textMuted: '#555', border: '#ddd', danger: '#c00', success: '#080',
    },
  }),
}));

jest.mock('../../src/T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(Text, props, props.children) };
});

jest.mock('../../src/ui', () => {
  const R = require('react');
  const { Text, TouchableOpacity } = require('react-native');
  return {
    Button: ({ label, onPress, testID }: any) => R.createElement(
      TouchableOpacity, { onPress, testID }, R.createElement(Text, null, label),
    ),
    Icon: ({ name }: any) => R.createElement(Text, null, name),
  };
});

const InviteLanding = require('../../app/invite/[token]').default;

describe('invite landing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { token };
    mockUser = { id: 'user-1', credentials_set: true };
    mockGetInvite.mockResolvedValue({
      status: 'active', trip_name: 'Coast trip', expires_at: '2026-09-11T10:00:00Z',
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('remembers a valid link and sends an authenticated native user to the join wizard', async () => {
    await act(async () => {
      TestRenderer.create(<InviteLanding />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockRememberInvite).toHaveBeenCalledWith(`/invite/${token}`);
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/join-trip', params: { inviteToken: token },
    });
  });

  it.each([
    ['desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140'],
    ['iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Mobile/15E148'],
  ])('sends an authenticated %s web user to the join preview', async (_device, userAgent) => {
    const originalPlatform = Platform.OS;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent },
    });

    try {
      await act(async () => {
        TestRenderer.create(<InviteLanding />);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/join-trip', params: { inviteToken: token },
      });
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('preserves a signed-out web invite when continuing through authentication', async () => {
    const originalPlatform = Platform.OS;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140' },
    });
    mockUser = null;

    try {
      let renderer: any;
      await act(async () => {
        renderer = TestRenderer.create(<InviteLanding />);
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        renderer.root.findByProps({ testID: 'invite-continue-web' }).props.onPress();
        await Promise.resolve();
      });

      expect(mockRememberInvite).toHaveBeenCalledWith(`/invite/${token}`);
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/(auth)/login', params: { returnTo: `/invite/${token}` },
      });
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('rejects a malformed token without calling the public API', async () => {
    mockParams = { token: 'short' };
    mockUser = null;
    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(<InviteLanding />);
      await Promise.resolve();
    });

    expect(mockGetInvite).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ testID: 'invite-error-title' }).props.children)
      .toBe('This invite is not valid');
  });

  it('removes a permanently expired invitation from pending authentication state', async () => {
    mockUser = null;
    mockGetInvite.mockResolvedValue({
      status: 'expired', trip_name: 'Coast trip', expires_at: '2026-09-01T10:00:00Z',
    });

    await act(async () => {
      TestRenderer.create(<InviteLanding />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockRememberInvite).toHaveBeenCalledWith(`/invite/${token}`);
    expect(mockClearPendingInvite).toHaveBeenCalledTimes(1);
  });

  it('keeps Android browsers on the landing page and downloads only after a manual tap', async () => {
    const originalPlatform = Platform.OS;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140' },
    });
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    try {
      let renderer: any;
      await act(async () => {
        renderer = TestRenderer.create(<InviteLanding />);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockReplace).not.toHaveBeenCalled();
      expect(renderer.root.findByProps({ testID: 'invite-open-app' })).toBeTruthy();
      expect(renderer.root.findByProps({ testID: 'invite-download-apk' })).toBeTruthy();
      expect(renderer.root.findByProps({ testID: 'invite-continue-web' })).toBeTruthy();
      expect(openUrl).not.toHaveBeenCalled();

      await act(async () => {
        renderer.root.findByProps({ testID: 'invite-download-apk' }).props.onPress();
        await Promise.resolve();
      });
      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(openUrl).toHaveBeenCalledWith(
        'https://tripsplitter-web.vercel.app/download/android',
      );
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('never downloads for an invalid Android-browser invite without a manual tap', async () => {
    const originalPlatform = Platform.OS;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140' },
    });
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    mockParams = { token: 'short' };
    mockUser = null;

    try {
      await act(async () => {
        TestRenderer.create(<InviteLanding />);
        await Promise.resolve();
      });
      expect(openUrl).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});
