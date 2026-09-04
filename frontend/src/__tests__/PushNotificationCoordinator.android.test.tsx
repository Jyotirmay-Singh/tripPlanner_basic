/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockRouterPush = jest.fn();
const mockRouter = { push: mockRouterPush };
const mockApi = jest.fn();
const mockHandleAuthenticationRequired = jest.fn();
const mockSyncRegistration = jest.fn();
const mockGetLastResponse = jest.fn();
const mockClearLastResponse = jest.fn();
const mockAddResponseListener = jest.fn();
const mockRemoveResponseListener = jest.fn();
const mockAddReceivedListener = jest.fn();
const mockRemoveReceivedListener = jest.fn();
const mockAddAppStateListener = jest.fn();
const mockRemoveAppStateListener = jest.fn();

let mockUser: { id: string } | null | undefined = { id: 'user-1' };
let mockSegments: string[] = ['(tabs)', 'dashboard'];
let mockResponseHandler: ((response: any) => void) | undefined;
let mockReceivedHandler: ((notification: any) => void) | undefined;
let mockAppStateHandler: ((state: string) => void) | undefined;
let mockCurrentAppState = 'active';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() { return mockCurrentAppState; },
    addEventListener: mockAddAppStateListener,
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useSegments: () => mockSegments,
}));

jest.mock('expo-notifications', () => ({
  __esModule: true,
  getLastNotificationResponse: mockGetLastResponse,
  clearLastNotificationResponse: mockClearLastResponse,
  addNotificationResponseReceivedListener: mockAddResponseListener,
  addNotificationReceivedListener: mockAddReceivedListener,
}));

jest.mock('../api', () => ({ api: mockApi }));

jest.mock('../AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    handleAuthenticationRequired: mockHandleAuthenticationRequired,
  }),
}));

jest.mock('../pushNotifications', () => ({
  syncPushRegistrationIfEligible: mockSyncRegistration,
}));

const PushNotificationCoordinator = require('../PushNotificationCoordinator.android').default;

const TRIP_ID = '12345678-1234-4678-9234-567812345678';
const SOURCE_ID = '87654321-4321-4765-8123-210987654321';

function payload(
  eventType: 'expense.created' | 'payment.recorded' | 'settlement.paid' | 'chat.message.created',
  target: 'trip_expenses' | 'settle_up' | 'trip_chat',
  idKey: 'expenseId' | 'paymentId' | 'settlementId' | 'messageId',
) {
  return {
    payloadVersion: 1,
    eventKey: `${eventType}:${SOURCE_ID}`,
    eventType,
    tripId: TRIP_ID,
    target,
    sourceId: SOURCE_ID,
    [idKey]: SOURCE_ID,
  };
}

function response(identifier: string, data: Record<string, unknown>) {
  return {
    notification: {
      request: {
        identifier,
        content: { data },
      },
    },
  };
}

