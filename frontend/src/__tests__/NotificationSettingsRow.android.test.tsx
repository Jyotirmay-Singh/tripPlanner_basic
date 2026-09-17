/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetSettings = jest.fn();
const mockSetEnabled = jest.fn();
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
  getPushNotificationSettings: mockGetSettings,
  openPushNotificationSettings: mockOpenSettings,
  setPushNotificationsEnabled: mockSetEnabled,
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

type Settings = {
  userPreference: boolean | null;
  permission: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  canAskAgain: boolean;
  enabled: boolean;
};

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    userPreference: null,
    permission: 'undetermined',
    canAskAgain: true,
    enabled: false,
    ...overrides,
  };
}

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

function notificationSwitch(renderer: any) {
  return renderer.root.findByProps({ testID: 'profile-notification-switch' });
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
    mockGetSettings.mockResolvedValue(settings());
    mockSetEnabled.mockImplementation(async (enabled: boolean) => settings({
      userPreference: enabled,
      permission: 'granted',
      canAskAgain: true,
      enabled,
    }));
    mockOpenSettings.mockResolvedValue(undefined);
    mockAddAppStateListener.mockImplementation(
      (_event: string, handler: (state: string) => void) => {
        mockAppStateHandler = handler;
        return { remove: mockRemoveAppStateListener };
      },
    );
  });

  it.each([
    [
      settings({ permission: 'granted', enabled: true }),
      'Trip activity and join request updates are on.',
      true,
    ],
    [
      settings({ userPreference: false, permission: 'granted' }),
      'Turn on updates for trip activity and join requests.',
      false,
    ],
    [
      settings({ userPreference: true, permission: 'denied', canAskAgain: true }),
      'Turn on updates for trip activity and join requests.',
      false,
    ],
    [
      settings({ userPreference: true, permission: 'denied', canAskAgain: false }),
      'Blocked by Android. Tap the switch for help.',
      false,
    ],
  ])('shows the state-specific Android copy and a functional switch', async (
    snapshot, status, enabled,
  ) => {
    mockGetSettings.mockResolvedValue(snapshot);
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    const toggle = notificationSwitch(renderer);

    expect(statuses(renderer)).toEqual(expect.arrayContaining(['Notifications', status]));
    expect(toggle.props.value).toBe(enabled);
    expect(toggle.props.disabled).toBe(false);
    expect(toggle.props.onValueChange).toEqual(expect.any(Function));
    expect(toggle.props.pointerEvents).toBeUndefined();
    expect(toggle.props.accessibilityLabel).toBe('Trip notifications');
    expect(toggle.props.accessibilityHint).toEqual(expect.any(String));
    expect(row.props.onPress).toBeUndefined();
  });

  it('keeps the row visible and disabled while Android state is loading', () => {
    mockGetSettings.mockReturnValue(new Promise(() => {}));
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<NotificationSettingsRow />); });

    expect(statuses(renderer)).toContain('Checking notification status\u2026');
    expect(notificationSwitch(renderer).props.disabled).toBe(true);

    act(() => { renderer.unmount(); });
  });

  it('shows a clear, non-interactive unavailable state', async () => {
    mockGetSettings.mockResolvedValue(settings({
      permission: 'unavailable', canAskAgain: false,
    }));
    const renderer = await renderRow();

    expect(statuses(renderer)).toContain('Notifications are unavailable on this device.');
    expect(notificationSwitch(renderer).props.value).toBe(false);
    expect(notificationSwitch(renderer).props.disabled).toBe(true);
  });

  it.each(['web', 'ios'])('stays unavailable without native work on %s', async (platform) => {
    (Platform as any).OS = platform;
    const renderer = await renderRow();

    expect(statuses(renderer)).toContain('Notifications are unavailable on this device.');
    expect(notificationSwitch(renderer).props.disabled).toBe(true);
    expect(mockGetSettings).not.toHaveBeenCalled();
    expect(mockAddAppStateListener).not.toHaveBeenCalled();
  });

  it('enables in-app without opening Android settings when permission is granted', async () => {
    const renderer = await renderRow();

    await act(async () => { await notificationSwitch(renderer).props.onValueChange(true); });

    expect(mockSetEnabled).toHaveBeenCalledWith(true);
    expect(mockOpenSettings).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
    expect(notificationSwitch(renderer).props.value).toBe(true);
    expect(statuses(renderer)).toContain('Trip activity and join request updates are on.');
  });

  it('turns off directly without confirmation or Android settings', async () => {
    mockGetSettings.mockResolvedValue(settings({ permission: 'granted', enabled: true }));
    mockSetEnabled.mockResolvedValue(settings({
      userPreference: false, permission: 'granted', enabled: false,
    }));
    const renderer = await renderRow();

    await act(async () => { await notificationSwitch(renderer).props.onValueChange(false); });

    expect(mockSetEnabled).toHaveBeenCalledWith(false);
    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockOpenSettings).not.toHaveBeenCalled();
    expect(notificationSwitch(renderer).props.value).toBe(false);
  });

  it('does not offer Settings after a denial Android says can be requested again', async () => {
    mockSetEnabled.mockResolvedValue(settings({
      userPreference: true, permission: 'denied', canAskAgain: true,
    }));
    const renderer = await renderRow();

    await act(async () => { await notificationSwitch(renderer).props.onValueChange(true); });

    expect(mockAlert).not.toHaveBeenCalled();
    expect(statuses(renderer)).toContain('Turn on updates for trip activity and join requests.');
  });

  it('offers Android Settings only when permission requests are permanently blocked', async () => {
    mockSetEnabled.mockResolvedValue(settings({
      userPreference: true, permission: 'denied', canAskAgain: false,
    }));
    const renderer = await renderRow();

    await act(async () => { await notificationSwitch(renderer).props.onValueChange(true); });

    expect(mockAlert).toHaveBeenCalledWith(
      'Notifications blocked by Android',
      'Go to Settings > Apps > Trip Splitter > Notifications, then turn on Allow notifications.',
      expect.any(Array),
    );
    expect(mockOpenSettings).not.toHaveBeenCalled();

    await act(async () => { await alertButton('Open settings').onPress?.(); });
    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('leaves Settings closed when blocked-permission help is cancelled', async () => {
    mockSetEnabled.mockResolvedValue(settings({
      userPreference: true, permission: 'denied', canAskAgain: false,
    }));
    const renderer = await renderRow();
    await act(async () => { await notificationSwitch(renderer).props.onValueChange(true); });

    act(() => { alertButton('Cancel').onPress?.(); });

    expect(mockOpenSettings).not.toHaveBeenCalled();
  });

  it('deduplicates switch actions and disables the control while busy', async () => {
    let finish!: (snapshot: Settings) => void;
    mockSetEnabled.mockImplementationOnce(() => new Promise<Settings>((resolve) => { finish = resolve; }));
    const renderer = await renderRow();
    const initialToggle = notificationSwitch(renderer);
    let firstChange!: Promise<void>;

    act(() => {
      firstChange = initialToggle.props.onValueChange(true);
      void initialToggle.props.onValueChange(true);
    });

    expect(mockSetEnabled).toHaveBeenCalledTimes(1);
    expect(notificationSwitch(renderer).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: 'profile-notification-settings' }).props.style.opacity)
      .toBe(0.65);

    finish(settings({ userPreference: true, permission: 'granted', enabled: true }));
    await act(async () => { await firstChange; });
    expect(notificationSwitch(renderer).props.disabled).toBe(false);
  });

  it('refreshes the switch after returning from Android settings', async () => {
    mockGetSettings
      .mockResolvedValueOnce(settings({
        userPreference: true, permission: 'denied', canAskAgain: false,
      }))
      .mockResolvedValueOnce(settings({
        userPreference: true, permission: 'granted', enabled: true,
      }));
    const renderer = await renderRow();
    expect(notificationSwitch(renderer).props.value).toBe(false);

    await act(async () => {
      mockAppStateHandler?.('active');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(notificationSwitch(renderer).props.value).toBe(true);
    expect(statuses(renderer)).toContain('Trip activity and join request updates are on.');
  });

  it('ignores non-active AppState changes and removes its listener on cleanup', async () => {
    const renderer = await renderRow();
    mockGetSettings.mockClear();

    act(() => { mockAppStateHandler?.('background'); });
    expect(mockGetSettings).not.toHaveBeenCalled();

    act(() => { renderer.unmount(); });
    expect(mockRemoveAppStateListener).toHaveBeenCalledTimes(1);
  });

  it('explains how to recover if Android settings cannot be opened', async () => {
    mockSetEnabled.mockResolvedValue(settings({
      userPreference: true, permission: 'denied', canAskAgain: false,
    }));
    mockOpenSettings.mockRejectedValueOnce(new Error('unavailable'));
    const renderer = await renderRow();
    await act(async () => { await notificationSwitch(renderer).props.onValueChange(true); });

    await act(async () => { await alertButton('Open settings').onPress?.(); });

    expect(mockAlert).toHaveBeenLastCalledWith(
      'Unable to open settings',
      'Open Android Settings, select Trip Splitter, then choose Notifications.',
    );
  });
});
