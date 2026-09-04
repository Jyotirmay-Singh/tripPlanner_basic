/* eslint-disable @typescript-eslint/no-require-imports */

const mockStorage = new Map<string, string>();
const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
const mockMultiSet = jest.fn();
const mockAlert = jest.fn();
const mockOpenSettings = jest.fn();
const mockSetNotificationHandler = jest.fn();
const mockSetNotificationChannel = jest.fn();
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetExpoPushToken = jest.fn();
const mockApi = jest.fn();
const mockConstants: {
  expoConfig: { extra: { eas: { projectId: string } } } | null;
  easConfig: { projectId?: string } | null;
} = {
  expoConfig: { extra: { eas: { projectId: 'test-project-id' } } },
  easConfig: null,
};

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: mockGetItem,
    setItem: mockSetItem,
    multiSet: mockMultiSet,
  },
}));

jest.mock('react-native', () => {
  return {
    Platform: { OS: 'android' },
    Alert: { alert: mockAlert },
    Linking: { openSettings: mockOpenSettings },
  };
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: mockConstants,
}));

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => '12345678-1234-4678-9234-567812345678'),
}));

jest.mock('expo-notifications', () => ({
  __esModule: true,
  setNotificationHandler: mockSetNotificationHandler,
  setNotificationChannelAsync: mockSetNotificationChannel,
  getPermissionsAsync: mockGetPermissions,
  requestPermissionsAsync: mockRequestPermissions,
  getExpoPushTokenAsync: mockGetExpoPushToken,
  PermissionStatus: {
    GRANTED: 'granted',
    DENIED: 'denied',
    UNDETERMINED: 'undetermined',
  },
  AndroidImportance: { HIGH: 4 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
}));

jest.mock('../api', () => ({ api: mockApi }));

const {
  enablePushNotificationsFromSettings,
  getPushPermissionState,
  syncPushRegistrationIfEligible,
  unregisterCurrentPushInstallation,
} = require('../pushNotifications.android');

type PermissionName = 'granted' | 'denied' | 'undetermined';

function permission(status: PermissionName) {
  return {
    status,
    granted: status === 'granted',
    canAskAgain: status !== 'denied',
    expires: 'never',
  };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function pressRationale(label: 'Not now' | 'Enable notifications') {
  await flushAsyncWork();
  const buttons = mockAlert.mock.calls.at(-1)?.[2] as {
    text: string;
    onPress: () => void;
  }[];
  const button = buttons?.find((candidate) => candidate.text === label);
  expect(button).toBeDefined();
  button!.onPress();
  await flushAsyncWork();
}

describe('Android push notification registration', () => {
  let info: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    mockStorage.clear();
    mockConstants.expoConfig = { extra: { eas: { projectId: 'test-project-id' } } };
    mockConstants.easConfig = null;
    mockGetItem.mockImplementation(async (key: string) => mockStorage.get(key) ?? null);
    mockSetItem.mockImplementation(async (key: string, value: string) => {
      mockStorage.set(key, value);
    });
    mockMultiSet.mockImplementation(async (entries: [string, string][]) => {
      entries.forEach(([key, value]) => mockStorage.set(key, value));
    });
    mockOpenSettings.mockResolvedValue(undefined);
    mockSetNotificationChannel.mockResolvedValue(null);
    mockGetPermissions.mockResolvedValue(permission('undetermined'));
    mockRequestPermissions.mockResolvedValue(permission('granted'));
    mockGetExpoPushToken.mockResolvedValue({ data: 'ExpoPushToken[test-token-value]' });
    mockApi.mockImplementation(async (path: string) => (
      path === '/trips' ? [{ id: 'trip-1' }] : { ok: true }
    ));
  });

  afterEach(() => info.mockRestore());

  it('does not prompt or register a signed-in account without any trips', async () => {
    mockApi.mockResolvedValueOnce([]);

    await expect(syncPushRegistrationIfEligible({ allowPermissionPrompt: true }))
      .resolves.toBe('undetermined');

    expect(mockSetNotificationChannel).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockGetExpoPushToken).not.toHaveBeenCalled();
  });

  it('shows the private rationale once and remembers Not now without a system prompt', async () => {
    const firstSync = syncPushRegistrationIfEligible({ allowPermissionPrompt: true });
    await pressRationale('Not now');

    await expect(firstSync).resolves.toBe('undetermined');
    expect(mockAlert).toHaveBeenCalledWith(
      'Stay updated on your trips',
      expect.stringContaining('Amounts, names, and message text are never shown on the lock screen.'),
      expect.any(Array),
      { cancelable: false },
    );
    expect(mockStorage.get('push_rationale_seen')).toBe('true');
    expect(mockStorage.get('push_rationale_accepted')).toBe('false');
    expect(mockRequestPermissions).not.toHaveBeenCalled();

    await expect(syncPushRegistrationIfEligible({ allowPermissionPrompt: true }))
      .resolves.toBe('undetermined');
    expect(mockAlert).toHaveBeenCalledTimes(1);
  });

  it('requests Android permission and registers the installation after Enable notifications', async () => {
    const sync = syncPushRegistrationIfEligible({ allowPermissionPrompt: true });
    await pressRationale('Enable notifications');

    await expect(sync).resolves.toBe('granted');
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockSetNotificationChannel).toHaveBeenCalledWith('trip_activity', expect.objectContaining({
      name: 'Trip activity',
      description: 'Private updates for expenses, payments, settlements, and group messages',
      importance: 4,
      lockscreenVisibility: 0,
    }));
    expect(mockGetExpoPushToken).toHaveBeenCalledWith({ projectId: 'test-project-id' });
    expect(mockApi).toHaveBeenCalledWith(
      '/push/devices/12345678-1234-4678-9234-567812345678',
      {
        method: 'PUT',
        body: { token: 'ExpoPushToken[test-token-value]', platform: 'android' },
      },
    );
  });

  it('registers an already-granted installation without showing either prompt', async () => {
    mockGetPermissions.mockResolvedValue(permission('granted'));

    await expect(syncPushRegistrationIfEligible({ allowPermissionPrompt: true }))
      .resolves.toBe('granted');

    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockGetExpoPushToken).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable without requesting a token when the EAS project ID is absent', async () => {
    mockConstants.expoConfig = null;
    mockGetPermissions.mockResolvedValue(permission('granted'));

    await expect(syncPushRegistrationIfEligible({ allowPermissionPrompt: false }))
      .resolves.toBe('unavailable');

    expect(mockGetExpoPushToken).not.toHaveBeenCalled();
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith('/trips');
  });

  it('does not prompt when trip eligibility cannot be checked offline', async () => {
    mockApi.mockRejectedValueOnce(new Error('offline'));

    await expect(syncPushRegistrationIfEligible({ allowPermissionPrompt: true }))
      .resolves.toBe('undetermined');

    expect(mockSetNotificationChannel).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  it('returns denied when the system prompt is denied and does not request a token', async () => {
    mockRequestPermissions.mockResolvedValue(permission('denied'));
    const sync = syncPushRegistrationIfEligible({ allowPermissionPrompt: true });
    await pressRationale('Enable notifications');

    await expect(sync).resolves.toBe('denied');
    expect(mockGetExpoPushToken).not.toHaveBeenCalled();
  });

  it('deactivates a previously registered installation after permission is revoked', async () => {
    mockStorage.set('push_installation_id', '12345678-1234-4678-9234-567812345678');
    mockGetPermissions.mockResolvedValue(permission('denied'));

    await expect(syncPushRegistrationIfEligible({ allowPermissionPrompt: false }))
      .resolves.toBe('denied');

    expect(mockApi).toHaveBeenCalledWith('/trips');
    expect(mockApi).toHaveBeenCalledWith(
      '/push/devices/12345678-1234-4678-9234-567812345678?reason=permission_denied',
      { method: 'DELETE' },
    );
    expect(mockGetExpoPushToken).not.toHaveBeenCalled();
  });

  it('opens Android settings for denied permission and rechecks the resulting state', async () => {
    mockGetPermissions
      .mockResolvedValueOnce(permission('denied'))
      .mockResolvedValueOnce(permission('granted'));

    await expect(enablePushNotificationsFromSettings()).resolves.toBe('granted');

    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    // Registration is retried by the coordinator's AppState listener when settings returns.
    expect(mockGetExpoPushToken).not.toHaveBeenCalled();
  });

  it('requests undecided permission directly from Profile and registers when granted', async () => {
    mockGetPermissions
      .mockResolvedValueOnce(permission('undetermined'))
      .mockResolvedValueOnce(permission('granted'));

    await expect(enablePushNotificationsFromSettings()).resolves.toBe('granted');

    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockStorage.get('push_rationale_seen')).toBe('true');
    expect(mockStorage.get('push_rationale_accepted')).toBe('true');
    expect(mockGetExpoPushToken).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent foreground registration attempts', async () => {
    let releaseTrips!: (value: { id: string }[]) => void;
    mockApi.mockImplementationOnce(() => new Promise((resolve) => { releaseTrips = resolve; }));

    const first = syncPushRegistrationIfEligible({ allowPermissionPrompt: false });
    const second = syncPushRegistrationIfEligible({ allowPermissionPrompt: false });
    expect(second).toBe(first);

    releaseTrips([]);
    await expect(first).resolves.toBe('undetermined');
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable without leaking native or network errors', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetPermissions.mockResolvedValue(permission('granted'));
    mockGetExpoPushToken.mockRejectedValue(new Error('token=private-value'));

    await expect(syncPushRegistrationIfEligible({ allowPermissionPrompt: false }))
      .resolves.toBe('unavailable');

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      '[push-notifications] registration_unavailable',
      { reason: 'native_token_error' },
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('private-value');
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it('reports permission state without prompting', async () => {
    mockGetPermissions.mockResolvedValue(permission('denied'));

    await expect(getPushPermissionState()).resolves.toBe('denied');
    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  it('unregisters only a persisted installation and never blocks logout on failure', async () => {
    await unregisterCurrentPushInstallation();
    expect(mockApi).not.toHaveBeenCalled();

    mockStorage.set('push_installation_id', '12345678-1234-4678-9234-567812345678');
    mockApi.mockRejectedValueOnce(new Error('offline'));
    await expect(unregisterCurrentPushInstallation()).resolves.toBeUndefined();
    expect(mockApi).toHaveBeenCalledWith(
      '/push/devices/12345678-1234-4678-9234-567812345678',
      { method: 'DELETE' },
    );
  });
});
