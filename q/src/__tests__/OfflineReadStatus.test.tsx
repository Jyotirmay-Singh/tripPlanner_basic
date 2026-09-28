/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import OfflineReadStatus from '../OfflineReadStatus';

let mockWrites = true;

jest.mock('../AuthContext', () => ({ useAuth: () => ({ sessionMode: 'online' }) }));
jest.mock('../ThemeContext', () => ({ useTheme: () => ({ colors: {
  surfaceMuted: '#eee', border: '#ccc', textMain: '#111', textMuted: '#555',
} }) }));
jest.mock('../offlineActivation', () => ({ offlineWritesActive: () => mockWrites }));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../ConfirmModal', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('ConfirmModal', props) };
});

it('shows a dismissible offline notice with details only on tap and no sync time', async () => {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<OfflineReadStatus result={{ source: 'live' }} />);
  });
  expect(renderer!.root.findAllByProps({ testID: 'offline-read-status' })).toHaveLength(0);

  await act(async () => {
    renderer!.update(<OfflineReadStatus result={{ source: 'cache' }} />);
  });
  expect(renderer!.root.findByProps({ testID: 'offline-read-status' })).toBeTruthy();
  expect(JSON.stringify(renderer!.toJSON())).toContain("You're offline");
  const modal = renderer!.root.findByType('ConfirmModal' as any);
  expect(modal.props.visible).toBe(false);
  await act(async () => {
    renderer!.root.findByProps({ testID: 'offline-notice-details' }).props.onPress();
  });
  expect(modal.props.visible).toBe(true);
  expect(modal.props.message).toContain('add expenses and refunds');
  expect(modal.props.message).toContain('Pending sync');
  expect(modal.props.message).not.toMatch(/last synced|last successful sync/i);
  await act(async () => { modal.props.actions[0].onPress(); });
  await act(async () => {
    renderer!.root.findByProps({ testID: 'offline-notice-dismiss' }).props.onPress();
  });
  expect(renderer!.root.findAllByProps({ testID: 'offline-read-status' })).toHaveLength(0);

  await act(async () => {
    renderer!.update(<OfflineReadStatus result={{ source: 'live' }} />);
  });
  await act(async () => {
    renderer!.update(<OfflineReadStatus result={{ source: 'cache' }} />);
  });
  expect(renderer!.root.findByProps({ testID: 'offline-read-status' })).toBeTruthy();
  await act(async () => { renderer!.unmount(); });
});

it('describes only cached viewing while offline writes remain disabled', async () => {
  mockWrites = false;
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<OfflineReadStatus result={{ source: 'cache' }} />);
  });
  const modal = renderer!.root.findByType('ConfirmModal' as any);
  expect(modal.props.message).toContain('Adding expenses and payments needs a connection');
  await act(async () => { renderer!.unmount(); });
  mockWrites = true;
});
