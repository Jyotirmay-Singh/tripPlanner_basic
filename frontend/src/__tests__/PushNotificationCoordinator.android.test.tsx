/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockRouterPush = jest.fn();
const mockRouter = { push: mockRouterPush };
const mockSyncRegistration = jest.fn();
const mockGetLastResponse = jest.fn();
const mockClearLastResponse = jest.fn();
const mockAddResponseListener = jest.fn();
const mockRemoveResponseListener = jest.fn();
const mockAddAppStateListener = jest.fn();
const mockRemoveAppStateListener = jest.fn();

let mockUser: { id: string } | null | undefined = { id: 'user-1' };
let mockSegments: string[] = ['(tabs)', 'dashboard'];
let mockResponseHandler: ((response: any) => void) | undefined;
let mockAppStateHandler: ((state: string) => void) | undefined;

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: mockAddAppStateListener },
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
}));

jest.mock('../AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

jest.mock('../pushNotifications', () => ({
  syncPushRegistrationIfEligible: mockSyncRegistration,
}));

const PushNotificationCoordinator = require('../PushNotificationCoordinator.android').default;

const TRIP_ID = '12345678-1234-4678-9234-567812345678';

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

async function renderCoordinator() {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<PushNotificationCoordinator />);
    await Promise.resolve();
  });
  return renderer!;
}

describe('Android push notification coordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'user-1' };
    mockSegments = ['(tabs)', 'dashboard'];
    mockResponseHandler = undefined;
    mockAppStateHandler = undefined;
    mockGetLastResponse.mockReturnValue(null);
    mockSyncRegistration.mockResolvedValue('granted');
    mockAddResponseListener.mockImplementation((handler: (value: any) => void) => {
      mockResponseHandler = handler;
      return { remove: mockRemoveResponseListener };
    });
    mockAddAppStateListener.mockImplementation((_event: string, handler: (state: string) => void) => {
      mockAppStateHandler = handler;
      return { remove: mockRemoveAppStateListener };
    });
  });

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

  it('handles a cold expense notification and clears the saved native response', async () => {
    mockGetLastResponse.mockReturnValue(response('notification-1', {
      eventKey: 'expense.created:expense-1',
      tripId: TRIP_ID,
      target: 'trip_expenses',
    }));

    await renderCoordinator();

    expect(mockRouterPush).toHaveBeenCalledWith(`/trip/${TRIP_ID}?tab=expenses`);
    expect(mockClearLastResponse).toHaveBeenCalledTimes(1);
  });

  it('routes settlement activity once and ignores invalid or duplicate responses', async () => {
    await renderCoordinator();
    const valid = response('notification-2', {
      eventKey: 'payment.recorded:payment-1',
      tripId: TRIP_ID,
      target: 'settle_up',
    });

    await act(async () => {
      mockResponseHandler?.(response('invalid', {
        eventKey: 'expense.created:expense-1',
        tripId: 'not-a-trip-id',
        target: 'trip_expenses',
      }));
      mockResponseHandler?.(valid);
      mockResponseHandler?.(valid);
      await Promise.resolve();
    });

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(`/trip/${TRIP_ID}/settle-up`);
    // Invalid data is still consumed safely, while the duplicate identifier is ignored outright.
    expect(mockClearLastResponse).toHaveBeenCalledTimes(2);
  });

  it('keeps a notification destination pending until authentication leaves the auth stack', async () => {
    mockUser = null;
    mockSegments = ['(auth)', 'login'];
    mockGetLastResponse.mockReturnValue(response('notification-3', {
      eventKey: 'expense.created:expense-2',
      tripId: TRIP_ID,
      target: 'trip_expenses',
    }));
    const renderer = await renderCoordinator();
    expect(mockRouterPush).not.toHaveBeenCalled();

    mockUser = { id: 'user-1' };
    mockSegments = ['(tabs)', 'dashboard'];
    await act(async () => {
      renderer.update(<PushNotificationCoordinator />);
      await Promise.resolve();
    });

    expect(mockRouterPush).toHaveBeenCalledWith(`/trip/${TRIP_ID}?tab=expenses`);
  });

  it('removes native listeners when the coordinator unmounts', async () => {
    const renderer = await renderCoordinator();

    act(() => { renderer.unmount(); });

    expect(mockRemoveResponseListener).toHaveBeenCalledTimes(1);
    expect(mockRemoveAppStateListener).toHaveBeenCalledTimes(1);
  });
});