function notification(identifier: string, data: Record<string, unknown>) {
  return response(identifier, data).notification;
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderCoordinator() {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<PushNotificationCoordinator />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

describe('Android push notification coordinator', () => {
  let info: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    mockUser = { id: 'user-1' };
    mockSegments = ['(tabs)', 'dashboard'];
    mockResponseHandler = undefined;
    mockReceivedHandler = undefined;
    mockAppStateHandler = undefined;
    mockCurrentAppState = 'active';
    mockGetLastResponse.mockReturnValue(null);
    mockApi.mockResolvedValue({ id: TRIP_ID });
    mockSyncRegistration.mockResolvedValue('granted');
    mockHandleAuthenticationRequired.mockResolvedValue(undefined);
    mockAddResponseListener.mockImplementation((handler: (value: any) => void) => {
      mockResponseHandler = handler;
      return { remove: mockRemoveResponseListener };
    });
    mockAddReceivedListener.mockImplementation((handler: (value: any) => void) => {
      mockReceivedHandler = handler;
      return { remove: mockRemoveReceivedListener };
    });
    mockAddAppStateListener.mockImplementation((_event: string, handler: (state: string) => void) => {
      mockAppStateHandler = handler;
      return { remove: mockRemoveAppStateListener };
    });
  });

  afterEach(() => info.mockRestore());

  it('synchronizes on sign-in, first trip navigation, and foreground return', async () => {
    const renderer = await renderCoordinator();

    expect(mockSyncRegistration).toHaveBeenCalledTimes(1);
    expect(mockSyncRegistration).toHaveBeenLastCalledWith({ allowPermissionPrompt: true });

    act(() => { mockAppStateHandler?.('background'); });
    expect(mockSyncRegistration).toHaveBeenCalledTimes(1);

    act(() => { mockAppStateHandler?.('active'); });
    expect(mockSyncRegistration).toHaveBeenCalledTimes(2);

    mockSegments = ['trip', TRIP_ID];
    await act(async () => {
      renderer.update(<PushNotificationCoordinator />);
      await Promise.resolve();
    });
    expect(mockSyncRegistration).toHaveBeenCalledTimes(3);
  });

  it('authorizes and handles a terminated-app expense notification', async () => {
    mockGetLastResponse.mockReturnValue(response(
      'notification-1', payload('expense.created', 'trip_expenses', 'expenseId'),
    ));

    await renderCoordinator();
    await flushAsyncWork();

    expect(mockApi).toHaveBeenCalledWith(`/trips/${TRIP_ID}`);
    expect(mockRouterPush).toHaveBeenCalledWith(
      `/trip/${TRIP_ID}?tab=expenses&expenseId=${SOURCE_ID}`,
    );
    expect(mockClearLastResponse).toHaveBeenCalledTimes(1);
  });

  it('routes a background response once and rejects invalid or duplicate notifications', async () => {
    await renderCoordinator();
    mockCurrentAppState = 'background';
    const valid = response(
      'notification-2', payload('payment.recorded', 'settle_up', 'paymentId'),
    );

    await act(async () => {
      mockResponseHandler?.(response('invalid', {
        ...payload('expense.created', 'trip_expenses', 'expenseId'),
        tripId: 'not-a-trip-id',
      }));
      mockResponseHandler?.(valid);
      mockResponseHandler?.(valid);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(
      `/trip/${TRIP_ID}/settle-up?paymentId=${SOURCE_ID}`,
    );
    expect(mockClearLastResponse).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(
      '[push-notifications] response_accepted',
      expect.objectContaining({ appState: 'background' }),
    );
  });

  it('deduplicates the same event even when Android supplies another notification id', async () => {
    await renderCoordinator();
    const data = payload('chat.message.created', 'trip_chat', 'messageId');

    await act(async () => {
      mockResponseHandler?.(response('notification-a', data));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      mockResponseHandler?.(response('notification-b', data));
      await Promise.resolve();
    });

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(
      `/trip/${TRIP_ID}?tab=chat&messageId=${SOURCE_ID}`,
    );
  });

  it('keeps a destination pending until authentication leaves the auth stack', async () => {
    mockUser = null;
    mockSegments = ['(auth)', 'login'];
    mockGetLastResponse.mockReturnValue(response(
      'notification-3', payload('expense.created', 'trip_expenses', 'expenseId'),
    ));
    const renderer = await renderCoordinator();
    expect(mockRouterPush).not.toHaveBeenCalled();

    mockUser = { id: 'user-1' };
    mockSegments = ['(tabs)', 'dashboard'];
    await act(async () => {
      renderer.update(<PushNotificationCoordinator />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockRouterPush).toHaveBeenCalledWith(
      `/trip/${TRIP_ID}?tab=expenses&expenseId=${SOURCE_ID}`,
    );
  });

  it('rejects navigation when current trip authorization was removed', async () => {
    mockApi.mockRejectedValueOnce({ status: 403 });
    mockGetLastResponse.mockReturnValue(response(
      'notification-4', payload('settlement.paid', 'settle_up', 'settlementId'),
    ));

    await renderCoordinator();
    await flushAsyncWork();

    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      '[push-notifications] navigation_rejected',
      expect.objectContaining({ reason: 'trip_access_removed' }),
    );
  });

  it('retries a transient trip check when the app returns to the foreground', async () => {
    mockApi.mockRejectedValueOnce({ code: 'network' }).mockResolvedValueOnce({ id: TRIP_ID });
    mockGetLastResponse.mockReturnValue(response(
      'notification-5', payload('chat.message.created', 'trip_chat', 'messageId'),
    ));
    await renderCoordinator();
    await flushAsyncWork();
    expect(mockRouterPush).not.toHaveBeenCalled();

    act(() => { mockAppStateHandler?.('active'); });
    await flushAsyncWork();

    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(mockRouterPush).toHaveBeenCalledWith(
      `/trip/${TRIP_ID}?tab=chat&messageId=${SOURCE_ID}`,
    );
  });

  it('records a privacy-safe foreground receipt diagnostic', async () => {
    await renderCoordinator();

    act(() => {
      mockReceivedHandler?.(notification(
        'foreground-1', payload('expense.created', 'trip_expenses', 'expenseId'),
      ));
    });

    expect(info).toHaveBeenCalledWith(
      '[push-notifications] notification_received',
      expect.objectContaining({ eventKey: `expense.created:${SOURCE_ID}`, appState: 'active' }),
    );
  });

  it('removes native listeners when the coordinator unmounts', async () => {
    const renderer = await renderCoordinator();

    act(() => { renderer.unmount(); });

    expect(mockRemoveResponseListener).toHaveBeenCalledTimes(1);
    expect(mockRemoveReceivedListener).toHaveBeenCalledTimes(1);
    expect(mockRemoveAppStateListener).toHaveBeenCalledTimes(1);
  });
});
