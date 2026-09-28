/* eslint-disable import/first */
import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../api', () => ({
  chatSocketUrl: jest.fn((tripId: string) => `wss://chat.example.test/api/trips/${tripId}/chat/ws`),
  chatUnread: jest.fn(),
  clearChatHistory: jest.fn(),
  deleteChatMessage: jest.fn(),
  editChatMessage: jest.fn(),
  getToken: jest.fn(),
  listChatMessages: jest.fn(),
  markChatRead: jest.fn(),
  sendChatMessage: jest.fn(),
}));

jest.mock('../chatOutbox', () => ({
  ChatOutboxFullError: class ChatOutboxFullError extends Error {},
  enqueueChatOutbox: jest.fn(),
  loadChatOutbox: jest.fn(),
  removeChatOutboxMessage: jest.fn(),
  saveChatOutbox: jest.fn(),
}));

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn() },
}));

import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as chatApi from '../api';
import * as chatOutbox from '../chatOutbox';
import type { ChatMessage } from '../chat';
import { useTripChat, type TripChatController } from '../useTripChat';

type HookOptions = Parameters<typeof useTripChat>[0];
type NetState = { isConnected: boolean | null; isInternetReachable: boolean | null };

const emptyPage = {
  items: [],
  has_more_before: false,
  has_more_after: false,
  cleared_through_sequence: 0,
};

function savedMessage(clientId = 'uuid-1', overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `server:${clientId}`,
    client_message_id: clientId,
    trip_id: 't1',
    sequence: 1,
    sender_user_id: 'u1',
    sender_person_id: 'p1',
    sender_name: 'Ravi',
    sender_family_name: null,
    text: 'Meet in the lobby',
    created_at: '2026-08-22T10:00:00Z',
    edited_at: null,
    deleted_at: null,
    ...overrides,
  };
}

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = jest.fn();
  close = jest.fn((code = 1000) => {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  serverClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

let latest: TripChatController;
let renderer: ReactTestRenderer | null = null;
let netListener: ((state: NetState) => void) | null = null;
let appStateListener: ((state: string) => void) | null = null;
let netUnsubscribe: jest.Mock;
let appStateRemove: jest.Mock;
let originalWebSocket: typeof globalThis.WebSocket;
let appStateSpy: jest.SpyInstance;

function Harness({ options }: { options: HookOptions }) {
  latest = useTripChat(options);
  return null;
}

const defaultOptions = (overrides: Partial<HookOptions> = {}): HookOptions => ({
  tripId: 't1',
  userId: 'u1',
  sender: { name: 'Ravi' },
  active: true,
  capability: 'supported',
  ...overrides,
});

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(options = defaultOptions()): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(<Harness options={options} />);
  });
  await flushPromises();
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  originalWebSocket = globalThis.WebSocket;
  (globalThis as any).WebSocket = MockWebSocket;
  MockWebSocket.instances = [];
  netListener = null;
  appStateListener = null;
  netUnsubscribe = jest.fn();
  appStateRemove = jest.fn();

  (NetInfo.addEventListener as jest.Mock).mockImplementation((listener) => {
    netListener = listener;
    return netUnsubscribe;
  });
  appStateSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener: any) => {
    appStateListener = listener;
    return { remove: appStateRemove } as any;
  });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });

  (chatApi.chatSocketUrl as jest.Mock).mockImplementation(
    (tripId: string) => `wss://chat.example.test/api/trips/${tripId}/chat/ws`,
  );
  (chatApi.getToken as jest.Mock).mockResolvedValue('secret-token');
  (chatApi.listChatMessages as jest.Mock).mockResolvedValue(emptyPage);
  (chatApi.chatUnread as jest.Mock).mockResolvedValue({ count: 0, latest_sequence: 0 });
  (chatApi.markChatRead as jest.Mock).mockResolvedValue(undefined);
  (chatApi.sendChatMessage as jest.Mock).mockImplementation(
    (_tripId, body) => Promise.resolve(savedMessage(body.client_message_id, { text: body.text })),
  );
  (chatOutbox.loadChatOutbox as jest.Mock).mockResolvedValue([]);
  (chatOutbox.enqueueChatOutbox as jest.Mock).mockResolvedValue(undefined);
  (chatOutbox.saveChatOutbox as jest.Mock).mockResolvedValue(undefined);
  (chatOutbox.removeChatOutboxMessage as jest.Mock).mockResolvedValue(undefined);
  (Crypto.randomUUID as jest.Mock).mockReturnValue('uuid-1');
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  appStateSpy?.mockRestore();
  (globalThis as any).WebSocket = originalWebSocket;
});

