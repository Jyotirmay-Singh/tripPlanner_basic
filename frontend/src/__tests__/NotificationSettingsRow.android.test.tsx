/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetPermissionState = jest.fn();
const mockOpenSettings = jest.fn();
const mockAlert = jest.fn();
const mockRemoveAppStateListener = jest.fn();
const mockAddAppStateListener = jest.fn();
let mockAppStateHandler: ((state: string) => void) | undefined;

jest.mock('react-native', () => {
  const R = require('react');
  return {
    Platform: { OS: 'android' },
    Alert: { alert: mockAlert },
    AppState: { addEventListener: mockAddAppStateListener },
    View: (props: any) => R.createElement('View', props, props.children),
    Switch: (props: any) => R.createElement('Switch', props),
  };
});

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(callback, [callback]);
  },
}));

jest.mock('../pushNotifications', () => ({
  getPushPermissionState: mockGetPermissionState,
  openPushNotificationSettings: mockOpenSettings,
}));

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#00aa88',
      textMuted: '#888888',
      border: '#dddddd',
      surface: '#ffffff',
    },
  }),
}));

jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});

jest.mock('../ui', () => {
  const R = require('react');
  return {
    Card: (props: any) => R.createElement('Card', props, props.children),
    Icon: (props: any) => R.createElement('Icon', props),
  };
});

const { Platform } = require('react-native');
const NotificationSettingsRow = require('../NotificationSettingsRow').default;

