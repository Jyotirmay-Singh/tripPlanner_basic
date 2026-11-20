/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

let mockUser: any;
const mockApi = jest.fn();
jest.mock('expo-router', () => {
  const R = require('react');
  return { useFocusEffect: (effect: any) => R.useEffect(effect, [effect]) };
});
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../api', () => ({
  api: (...args: any[]) => mockApi(...args),
  getToken: jest.fn(),
  reportedReceiptUrl: jest.fn(),
}));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('Text', props, props.children) };
});
jest.mock('../ui', () => {
  const R = require('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return { Screen: host('Screen'), Card: host('Card'), Input: host('Input'), Button: host('Button') };
});

import Moderation from '../../app/moderation';

beforeEach(() => {
  mockUser = { id: 'operator-a', is_super_admin: true };
  mockApi.mockReset();
});

it('clears sensitive cases immediately and cancels old requests when the account changes', async () => {
  const report = { id: 'private-case-a', target_type: 'message', target_id: 'm', trip_id: 't',
    reason: 'privacy', details: 'Sensitive report from account A', status: 'open' };
  mockApi.mockImplementation((path: string) => Promise.resolve({ items: path.endsWith('/reports') ? [report] : [] }));
  let view: any;
  await act(async () => { view = TestRenderer.create(<Moderation />); });
  expect(view.root.findAllByProps({ testID: 'moderation-case-private-case-a' }).length).toBeGreaterThan(0);
  const oldSignal = mockApi.mock.calls[0][1].signal;

  let finishOldRequest: (value: any) => void = () => {};
  mockApi.mockImplementationOnce(() => new Promise((resolve) => { finishOldRequest = resolve; }));
  await act(async () => { view.root.findByProps({ label: 'Refresh queue' }).props.onPress(); });
  mockUser = { id: 'operator-b', is_super_admin: true };
  mockApi.mockImplementation(() => new Promise(() => {}));
  await act(async () => { view.update(<Moderation />); });
  expect(oldSignal.aborted).toBe(true);
  expect(view.root.findAllByProps({ testID: 'moderation-case-private-case-a' })).toHaveLength(0);
  await act(async () => { finishOldRequest({ items: [report] }); });
  expect(view.root.findAllByProps({ testID: 'moderation-case-private-case-a' })).toHaveLength(0);
  act(() => view.unmount());
});

it('denies a non-administrator without requesting the moderation queue', async () => {
  mockUser = { id: 'ordinary-member', is_super_admin: false };
  let view: any;
  await act(async () => { view = TestRenderer.create(<Moderation />); });
  expect(mockApi).not.toHaveBeenCalled();
  expect(JSON.stringify(view.toJSON())).toContain('Application administrator access is required.');
  act(() => view.unmount());
});