it('authenticates, waits for ready, catches up, and displays recipient messages', async () => {
  await mount();
  const socket = MockWebSocket.instances[0];
  expect(socket.url).toBe('wss://chat.example.test/api/trips/t1/chat/ws');
  expect(socket.url).not.toContain('secret-token');
  expect(latest.connection.status).toBe('connecting');

  act(() => socket.open());
  expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'auth', token: 'secret-token' });
  act(() => socket.receive({ type: 'ready' }));
  await flushPromises();
  expect(latest.connection).toEqual({ status: 'connected', attempt: 0 });

  const incoming = savedMessage('from-friend', {
    id: 'friend-message',
    sender_user_id: 'u2',
    sender_person_id: 'p2',
    sender_name: 'Priya',
    sequence: 2,
    text: 'I am here',
  });
  act(() => socket.receive({ type: 'message.created', data: incoming }));
  await flushPromises();
  expect(latest.messages).toContainEqual(incoming);
  expect(chatApi.markChatRead).toHaveBeenCalledWith('t1', 2);
});

it('transitions offline and restores the authenticated trip subscription when connectivity returns', async () => {
  await mount(defaultOptions({ active: false }));
  const first = MockWebSocket.instances[0];
  act(() => first.open());
  act(() => first.receive({ type: 'ready' }));
  expect(latest.connection.status).toBe('connected');

  act(() => netListener?.({ isConnected: false, isInternetReachable: false }));
  expect(latest.connection.status).toBe('offline');
  expect(first.close).toHaveBeenCalled();

  act(() => netListener?.({ isConnected: true, isInternetReachable: true }));
  await flushPromises();
  const second = MockWebSocket.instances[1];
  expect(second).toBeTruthy();
  act(() => second.open());
  act(() => second.receive({ type: 'ready' }));
  await flushPromises();
  expect(latest.connection.status).toBe('connected');
  expect(chatApi.listChatMessages).toHaveBeenCalledWith('t1', { afterSequence: 0, limit: 100 });
});

it('uses bounded reconnect delay and exposes an accurate unavailable state after repeated failures', async () => {
  await mount(defaultOptions({ active: false }));

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => socket.serverClose(1006));
    expect(latest.connection.status).toBe(attempt >= 5 ? 'unavailable' : 'reconnecting');
    expect(latest.connection.attempt).toBe(attempt);
    if (attempt < 5) {
      const delay = [1000, 2000, 5000, 10_000][attempt - 1];
      act(() => jest.advanceTimersByTime(delay));
      await flushPromises();
    }
  }

  expect(MockWebSocket.instances).toHaveLength(5);
  act(() => latest.reconnect());
  await flushPromises();
  expect(MockWebSocket.instances).toHaveLength(6);
  expect(latest.connection.status).toBe('connecting');
});

