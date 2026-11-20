import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { CommunityProvider, useCommunity } from '../CommunityProvider';
import { ApiError } from '../api';

let mockUser: any;
const mockGetState = jest.fn();
const mockRefreshProfile = jest.fn().mockResolvedValue(undefined);
jest.mock('@react-native-async-storage/async-storage', () => jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: mockUser, sessionMode: 'online', refreshUserProfile: mockRefreshProfile }) }));
jest.mock('../communitySafety', () => ({
  COMMUNITY_TERMS_VERSION: '2026-11-13', getCommunityState: () => mockGetState(),
}));

it('keeps a restored or switched account loading until its own policy result arrives', async () => {
  mockUser = undefined;
  const observed: { loading: boolean; state: unknown; error: string | null }[] = [];
  function Probe() {
    const { loading, state, error } = useCommunity();
    observed.push({ loading, state, error });
    return null;
  }
  const screen = () => <CommunityProvider><Probe /></CommunityProvider>;
  let view: any;
  await act(async () => { view = TestRenderer.create(screen()); });
  let complete: (value: any) => void = () => {};
  mockGetState.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  mockUser = { id: 'restored-account' };
  const fromRestore = observed.length;
  await act(async () => { view.update(screen()); });
  expect(observed.slice(fromRestore).every((entry) => entry.loading && entry.state === null)).toBe(true);
  const accepted = { accepted: true, permissions: { account: true } };
  await act(async () => { complete(accepted); });
  expect(observed.at(-1)).toMatchObject({ loading: false, state: accepted });

  let reject: (error: Error) => void = () => {};
  mockGetState.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  mockUser = { id: 'different-account' };
  const fromSwitch = observed.length;
  await act(async () => { view.update(screen()); });
  expect(observed.slice(fromSwitch).every((entry) => entry.loading && entry.state === null)).toBe(true);
  await act(async () => { reject(new Error('Reconnect to review safety settings')); });
  expect(observed.at(-1)).toMatchObject({ loading: false, state: null, error: 'Reconnect to review safety settings' });
  act(() => view.unmount());
});

it('keeps same-account verified policy during an outage but clears an explicit server denial', async () => {
  mockUser = { id: 'verified-account' };
  const accepted = { accepted: true, permissions: { account: true } };
  mockGetState.mockResolvedValueOnce(accepted);
  mockRefreshProfile.mockClear();
  let current: ReturnType<typeof useCommunity>;
  function Probe() { current = useCommunity(); return null; }
  let view: any;
  await act(async () => { view = TestRenderer.create(<CommunityProvider><Probe /></CommunityProvider>); });
  expect(current!.state).toEqual(accepted);

  mockGetState.mockRejectedValueOnce(new ApiError('Could not reach the server', { code: 'network' }));
  await act(async () => { await current!.refresh(); });
  expect(current!.state).toEqual(accepted);
  expect(current!.loading).toBe(false);
  expect(mockRefreshProfile).toHaveBeenCalledTimes(1);

  mockGetState.mockRejectedValueOnce(new ApiError('Access revoked', { code: 'http', status: 403 }));
  await act(async () => { await current!.refresh(); });
  expect(current!.state).toBeNull();
  expect(current!.error).toBe('Access revoked');
  expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
  act(() => view.unmount());
});
