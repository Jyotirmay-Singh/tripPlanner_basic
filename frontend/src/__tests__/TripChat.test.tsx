/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockToastShow = jest.fn();

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }),
}));

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      background: '#f7f5f0', surface: '#fff', surfaceMuted: '#eee', primary: '#1c3f39',
      primaryText: '#fff', textMain: '#111', textMuted: '#666', border: '#ddd',
      success: '#080', danger: '#c00',
    },
  }),
}));
jest.mock('../T', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(RN.Text, props, props.children) };
});
jest.mock('../ConfirmModal', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('ConfirmModal', props) };
});
jest.mock('../ui', () => {
  const R = require('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    ActionSheet: host('ActionSheet'), Button: host('Button'), Icon: host('Icon'),
    IconButton: host('IconButton'), useToast: () => ({ show: mockToastShow }),
  };
});

import TripChat from '../TripChat';
import type { TripChatController } from '../useTripChat';

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => { jest.runOnlyPendingTimers(); });
  jest.useRealTimers();
});

const baseController = (): TripChatController => ({
  messages: [
    {
      id: 'm1', client_message_id: 'c1', trip_id: 't1', sequence: 1,
      sender_user_id: 'u2', sender_person_id: 'p2', sender_name: 'Priya',
      sender_family_name: 'Sharma Family', text: 'Landing at eight',
      created_at: '2026-08-22T10:00:00Z', edited_at: null, deleted_at: null,
    },
    {
      id: 'm2', client_message_id: 'c2', trip_id: 't1', sequence: 2,
      sender_user_id: 'u1', sender_person_id: 'p1', sender_name: 'Ravi',
      sender_family_name: null, text: 'I will be there',
      created_at: '2026-08-22T10:01:00Z', edited_at: '2026-08-22T10:02:00Z', deleted_at: null,
    },
  ],
  unreadCount: 0, loading: false, loadingOlder: false, hasMoreBefore: false, connected: true,
  connection: { status: 'connected', attempt: 0 },
  refreshUnread: jest.fn(), loadLatest: jest.fn(), loadOlder: jest.fn(),
  reconnect: jest.fn(),
  send: jest.fn().mockResolvedValue({ created: true, sent: true }),
  retry: jest.fn().mockResolvedValue(true), edit: jest.fn(), remove: jest.fn(),
  clear: jest.fn(), markThrough: jest.fn().mockResolvedValue(undefined),
});

function textContent(renderer: any): string {
  return renderer.root.findAllByType(Text).map((node: any) => node.props.children).flat(Infinity).join(' ');
}

it('renders every sender label, family context, edited state, and composer limit', async () => {
  const controller = baseController();
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <TripChat header={<Text>Trip header</Text>} controller={controller} currentUserId="u1" isOwner canSend />,
    );
  });

  const text = textContent(renderer);
  expect(text).toContain('Priya · Sharma Family');
  expect(text).toContain('Ravi');
  expect(text).toContain('· You');
  expect(text).toContain('edited');
  expect(renderer.root.findByProps({ testID: 'chat-composer' }).props.maxLength).toBe(2000);
  expect(renderer.root.findByProps({ testID: 'chat-owner-options' })).toBeTruthy();
  act(() => renderer.unmount());
});

it('highlights the message selected by a notification deep link', async () => {
  const controller = baseController();
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <TripChat
        header={null}
        controller={controller}
        currentUserId="u1"
        isOwner={false}
        canSend
        focusMessageId="m1"
      />,
    );
  });

  const bubble = renderer.root.findByProps({ testID: 'chat-message-m1' });
  expect(bubble.props.accessibilityState).toEqual({ selected: true });
  expect(bubble.props.style).toEqual(expect.arrayContaining([
    expect.objectContaining({ borderWidth: 2 }),
  ]));
  act(() => renderer.unmount());
});

it('clears the composer and sends one trimmed message', async () => {
  const controller = baseController();
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <TripChat header={null} controller={controller} currentUserId="u1" isOwner={false} canSend />,
    );
  });
  const input = renderer.root.findByType(TextInput);
  act(() => input.props.onChangeText('  Meet at reception  '));
  const send = renderer.root.findByProps({ testID: 'chat-send' });
  await act(async () => { await send.props.onPress(); });

  expect(controller.send).toHaveBeenCalledTimes(1);
  expect(controller.send).toHaveBeenCalledWith('Meet at reception');
  expect(renderer.root.findByType(TextInput).props.value).toBe('');
  act(() => renderer.unmount());
});

it('retains the draft when no durable local message could be created', async () => {
  const controller = baseController();
  (controller.send as jest.Mock).mockResolvedValue({
    created: false,
    sent: false,
    error: 'Could not preserve this message for retry.',
  });
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <TripChat header={null} controller={controller} currentUserId="u1" isOwner={false} canSend />,
    );
  });
  const input = renderer.root.findByType(TextInput);
  act(() => input.props.onChangeText('Keep this draft'));
  await act(async () => renderer.root.findByProps({ testID: 'chat-send' }).props.onPress());

  expect(renderer.root.findByType(TextInput).props.value).toBe('Keep this draft');
  expect(mockToastShow).toHaveBeenCalledWith('Could not preserve this message for retry.', 'error');
  act(() => renderer.unmount());
});

it('shows fatal configuration state and disables the composer', async () => {
  const controller = baseController();
  controller.connected = false;
  controller.connection = { status: 'unavailable', attempt: 0, reason: 'configuration' };
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <TripChat header={null} controller={controller} currentUserId="u1" isOwner={false} canSend />,
    );
  });

  expect(textContent(renderer)).toContain('Chat unavailable');
  expect(textContent(renderer)).toContain('connected server does not support');
  expect(renderer.root.findByType(TextInput).props.editable).toBe(false);
  expect(renderer.root.findAllByProps({ testID: 'chat-reconnect' })).toHaveLength(0);
  act(() => renderer.unmount());
});

it('keeps transient reconnects retryable without disabling new messages', async () => {
  const controller = baseController();
  controller.connected = false;
  controller.connection = { status: 'reconnecting', attempt: 2, reason: 'network' };
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <TripChat header={null} controller={controller} currentUserId="u1" isOwner={false} canSend />,
    );
  });

  expect(textContent(renderer)).toContain('Reconnecting');
  expect(renderer.root.findByType(TextInput).props.editable).toBe(true);
  act(() => renderer.root.findByProps({ testID: 'chat-reconnect' }).props.onPress());
  expect(controller.reconnect).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

it('retries the existing queued row instead of creating another message', async () => {
  const controller = baseController();
  const queued = {
    ...controller.messages[1],
    id: 'pending:c3',
    client_message_id: 'c3',
    sequence: Number.MAX_SAFE_INTEGER,
    delivery: 'queued' as const,
    failure: { code: 'offline' as const, retryable: true, message: 'Offline.' },
  };
  controller.messages = [...controller.messages, queued];
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <TripChat header={null} controller={controller} currentUserId="u1" isOwner={false} canSend />,
    );
  });

  const retry = renderer.root.findByProps({ accessibilityLabel: 'Retry sending message' });
  await act(async () => retry.props.onPress());
  expect(controller.retry).toHaveBeenCalledWith(queued);
  expect(controller.send).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
