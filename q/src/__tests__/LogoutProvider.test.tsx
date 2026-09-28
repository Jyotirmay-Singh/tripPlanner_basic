/* eslint-disable import/first */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

let mockModalProps: any;
jest.mock('../ConfirmModal', () => ({
  __esModule: true,
  default: (props: any) => { mockModalProps = props; return null; },
}));
jest.mock('../AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: jest.fn() }));

import { useAuth } from '../AuthContext';
import { useRouter } from 'expo-router';
import { LogoutProvider } from '../LogoutProvider';
import { useLogout } from '../useLogout';

let logout: ReturnType<typeof useLogout>;
function Consumer() { logout = useLogout(); return null; }

it('warns about same-account pending actions and retains them on sign-out', async () => {
  const signOut = jest.fn(async () => {});
  const pendingActionCount = jest.fn(async () => 2);
  (useAuth as jest.Mock).mockReturnValue({ signOut, pendingActionCount });
  (useRouter as jest.Mock).mockReturnValue({ canDismiss: () => false, dismissAll: jest.fn(), replace: jest.fn() });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LogoutProvider><Consumer /></LogoutProvider>);
  });
  await act(async () => { logout.confirmAndSignOut(); await Promise.resolve(); });
  expect(mockModalProps.message).toMatch(/2 pending actions will stay on this device/i);
  expect(mockModalProps.message).toMatch(/same account/i);
  await act(async () => { mockModalProps.actions[0].onPress(); });
  expect(signOut).not.toHaveBeenCalled();
  await act(async () => { logout.confirmAndSignOut(); await Promise.resolve(); });
  await act(async () => { mockModalProps.actions[1].onPress(); await Promise.resolve(); });
  expect(signOut).toHaveBeenCalledTimes(1);
  act(() => renderer!.unmount());
});