async function renderRow() {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<NotificationSettingsRow />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

function statuses(renderer: any) {
  return renderer.root.findAllByType('T' as any).map((node: any) => node.props.children);
}

function alertButton(label: string) {
  const buttons = mockAlert.mock.calls.at(-1)?.[2] as {
    text: string;
    onPress?: () => void | Promise<void>;
  }[];
  const button = buttons?.find((candidate) => candidate.text === label);
  expect(button).toBeDefined();
  return button!;
}

describe('Profile notification settings row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Platform as any).OS = 'android';
    mockAppStateHandler = undefined;
    mockGetPermissionState.mockResolvedValue('undetermined');
    mockOpenSettings.mockResolvedValue(undefined);
    mockAddAppStateListener.mockImplementation(
      (_event: string, handler: (state: string) => void) => {
        mockAppStateHandler = handler;
        return { remove: mockRemoveAppStateListener };
      },
    );
  });

  it.each([
    ['granted', 'Enabled', true, 'Notifications enabled. Open Android settings to disable.'],
    ['denied', 'Disabled', false, 'Notifications disabled. Open Android settings to enable.'],
    ['undetermined', 'Disabled', false, 'Notifications disabled. Open Android settings to enable.'],
  ])('always shows the Android row when permission is %s', async (
    permission, status, enabled, accessibilityLabel,
  ) => {
    mockGetPermissionState.mockResolvedValue(permission);
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    const notificationSwitch = renderer.root.findByProps({ testID: 'profile-notification-switch' });

    expect(statuses(renderer)).toEqual(expect.arrayContaining(['Notifications', status]));
    expect(notificationSwitch.props.value).toBe(enabled);
    expect(notificationSwitch.props.disabled).toBe(false);
    expect(notificationSwitch.props.pointerEvents).toBe('none');
    expect(row.props.accessibilityLabel).toBe(accessibilityLabel);
    expect(row.props.onPress).toEqual(expect.any(Function));
  });

  it('keeps the row visible and disabled while Android permission is loading', () => {
    mockGetPermissionState.mockReturnValue(new Promise(() => {}));
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<NotificationSettingsRow />); });
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    const notificationSwitch = renderer.root.findByProps({ testID: 'profile-notification-switch' });

    expect(statuses(renderer)).toContain('Checking\u2026');
    expect(notificationSwitch.props.disabled).toBe(true);
    expect(row.props.onPress).toBeUndefined();

    act(() => { renderer.unmount(); });
  });

  it('shows a disabled, non-interactive row when Android state is unavailable', async () => {
    mockGetPermissionState.mockResolvedValue('unavailable');
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    const notificationSwitch = renderer.root.findByProps({ testID: 'profile-notification-switch' });

    expect(statuses(renderer)).toContain('Not available');
    expect(notificationSwitch.props.value).toBe(false);
    expect(notificationSwitch.props.disabled).toBe(true);
    expect(row.props.onPress).toBeUndefined();
  });

  it.each(['web', 'ios'])('shows Not available without native work on %s', async (platform) => {
    (Platform as any).OS = platform;
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    const notificationSwitch = renderer.root.findByProps({ testID: 'profile-notification-switch' });

    expect(statuses(renderer)).toContain('Not available');
    expect(notificationSwitch.props.disabled).toBe(true);
    expect(row.props.onPress).toBeUndefined();
    expect(mockGetPermissionState).not.toHaveBeenCalled();
    expect(mockAddAppStateListener).not.toHaveBeenCalled();
  });

  it.each([
    ['granted', 'Disable notifications?', 'turn Notifications off.'],
    ['denied', 'Enable notifications?', 'turn Notifications on.'],
    ['undetermined', 'Enable notifications?', 'turn Notifications on.'],
  ])('confirms before opening settings from %s state', async (permission, title, message) => {
    mockGetPermissionState.mockResolvedValue(permission);
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });

    act(() => { row.props.onPress(); });

    expect(mockAlert).toHaveBeenCalledWith(
      title,
      expect.stringContaining(message),
      expect.any(Array),
    );
    expect(mockOpenSettings).not.toHaveBeenCalled();

    await act(async () => { await alertButton('Open settings').onPress?.(); });

    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('does not open settings when the confirmation is cancelled', async () => {
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });

    act(() => { row.props.onPress(); });
    act(() => { alertButton('Cancel').onPress?.(); });

    expect(mockOpenSettings).not.toHaveBeenCalled();
  });

  it('ignores repeated presses while settings are opening', async () => {
    let finish!: () => void;
    mockOpenSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const renderer = await renderRow();
    const initialRow = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    act(() => { initialRow.props.onPress(); });

    let openPromise!: Promise<void>;
    act(() => { openPromise = alertButton('Open settings').onPress?.() as Promise<void>; });
    const busyRow = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    const busySwitch = renderer.root.findByProps({ testID: 'profile-notification-switch' });
    act(() => { busyRow.props.onPress(); });

    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(busyRow.props.style.opacity).toBe(0.65);
    expect(busySwitch.props.disabled).toBe(true);

    finish();
    await act(async () => { await openPromise; });
  });

  it('refreshes the switch when the app returns from Android settings', async () => {
    mockGetPermissionState.mockResolvedValueOnce('denied').mockResolvedValueOnce('granted');
    const renderer = await renderRow();
    expect(renderer.root.findByProps({ testID: 'profile-notification-switch' }).props.value).toBe(false);

    await act(async () => {
      mockAppStateHandler?.('active');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ testID: 'profile-notification-switch' }).props.value).toBe(true);
    expect(statuses(renderer)).toContain('Enabled');
  });

  it('ignores non-active AppState changes and removes its listener on cleanup', async () => {
    const renderer = await renderRow();
    mockGetPermissionState.mockClear();

    act(() => { mockAppStateHandler?.('background'); });
    expect(mockGetPermissionState).not.toHaveBeenCalled();

    act(() => { renderer.unmount(); });
    expect(mockRemoveAppStateListener).toHaveBeenCalledTimes(1);
  });

  it('explains how to recover if Android settings cannot be opened', async () => {
    mockOpenSettings.mockRejectedValueOnce(new Error('unavailable'));
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    act(() => { row.props.onPress(); });

    await act(async () => { await alertButton('Open settings').onPress?.(); });

    expect(mockAlert).toHaveBeenLastCalledWith(
      'Unable to open settings',
      'Open Android Settings, select Trip Splitter, then choose Notifications.',
    );
  });
});
