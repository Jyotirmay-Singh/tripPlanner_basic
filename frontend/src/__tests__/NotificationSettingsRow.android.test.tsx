/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetPermissionState = jest.fn();
const mockEnableNotifications = jest.fn();

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(callback, [callback]);
  },
}));

jest.mock('../pushNotifications', () => ({
  getPushPermissionState: mockGetPermissionState,
  enablePushNotificationsFromSettings: mockEnableNotifications,
}));

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: { primary: '#00aa88', textMuted: '#888888' },
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

const NotificationSettingsRow = require('../NotificationSettingsRow.android').default;

async function renderRow() {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<NotificationSettingsRow />);
    await Promise.resolve();
  });
  return renderer!;
}

describe('Android Profile notification settings row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPermissionState.mockResolvedValue('undetermined');
    mockEnableNotifications.mockResolvedValue('granted');
  });

  it.each(['granted', 'unavailable'])('stays hidden when permission is %s', async (state) => {
    mockGetPermissionState.mockResolvedValue(state);
    const renderer = await renderRow();

    expect(renderer.toJSON()).toBeNull();
  });

  it('offers Enable notifications while Android permission is undecided', async () => {
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });

    expect(row.props.accessibilityLabel).toBe('Enable notifications');
    expect(renderer.root.findAllByType('T' as any).map((node: any) => node.props.children))
      .toContain('Enable notifications');
  });

  it('offers Android notification settings after permission was denied', async () => {
    mockGetPermissionState.mockResolvedValue('denied');
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });

    expect(row.props.accessibilityLabel).toBe('Open notification settings');
    expect(renderer.root.findAllByType('T' as any).map((node: any) => node.props.children))
      .toContain('Notification settings');
  });

  it('updates from undecided to hidden after permission is granted', async () => {
    const renderer = await renderRow();
    const row = renderer.root.findByProps({ testID: 'profile-notification-settings' });

    await act(async () => {
      await row.props.onPress();
    });

    expect(mockEnableNotifications).toHaveBeenCalledTimes(1);
    expect(renderer.toJSON()).toBeNull();
  });

  it('ignores a second press while the first settings request is still active', async () => {
    let finish!: (state: string) => void;
    mockEnableNotifications.mockImplementationOnce(() => (
      new Promise((resolve) => { finish = resolve; })
    ));
    const renderer = await renderRow();
    const initialRow = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    let firstPress!: Promise<void>;

    act(() => {
      firstPress = initialRow.props.onPress();
    });
    const busyRow = renderer.root.findByProps({ testID: 'profile-notification-settings' });
    await act(async () => {
      await busyRow.props.onPress();
    });

    expect(mockEnableNotifications).toHaveBeenCalledTimes(1);
    expect(busyRow.props.style.opacity).toBe(0.65);

    finish('undetermined');
    await act(async () => {
      await firstPress;
    });
  });
});