it.each([
  [4401, 'authentication_required'],
  [4403, 'permission_denied'],
] as const)('stops reconnecting for fatal close code %s', async (closeCode, expectedStatus) => {
  const onAuthenticationRequired = jest.fn().mockResolvedValue(undefined);
  await mount(defaultOptions({ active: false, onAuthenticationRequired }));

  act(() => MockWebSocket.instances[0].serverClose(closeCode));
  await flushPromises();
  expect(latest.connection.status).toBe(expectedStatus);
  expect(onAuthenticationRequired).toHaveBeenCalledTimes(closeCode === 4401 ? 1 : 0);

  act(() => jest.advanceTimersByTime(120_000));
  await flushPromises();
  expect(MockWebSocket.instances).toHaveLength(1);
});

it('keeps its own broadcast pending until REST acknowledgement', async () => {
  let acknowledge!: (message: ChatMessage) => void;
  (chatApi.sendChatMessage as jest.Mock).mockImplementationOnce(
    () => new Promise<ChatMessage>((resolve) => { acknowledge = resolve; }),
  );
  await mount(defaultOptions({ active: false }));
  const socket = MockWebSocket.instances[0];
  act(() => socket.open());
  act(() => socket.receive({ type: 'ready' }));

  let sendPromise!: ReturnType<TripChatController['send']>;
  await act(async () => {
    sendPromise = latest.send('Meet in the lobby');
    await Promise.resolve();
  });
  expect(latest.messages[0].delivery).toBe('sending');

  act(() => socket.receive({ type: 'message.created', data: savedMessage() }));
  expect(latest.messages).toHaveLength(1);
  expect(latest.messages[0].delivery).toBe('sending');

  await act(async () => {
    acknowledge(savedMessage());
    await sendPromise;
  });
  expect(latest.messages).toEqual([savedMessage()]);
  expect(chatOutbox.removeChatOutboxMessage).toHaveBeenCalledWith('u1', 't1', 'uuid-1');
});

it('retries one stable client message ID and coalesces concurrent retry taps', async () => {
  (chatApi.sendChatMessage as jest.Mock).mockRejectedValueOnce({ code: 'network' });
  await mount(defaultOptions({ active: false }));

  await act(async () => {
    expect(await latest.send('  Meet in the lobby  ')).toMatchObject({ created: true, sent: false });
  });
  expect(latest.messages).toHaveLength(1);
  expect(latest.messages[0]).toMatchObject({ client_message_id: 'uuid-1', delivery: 'failed' });

  let acknowledge!: (message: ChatMessage) => void;
  (chatApi.sendChatMessage as jest.Mock).mockImplementationOnce(
    () => new Promise<ChatMessage>((resolve) => { acknowledge = resolve; }),
  );
  const failed = latest.messages[0];
  let firstRetry!: Promise<boolean>;
  let secondRetry!: Promise<boolean>;
  act(() => {
    firstRetry = latest.retry(failed);
    secondRetry = latest.retry(failed);
  });
  await flushPromises();
  expect(chatApi.sendChatMessage).toHaveBeenCalledTimes(2);

  await act(async () => {
    acknowledge(savedMessage());
    expect(await Promise.all([firstRetry, secondRetry])).toEqual([true, true]);
  });
  expect((chatApi.sendChatMessage as jest.Mock).mock.calls.map((call) => call[1].client_message_id))
    .toEqual(['uuid-1', 'uuid-1']);
  expect(latest.messages).toEqual([savedMessage()]);
});

it('closes listeners in the background and on unmount without duplicating them', async () => {
  await mount(defaultOptions({ active: false }));
  const first = MockWebSocket.instances[0];
  act(() => first.open());
  act(() => first.receive({ type: 'ready' }));

  act(() => appStateListener?.('background'));
  expect(first.close).toHaveBeenCalled();
  act(() => appStateListener?.('active'));
  await flushPromises();
  expect(MockWebSocket.instances).toHaveLength(2);

  act(() => renderer?.unmount());
  renderer = null;
  expect(netUnsubscribe).toHaveBeenCalledTimes(1);
  expect(appStateRemove).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(120_000));
  await flushPromises();
  expect(MockWebSocket.instances).toHaveLength(2);
});
